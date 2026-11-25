// POST /setores/:slug/encaminhamentos: chamado pelo n8n depois do roteamento.
// Valida, executa o tratamento do setor, grava o encaminhamento e atualiza o ticket.
// Idempotente: um encaminhamento por ticket (ticket_id unique).
import { Router } from "express";
import { z } from "zod";
import { emTransacao, query } from "../db.js";
import { CATEGORIAS } from "../dominio.js";
import { publicarEvento, registrarEvento } from "../eventos.js";
import { filtrarDadosPorCategoria } from "../ia/schemas.js";
import { ErroHttp, exigirChaveInterna, idSchema, validarCorpo } from "../middlewares.js";
import { TRATAMENTOS } from "../setores/tratamentos.js";

export const rotasSetores = Router();

const TRIAGEM = "triagem-manual";

const corpoSchema = z.object({
  ticket_id: idSchema,
  classificacao: z.looseObject({ categoria: z.enum(CATEGORIAS) }),
  roteado_por: z.string().max(50).optional(),
  execucao_n8n: z.union([z.string(), z.number()]).transform(String).optional(),
});

async function buscarEncaminhamento(ticketId, db = { query }) {
  const { rows } = await db.query(
    `SELECT e.ticket_id, t.protocolo, e.setor_slug AS setor, t.status, e.resultado, e.criado_em
       FROM encaminhamentos e JOIN tickets t ON t.id = e.ticket_id
      WHERE e.ticket_id = $1`,
    [ticketId],
  );
  return rows[0];
}

rotasSetores.post("/:slug/encaminhamentos", exigirChaveInterna, async (req, res) => {
  const { slug } = req.params;
  const corpo = validarCorpo(corpoSchema, req.body);
  const log = (msg) => console.log(`[setor:${slug}] ${msg}`);

  const setor = (await query(`SELECT slug, nome, sla_horas FROM setores WHERE slug = $1`, [slug])).rows[0];
  if (!setor || !TRATAMENTOS[slug]) throw new ErroHttp(404, `Setor não encontrado: ${slug}`);

  const ticket = (await query(`SELECT * FROM tickets WHERE id = $1`, [corpo.ticket_id])).rows[0];
  if (!ticket) throw new ErroHttp(404, "Ticket não encontrado.");

  // Reexecução do n8n: devolve o encaminhamento já registrado, sem duplicar.
  const existente = await buscarEncaminhamento(ticket.id);
  if (existente) {
    log(`${ticket.protocolo}: já encaminhado para ${existente.setor}, devolvendo o registro existente`);
    return res.status(200).json({ ...existente, idempotente: true });
  }

  // Defesa em profundidade: o n8n é um intermediário; o banco é a fonte da verdade.
  if (ticket.status !== "classificado") {
    throw new ErroHttp(409, `Ticket com status "${ticket.status}" não pode ser encaminhado.`);
  }
  if (corpo.classificacao.categoria !== ticket.categoria) {
    throw new ErroHttp(409, "A categoria recebida não confere com a classificação salva.", {
      recebida: corpo.classificacao.categoria,
      salva: ticket.categoria,
    });
  }
  if (slug !== TRIAGEM) {
    if (slug !== ticket.setor_slug) {
      throw new ErroHttp(409, `Setor "${slug}" não corresponde à categoria "${ticket.categoria}".`, {
        setor_esperado: ticket.setor_slug,
      });
    }
    if (ticket.requer_humano) {
      throw new ErroHttp(409, "Este ticket requer análise humana e deve ir para a triagem manual.");
    }
  }

  // Revalida os dados da categoria antes de usá-los.
  ticket.dados_extraidos = filtrarDadosPorCategoria(ticket.categoria, ticket.dados_extraidos).dados;

  const resultado = await emTransacao(async (db) => {
    const especifico = await TRATAMENTOS[slug](ticket, { db });
    const resultadoCompleto = {
      ...especifico,
      setor: slug,
      sla_horas: setor.sla_horas,
      prazo_resposta: new Date(Date.now() + setor.sla_horas * 3_600_000).toISOString(),
    };

    const inserido = await db.query(
      `INSERT INTO encaminhamentos (ticket_id, setor_slug, payload, resultado)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (ticket_id) DO NOTHING
       RETURNING criado_em`,
      [ticket.id, slug, corpo, resultadoCompleto],
    );
    if (inserido.rowCount === 0) return null; // chamada concorrente chegou antes

    const novoStatus = slug === TRIAGEM ? "triagem_manual" : "encaminhado";
    await db.query(
      `UPDATE tickets SET status = $2, setor_slug = $3, encaminhado_em = now() WHERE id = $1`,
      [ticket.id, novoStatus, slug],
    );

    const eventos = [
      await registrarEvento({
        ticketId: ticket.id,
        etapa: "roteado",
        detalhe: { setor: slug, roteado_por: corpo.roteado_por ?? null, execucao_n8n: corpo.execucao_n8n ?? null },
        cliente: db,
      }),
      await registrarEvento({
        ticketId: ticket.id,
        etapa: "encaminhado",
        status: slug === TRIAGEM ? "aviso" : "ok",
        detalhe: resultadoCompleto,
        cliente: db,
      }),
    ];
    return { status: novoStatus, resultado: resultadoCompleto, eventos };
  });

  if (!resultado) {
    const registro = await buscarEncaminhamento(ticket.id);
    return res.status(200).json({ ...registro, idempotente: true });
  }
  resultado.eventos.forEach(publicarEvento);

  log(`${ticket.protocolo}: ${resultado.status} (${ticket.categoria}/${ticket.prioridade}) ${JSON.stringify(resultado.resultado)}`);
  res.status(201).json({
    ticket_id: ticket.id,
    protocolo: ticket.protocolo,
    setor: slug,
    status: resultado.status,
    resultado: resultado.resultado,
  });
});
