// Rotas públicas do "Fale conosco": criação e consulta de tickets.
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db.js";
import { CATEGORIAS, PRIORIDADES } from "../dominio.js";
import { registrarEvento } from "../eventos.js";
import { ErroHttp, idSchema, limitarEnvios, validarCorpo } from "../middlewares.js";

export const rotasTickets = Router();

const novoTicketSchema = z.object({
  nome: z.string().trim().min(2, "informe o nome (mínimo 2 caracteres)").max(120),
  email: z.email("e-mail inválido").max(200),
  // Opcional. Aceita "0012 3456-7890" e guarda só os dígitos; vazio vira null.
  numero_carteirinha: z.preprocess(
    (v) => (typeof v === "string" ? v.replace(/[\s.\-/]/g, "") || null : v),
    z.string().regex(/^\d{8,20}$/, "a carteirinha deve ter de 8 a 20 dígitos").nullish(),
  ),
  mensagem: z
    .string()
    .trim()
    .min(10, "a mensagem deve ter pelo menos 10 caracteres")
    .max(2000, "a mensagem deve ter no máximo 2000 caracteres"),
});

const COLUNAS_PUBLICAS = `
  t.id, t.protocolo, t.status, t.nome, t.email, t.numero_carteirinha, t.mensagem,
  t.categoria, t.prioridade, t.sentimento, t.resumo, t.justificativa, t.dados_extraidos,
  t.confianca, t.requer_humano, t.suspeita_manipulacao, t.fallback_ia, t.modelo_ia, t.tentativas_ia,
  t.setor_slug, s.nome AS setor_nome,
  t.criado_em, t.classificado_em, t.encaminhado_em, t.atualizado_em`;

// Aciona o fluxo do n8n. O n8n responde imediatamente; a classificação acontece em segundo plano.
async function acionarAutomacao(ticket) {
  try {
    const resposta = await fetch(config.n8nWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": config.internalApiKey },
      body: JSON.stringify({ ticket_id: ticket.id, protocolo: ticket.protocolo }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resposta.ok) return { ok: false, detalhe: { http_status: resposta.status } };
    return { ok: true, detalhe: { http_status: resposta.status } };
  } catch (erro) {
    return { ok: false, detalhe: { erro: erro.name === "TimeoutError" ? "tempo esgotado" : erro.message } };
  }
}

// POST /tickets: recebe a mensagem, salva e aciona o n8n.
rotasTickets.post("/", limitarEnvios, async (req, res) => {
  const entrada = validarCorpo(novoTicketSchema, req.body);

  const { rows } = await query(
    `INSERT INTO tickets (nome, email, numero_carteirinha, mensagem)
     VALUES ($1, $2, $3, $4)
     RETURNING id, protocolo, status, criado_em`,
    [entrada.nome, entrada.email, entrada.numero_carteirinha ?? null, entrada.mensagem],
  );
  const ticket = rows[0];

  // Sem e-mail nem texto completos no evento: só o necessário para a timeline.
  await registrarEvento({
    ticketId: ticket.id,
    etapa: "recebido",
    detalhe: { tem_carteirinha: Boolean(entrada.numero_carteirinha), tamanho_mensagem: entrada.mensagem.length },
  });
  await registrarEvento({ ticketId: ticket.id, etapa: "salvo", detalhe: { protocolo: ticket.protocolo } });

  const automacao = await acionarAutomacao(ticket);
  await registrarEvento({
    ticketId: ticket.id,
    etapa: "enviado_automacao",
    status: automacao.ok ? "ok" : "erro",
    detalhe: automacao.detalhe,
  });

  if (!automacao.ok) {
    await query(`UPDATE tickets SET status = 'erro' WHERE id = $1`, [ticket.id]);
    ticket.status = "erro";
    console.warn(`[tickets] ${ticket.protocolo}: falha ao acionar o n8n`, automacao.detalhe);
  } else {
    console.log(`[tickets] ${ticket.protocolo}: recebido e enviado à automação`);
  }

  res.status(201).json({
    id: ticket.id,
    protocolo: ticket.protocolo,
    status: ticket.status,
    criado_em: ticket.criado_em,
    mensagem:
      ticket.status === "erro"
        ? "Recebemos sua mensagem, mas a triagem automática está indisponível. Ela será analisada pela equipe."
        : "Recebemos sua mensagem. Guarde o número de protocolo.",
  });
});

// GET /tickets: listagem com filtros simples.
const filtrosSchema = z.object({
  status: z.enum(["recebido", "classificado", "encaminhado", "triagem_manual", "erro"]).optional(),
  categoria: z.enum(CATEGORIAS).optional(),
  prioridade: z.enum(PRIORIDADES).optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
});

rotasTickets.get("/", async (req, res) => {
  const filtros = filtrosSchema.safeParse(req.query);
  if (!filtros.success) throw new ErroHttp(400, "Filtros inválidos.");
  const { status, categoria, prioridade, limite } = filtros.data;

  const { rows } = await query(
    `SELECT ${COLUNAS_PUBLICAS}
       FROM tickets t
       LEFT JOIN setores s ON s.slug = t.setor_slug
      WHERE ($1::text IS NULL OR t.status = $1)
        AND ($2::text IS NULL OR t.categoria = $2)
        AND ($3::text IS NULL OR t.prioridade = $3)
      ORDER BY t.criado_em DESC
      LIMIT $4`,
    [status ?? null, categoria ?? null, prioridade ?? null, limite],
  );
  res.json({ total: rows.length, tickets: rows });
});

// GET /tickets/:id: detalhe com encaminhamento e linha do tempo.
rotasTickets.get("/:id", async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) throw new ErroHttp(400, "Id inválido.");

  const { rows } = await query(
    `SELECT ${COLUNAS_PUBLICAS}
       FROM tickets t LEFT JOIN setores s ON s.slug = t.setor_slug
      WHERE t.id = $1`,
    [id.data],
  );
  if (rows.length === 0) throw new ErroHttp(404, "Ticket não encontrado.");

  const [encaminhamento, eventos] = await Promise.all([
    query(`SELECT setor_slug, resultado, criado_em FROM encaminhamentos WHERE ticket_id = $1`, [id.data]),
    query(`SELECT id, etapa, status, detalhe, criado_em FROM ticket_events WHERE ticket_id = $1 ORDER BY id`, [
      id.data,
    ]),
  ]);

  res.json({ ...rows[0], encaminhamento: encaminhamento.rows[0] ?? null, eventos: eventos.rows });
});
