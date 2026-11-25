// Pipeline de classificação: Gemini → JSON → Zod → regras de negócio → dados por categoria → rede de segurança.
// Nunca lança erro por causa da IA: qualquer falha termina no fallback (triagem manual).
// Especificação: docs/prompt-e-validacao.md, seção 5.
import { config } from "../config.js";
import { ErroGemini, gerarClassificacao } from "./gemini.js";
import { montarMensagemUsuario } from "./prompt.js";
import { descreverErroZod, filtrarDadosPorCategoria, respostaIaSchema } from "./schemas.js";
import { encontrarTermosRisco } from "./termosRisco.js";

const ESPERA_ERRO_TRANSITORIO_MS = 2000;

export const CLASSIFICACAO_FALLBACK = Object.freeze({
  justificativa: "Fallback do sistema.",
  categoria: "outros",
  prioridade: "media",
  sentimento: "neutro",
  resumo: "Classificação automática indisponível; encaminhado para triagem manual.",
  dados_extraidos: {},
  confianca: 0,
  requer_humano: true,
  suspeita_manipulacao: false,
});

/** Etapa 3: regras de negócio. Corrige de forma determinística e devolve os avisos. */
function aplicarRegrasDeNegocio(c) {
  const avisos = [];
  if (c.categoria === "urgencia_assistencial" && c.prioridade !== "urgente") {
    avisos.push(`prioridade "${c.prioridade}" corrigida para "urgente" (categoria de urgência)`);
    c.prioridade = "urgente";
  }
  if (c.prioridade === "urgente" && c.categoria !== "urgencia_assistencial") {
    avisos.push(`prioridade "urgente" rebaixada para "alta" (categoria ${c.categoria}); requer humano`);
    c.prioridade = "alta";
    c.requer_humano = true;
  }
  if (c.categoria === "outros" && !c.requer_humano) {
    avisos.push("categoria outros: requer_humano forçado");
    c.requer_humano = true;
  }
  if (c.suspeita_manipulacao && !c.requer_humano) {
    avisos.push("suspeita de manipulação: requer_humano forçado");
    c.requer_humano = true;
  }
  return avisos;
}

/** Etapa 5: termos de risco na mensagem original, sem urgência detectada pela IA. */
function aplicarRedeDeSeguranca(c, mensagem) {
  if (c.categoria === "urgencia_assistencial") return [];
  const termos = encontrarTermosRisco(mensagem);
  if (termos.length === 0) return [];
  c.requer_humano = true;
  return [`possivel_urgencia_nao_detectada: termos de risco encontrados (${termos.join(", ")})`];
}

function tentarParse(texto) {
  try {
    return { ok: true, valor: JSON.parse(texto) };
  } catch (erro) {
    return { ok: false, erro: `JSON inválido (${erro.message})` };
  }
}

/**
 * Classifica uma mensagem.
 * @param {string} mensagem  só o texto do cliente (minimização de dados)
 * @param {object} opcoes
 * @param {(etapa: string, status: string, detalhe: object) => Promise<void>} opcoes.aoEvento
 * @returns {Promise<{ classificacao: object, meta: { modelo, tentativas, fallback, motivo_fallback?, avisos } }>}
 */
export async function classificarMensagem(mensagem, { aoEvento = async () => {} } = {}) {
  const modelo = config.gemini.modelo;
  const maxTentativas = config.gemini.maxTentativas;
  let feedback;
  let motivoFallback;
  let tentativa = 0;

  while (tentativa < maxTentativas) {
    tentativa += 1;
    await aoEvento("ia_solicitada", "ok", { modelo, tentativa });

    let textoBruto;
    try {
      textoBruto = await gerarClassificacao(montarMensagemUsuario(mensagem, feedback));
    } catch (erro) {
      motivoFallback = erro instanceof ErroGemini ? erro.message : "erro inesperado ao chamar a IA";
      if (!(erro instanceof ErroGemini)) console.error("[ia] erro inesperado:", erro);
      await aoEvento("ia_respondeu", "erro", { tentativa, erro: motivoFallback });

      // 5xx e timeout costumam ser passageiros (ex.: 503 "high demand"): usa a tentativa restante após uma pausa.
      // 429 (cota) e 4xx (chave/modelo inválido) não melhoram repetindo: vai direto para o fallback.
      if (erro instanceof ErroGemini && erro.transitorio && tentativa < maxTentativas) {
        feedback = undefined;
        await aoEvento("ia_nova_tentativa", "aviso", { proxima_tentativa: tentativa + 1, erro: motivoFallback });
        await new Promise((resolver) => setTimeout(resolver, ESPERA_ERRO_TRANSITORIO_MS));
        continue;
      }
      break;
    }

    const parse = tentarParse(textoBruto);
    await aoEvento("ia_respondeu", parse.ok ? "ok" : "erro", {
      tentativa,
      resposta: parse.ok ? parse.valor : textoBruto.slice(0, 2000),
    });

    let erroValidacao;
    let classificacao;
    if (!parse.ok) {
      erroValidacao = parse.erro;
    } else {
      const forma = respostaIaSchema.safeParse(parse.valor);
      if (forma.success) classificacao = forma.data;
      else erroValidacao = descreverErroZod(forma.error);
    }

    if (classificacao) {
      const avisos = aplicarRegrasDeNegocio(classificacao);
      const { dados, avisos: avisosDados } = filtrarDadosPorCategoria(
        classificacao.categoria,
        classificacao.dados_extraidos,
      );
      classificacao.dados_extraidos = dados;
      avisos.push(...avisosDados, ...aplicarRedeDeSeguranca(classificacao, mensagem));

      await aoEvento("validacao", avisos.length ? "aviso" : "ok", { tentativa, avisos });
      return {
        classificacao: ordenar(classificacao),
        meta: { modelo, tentativas: tentativa, fallback: false, avisos },
      };
    }

    await aoEvento("validacao", "erro", { tentativa, erro: erroValidacao });
    motivoFallback = `resposta da IA rejeitada pelo validador: ${erroValidacao}`;
    if (tentativa < maxTentativas) {
      feedback = erroValidacao;
      await aoEvento("ia_nova_tentativa", "aviso", { proxima_tentativa: tentativa + 1, erro: erroValidacao });
    }
  }

  // Fallback: nenhum ticket se perde.
  const classificacao = structuredClone(CLASSIFICACAO_FALLBACK);
  const avisos = aplicarRedeDeSeguranca(classificacao, mensagem);
  await aoEvento("fallback", "aviso", { motivo: motivoFallback });
  return {
    classificacao,
    meta: { modelo, tentativas: tentativa, fallback: true, motivo_fallback: motivoFallback, avisos },
  };
}

// Ordem da resposta da API (docs/prompt-e-validacao.md, seção 6): justificativa por último, para leitura humana.
function ordenar(c) {
  return {
    categoria: c.categoria,
    prioridade: c.prioridade,
    sentimento: c.sentimento,
    resumo: c.resumo,
    dados_extraidos: c.dados_extraidos,
    confianca: c.confianca,
    requer_humano: c.requer_humano,
    suspeita_manipulacao: c.suspeita_manipulacao,
    justificativa: c.justificativa,
  };
}
