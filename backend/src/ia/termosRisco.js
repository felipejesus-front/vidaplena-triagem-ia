// Rede de segurança contra urgência perdida (docs/prompt-e-validacao.md, seção 5.4).
// Lista propositalmente simples e explicável; os termos estão sem acento e em minúsculas.
import { normalizarTexto } from "../dominio.js";

export const TERMOS_RISCO = [
  "dor no peito",
  "falta de ar",
  "sem ar",
  "desmaio",
  "desmaiou",
  "desmaiando",
  "convulsao",
  "convulsionando",
  "sangramento",
  "sangrando muito",
  "infarto",
  "avc",
  "derrame",
  "inconsciente",
  "desacordado",
  "desacordada",
  "overdose",
  "suicidio",
  "me matar",
  "se matar",
];

const PADROES = TERMOS_RISCO.map((termo) => ({
  termo,
  regex: new RegExp(`\\b${termo.replace(/\s+/g, "\\s+")}\\b`, "u"),
}));

/** Devolve os termos de risco encontrados na mensagem original (comparação sem acento). */
export function encontrarTermosRisco(mensagem) {
  const normalizada = normalizarTexto(mensagem);
  return PADROES.filter(({ regex }) => regex.test(normalizada)).map(({ termo }) => termo);
}
