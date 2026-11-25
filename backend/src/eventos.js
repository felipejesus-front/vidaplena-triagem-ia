// Linha do tempo do ticket (tabela ticket_events).
// Cada evento gravado também é publicado num EventEmitter em memória, que o SSE do Marco 2 vai assinar.
import { EventEmitter } from "node:events";
import { pool } from "./db.js";

export const barramentoEventos = new EventEmitter();
barramentoEventos.setMaxListeners(0);

/**
 * Grava um evento. Nunca coloque em "detalhe" chaves, segredos ou headers de autenticação.
 * @param {object} params
 * @param {number} params.ticketId
 * @param {string} params.etapa   uma das etapas do CHECK da tabela
 * @param {"ok"|"aviso"|"erro"} [params.status]
 * @param {object} [params.detalhe]
 * @param {import("pg").PoolClient} [params.cliente]  para gravar dentro de uma transação
 */
export async function registrarEvento({ ticketId, etapa, status = "ok", detalhe = {}, cliente = pool }) {
  const { rows } = await cliente.query(
    `INSERT INTO ticket_events (ticket_id, etapa, status, detalhe)
     VALUES ($1, $2, $3, $4)
     RETURNING id, ticket_id, etapa, status, detalhe, criado_em`,
    [ticketId, etapa, status, detalhe],
  );
  const evento = rows[0];
  // Dentro de transação, o evento só deveria ser publicado após o COMMIT; quem usa "cliente"
  // recebe o evento de volta e publica com publicarEvento() depois de confirmar.
  if (cliente === pool) publicarEvento(evento);
  return evento;
}

export function publicarEvento(evento) {
  barramentoEventos.emit("evento", evento);
}
