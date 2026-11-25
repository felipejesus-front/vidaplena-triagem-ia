// Única porta de saída para o Gemini. A chave fica só aqui e nunca vai para logs, respostas ou eventos.
import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import { RESPONSE_SCHEMA } from "./schemas.js";
import { SYSTEM_INSTRUCTION } from "./prompt.js";

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

export class ErroGemini extends Error {
  constructor(mensagem, status, { transitorio = false } = {}) {
    super(mensagem);
    this.name = "ErroGemini";
    this.status = status;
    this.transitorio = transitorio; // vale a pena tentar de novo (5xx, timeout)
  }
}

// O SDK costuma pôr o JSON de erro da API na mensagem; extrai só o texto legível.
// Também garante que a chave nunca vaze numa mensagem de erro repassada adiante.
function semSegredo(texto) {
  let legivel = String(texto ?? "");
  try {
    legivel = JSON.parse(legivel)?.error?.message ?? legivel;
  } catch {
    // não era JSON; usa o texto como veio
  }
  return legivel.split(config.gemini.apiKey).join("[chave omitida]").slice(0, 300);
}

/**
 * Envia a mensagem do usuário e devolve o texto bruto da resposta (JSON em string).
 * Sem retryOptions, o SDK faz uma única chamada; as novas tentativas são controladas pelo classificador.
 */
export async function gerarClassificacao(mensagemUsuario) {
  try {
    const resposta = await ai.models.generateContent({
      model: config.gemini.modelo,
      contents: mensagemUsuario,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.1,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        httpOptions: { timeout: config.gemini.timeoutMs },
      },
    });
    const texto = resposta.text;
    if (!texto) {
      const motivo = resposta.candidates?.[0]?.finishReason ?? resposta.promptFeedback?.blockReason ?? "desconhecido";
      throw new ErroGemini(`Resposta vazia do Gemini (motivo: ${motivo})`, 502);
    }
    return texto;
  } catch (erro) {
    if (erro instanceof ErroGemini) throw erro;
    const status = typeof erro?.status === "number" ? erro.status : undefined;
    const timeout = erro?.name === "AbortError" || /timeout|aborted/i.test(erro?.message ?? "");
    const tipo =
      status === 429
        ? "cota do Gemini excedida"
        : status >= 500
          ? "Gemini indisponível"
          : status === 400 || status === 401 || status === 403
            ? "requisição recusada pelo Gemini (chave ou modelo inválido?)"
            : timeout
              ? "tempo esgotado na chamada ao Gemini"
              : "falha ao chamar o Gemini";
    throw new ErroGemini(`${tipo}: ${semSegredo(erro?.message)}`, status, {
      transitorio: status >= 500 || timeout,
    });
  }
}
