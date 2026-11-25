import pg from "pg";
import { config } from "./config.js";

// Retorna "numeric" como número (confianca, valores), em vez de string.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (valor) => Number.parseFloat(valor));

export const pool = new pg.Pool({
  password: config.pgPassword,
  max: 10,
});

pool.on("error", (erro) => {
  console.error("[db] erro em conexão ociosa:", erro.message);
});

export const query = (texto, params) => pool.query(texto, params);

// Executa fn dentro de uma transação; faz rollback se fn lançar erro.
export async function emTransacao(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    const resultado = await fn(cliente);
    await cliente.query("COMMIT");
    return resultado;
  } catch (erro) {
    await cliente.query("ROLLBACK");
    throw erro;
  } finally {
    cliente.release();
  }
}
