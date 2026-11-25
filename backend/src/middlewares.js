import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { descreverErroZod } from "./ia/schemas.js";

export class ErroHttp extends Error {
  constructor(status, mensagem, detalhes) {
    super(mensagem);
    this.status = status;
    this.detalhes = detalhes;
  }
}

// Valida o corpo com um schema Zod; em caso de erro, responde 400 com a lista de problemas.
export function validarCorpo(schema, corpo) {
  const resultado = schema.safeParse(corpo ?? {});
  if (!resultado.success) {
    throw new ErroHttp(400, "Dados inválidos.", descreverErroZod(resultado.error));
  }
  return resultado.data;
}

export const idSchema = z.coerce.number().int().positive();

// ---------------------------------------------------------------------------
// Autenticação interna (rotas chamadas pelo n8n): header X-Api-Key = INTERNAL_API_KEY.
// Compara os hashes, que têm tamanho fixo, em tempo constante.
// ---------------------------------------------------------------------------
const hashChave = createHash("sha256").update(config.internalApiKey).digest();

export function exigirChaveInterna(req, res, next) {
  const recebida = req.get("x-api-key") ?? "";
  const hashRecebida = createHash("sha256").update(recebida).digest();
  if (!recebida || !timingSafeEqual(hashRecebida, hashChave)) {
    return res.status(401).json({ erro: "Não autorizado: X-Api-Key ausente ou inválida." });
  }
  next();
}

// ---------------------------------------------------------------------------
// Limite de envios por IP (em memória; uma instância de backend basta para o projeto).
// ---------------------------------------------------------------------------
const JANELA_MS = 60_000;
const contagens = new Map();

export function limitarEnvios(req, res, next) {
  const agora = Date.now();
  const ip = req.ip ?? "desconhecido";
  const atual = contagens.get(ip);
  if (!atual || agora - atual.inicio >= JANELA_MS) {
    contagens.set(ip, { inicio: agora, total: 1 });
    return next();
  }
  atual.total += 1;
  if (atual.total > config.limiteTicketsPorMinuto) {
    const segundos = Math.ceil((atual.inicio + JANELA_MS - agora) / 1000);
    res.set("Retry-After", String(segundos));
    return res.status(429).json({ erro: `Muitas mensagens em pouco tempo. Tente novamente em ${segundos} s.` });
  }
  next();
}

setInterval(() => {
  const agora = Date.now();
  for (const [ip, { inicio }] of contagens) if (agora - inicio >= JANELA_MS) contagens.delete(ip);
}, JANELA_MS).unref();

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------
export function rotaNaoEncontrada(req, res) {
  res.status(404).json({ erro: `Rota não encontrada: ${req.method} ${req.path}` });
}

// eslint-disable-next-line no-unused-vars
export function tratarErros(erro, req, res, next) {
  if (erro instanceof ErroHttp) {
    return res.status(erro.status).json({ erro: erro.message, ...(erro.detalhes && { detalhes: erro.detalhes }) });
  }
  if (erro?.type === "entity.parse.failed") {
    return res.status(400).json({ erro: "JSON inválido no corpo da requisição." });
  }
  if (erro?.type === "entity.too.large") {
    return res.status(413).json({ erro: "Corpo da requisição grande demais." });
  }
  console.error(`[erro] ${req.method} ${req.path}:`, erro);
  res.status(500).json({ erro: "Erro interno no servidor." });
}
