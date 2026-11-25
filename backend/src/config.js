// Configuração lida do ambiente. Falha cedo, com mensagem clara, se faltar algo obrigatório.
// Segredos podem vir direto (VAR) ou de um arquivo (VAR_FILE), que é como o docker-compose os entrega.
import { readFileSync } from "node:fs";

function lerSegredo(nome, { obrigatorio = true } = {}) {
  const arquivo = process.env[`${nome}_FILE`];
  if (arquivo) {
    try {
      return readFileSync(arquivo, "utf8").trim();
    } catch (erro) {
      throw new Error(`Não foi possível ler ${nome}_FILE (${arquivo}): ${erro.message}`);
    }
  }
  const valor = process.env[nome]?.trim();
  if (!valor && obrigatorio) {
    throw new Error(`Variável de ambiente ${nome} (ou ${nome}_FILE) não definida.`);
  }
  return valor || undefined;
}

function lerInteiro(nome, padrao) {
  const bruto = process.env[nome];
  if (bruto === undefined || bruto === "") return padrao;
  const valor = Number.parseInt(bruto, 10);
  if (!Number.isInteger(valor) || valor < 1) {
    throw new Error(`Variável de ambiente ${nome} deve ser um inteiro positivo (recebido: "${bruto}").`);
  }
  return valor;
}

export const config = Object.freeze({
  porta: lerInteiro("PORT", 3000),

  gemini: {
    apiKey: lerSegredo("GEMINI_API_KEY"),
    modelo: process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite",
    maxTentativas: lerInteiro("IA_MAX_TENTATIVAS", 2),
    timeoutMs: lerInteiro("IA_TIMEOUT_MS", 20000),
  },

  // As demais variáveis PG* (PGHOST, PGUSER...) são lidas pelo próprio driver "pg".
  pgPassword: lerSegredo("PGPASSWORD"),

  internalApiKey: lerSegredo("INTERNAL_API_KEY"),
  n8nWebhookUrl: process.env.N8N_WEBHOOK_URL?.trim() || "http://n8n:5678/webhook/novo-ticket",

  // Limite simples do formulário público, para proteger a cota do Gemini.
  limiteTicketsPorMinuto: lerInteiro("LIMITE_TICKETS_POR_MINUTO", 10),
});
