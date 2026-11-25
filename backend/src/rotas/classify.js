// POST /classify: chamado pelo n8n. Busca a mensagem no banco, classifica com a IA e salva.
// Idempotente: ticket já classificado devolve a classificação salva, sem chamar a IA.
import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { registrarEvento } from "../eventos.js";
import { classificarMensagem } from "../ia/classificador.js";
import { ErroHttp, exigirChaveInterna, idSchema, validarCorpo } from "../middlewares.js";

export const rotasClassify = Router();

const corpoSchema = z.object({ ticket_id: idSchema });

const STATUS_JA_CLASSIFICADO = ["classificado", "encaminhado", "triagem_manual"];

function montarResposta(t, meta) {
  return {
    ticket_id: t.id,
    protocolo: t.protocolo,
    classificacao: {
      categoria: t.categoria,
      prioridade: t.prioridade,
      sentimento: t.sentimento,
      resumo: t.resumo,
      dados_extraidos: t.dados_extraidos,
      confianca: t.confianca,
      requer_humano: t.requer_humano,
      suspeita_manipulacao: t.suspeita_manipulacao,
      justificativa: t.justificativa,
    },
    setor: { slug: t.setor_slug, nome: t.setor_nome },
    meta,
  };
}

async function buscarTicket(id) {
  const { rows } = await query(
    `SELECT t.*, s.nome AS setor_nome FROM tickets t LEFT JOIN setores s ON s.slug = t.setor_slug WHERE t.id = $1`,
    [id],
  );
  return rows[0];
}

rotasClassify.post("/", exigirChaveInterna, async (req, res) => {
  const { ticket_id: ticketId } = validarCorpo(corpoSchema, req.body);

  const ticket = await buscarTicket(ticketId);
  if (!ticket) throw new ErroHttp(404, "Ticket não encontrado.");

  if (STATUS_JA_CLASSIFICADO.includes(ticket.status)) {
    console.log(`[classify] ${ticket.protocolo}: já classificado, devolvendo a classificação salva`);
    return res.json(
      montarResposta(ticket, {
        modelo: ticket.modelo_ia,
        tentativas: ticket.tentativas_ia,
        fallback: ticket.fallback_ia,
        avisos: [],
        idempotente: true,
      }),
    );
  }

  // Só o texto da mensagem vai para a IA (LGPD: nome, e-mail e carteirinha ficam aqui).
  const { classificacao: c, meta } = await classificarMensagem(ticket.mensagem, {
    aoEvento: (etapa, status, detalhe) => registrarEvento({ ticketId, etapa, status, detalhe }),
  });

  // Setor derivado da categoria pela tabela setores (a IA não escolhe o setor).
  // O WHERE no status evita sobrescrever se uma chamada concorrente (retry do n8n) já tiver salvo.
  const { rowCount } = await query(
    `UPDATE tickets t
        SET status = 'classificado',
            categoria = $2, prioridade = $3, sentimento = $4, resumo = $5, justificativa = $6,
            dados_extraidos = $7, confianca = $8, requer_humano = $9, suspeita_manipulacao = $10,
            setor_slug = s.slug, modelo_ia = $11, tentativas_ia = $12, fallback_ia = $13,
            classificado_em = now()
       FROM setores s
      WHERE t.id = $1 AND s.categoria = $2 AND t.status IN ('recebido', 'erro')`,
    [
      ticketId,
      c.categoria,
      c.prioridade,
      c.sentimento,
      c.resumo,
      c.justificativa,
      c.dados_extraidos,
      c.confianca,
      c.requer_humano,
      c.suspeita_manipulacao,
      meta.modelo,
      meta.tentativas,
      meta.fallback,
    ],
  );

  const salvo = await buscarTicket(ticketId);
  if (rowCount === 0) {
    // Outra chamada classificou primeiro: devolve o que está salvo, para o n8n seguir com dados coerentes.
    console.log(`[classify] ${ticket.protocolo}: classificado por outra chamada concorrente`);
    return res.json(montarResposta(salvo, { ...meta, idempotente: true }));
  }

  await registrarEvento({
    ticketId,
    etapa: "classificado",
    status: c.requer_humano || meta.fallback ? "aviso" : "ok",
    detalhe: {
      categoria: c.categoria,
      prioridade: c.prioridade,
      confianca: c.confianca,
      requer_humano: c.requer_humano,
      suspeita_manipulacao: c.suspeita_manipulacao,
      setor: salvo.setor_slug,
      fallback: meta.fallback,
    },
  });

  console.log(
    `[classify] ${ticket.protocolo}: ${c.categoria} / ${c.prioridade} / confiança ${c.confianca}` +
      ` (tentativas: ${meta.tentativas}${meta.fallback ? ", FALLBACK" : ""}${meta.avisos.length ? `, avisos: ${meta.avisos.length}` : ""})`,
  );
  res.json(montarResposta(salvo, meta));
});
