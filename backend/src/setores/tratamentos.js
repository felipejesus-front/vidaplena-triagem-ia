// O que cada setor faz além de registrar o encaminhamento (PLANEJAMENTO.md, seção 3.1).
// Cada função recebe o ticket (dados do banco) e devolve a parte específica do "resultado".
// Formato do resultado: docs/banco-de-dados.md, seção 2.4.
import { LIMIAR_CONFIANCA } from "../dominio.js";

const ORIENTACAO_URGENCIA =
  "Se houver risco imediato, procure o pronto-socorro mais próximo ou ligue 192 (SAMU). " +
  "A equipe de enfermagem da VidaPlena entrará em contato.";

function urgencia() {
  return { alerta: true, orientacao: ORIENTACAO_URGENCIA };
}

// Número da solicitação com a mesma data e número do protocolo: VP-20261125-000042 → AUT-20261125-000042.
function autorizacoes(ticket) {
  const d = ticket.dados_extraidos;
  return {
    numero_solicitacao: `AUT-${ticket.protocolo.slice(3)}`,
    pendencias: d.procedimento ? [] : ["procedimento não informado"],
  };
}

function reembolsos(ticket) {
  const d = ticket.dados_extraidos;
  const pendencias = [];
  if (d.valor == null) pendencias.push("valor não informado");
  if (d.data_atendimento == null) pendencias.push("data do atendimento não informada");
  return { valor_informado: d.valor ?? null, data_atendimento: d.data_atendimento ?? null, pendencias };
}

// Busca prestadores pela especialidade (sinônimos sem acento); prioriza o bairro, depois a cidade.
async function atendimento(ticket, { db }) {
  const { especialidade, bairro, cidade } = ticket.dados_extraidos;
  if (!especialidade) return { criterio: "sem_especialidade", sugestoes: [] };

  const { rows } = await db.query(
    `SELECT nome, especialidade, bairro, cidade,
            (unaccent(lower(bairro)) = unaccent(lower($2))) AS mesmo_bairro,
            (unaccent(lower(cidade)) = unaccent(lower($3))) AS mesma_cidade
       FROM prestadores
      WHERE unaccent(lower($1)) = ANY (termos_busca)
      ORDER BY mesmo_bairro DESC NULLS LAST, mesma_cidade DESC NULLS LAST, nome
      LIMIT 3`,
    [especialidade.trim(), bairro ?? null, cidade ?? null],
  );

  if (rows.length === 0) return { criterio: "especialidade_nao_encontrada", sugestoes: [] };
  const criterio = rows[0].mesmo_bairro ? "bairro" : rows[0].mesma_cidade ? "cidade" : "especialidade";
  const sugestoes = rows.map(({ nome, especialidade: esp, bairro: b, cidade: c }) => ({
    nome,
    especialidade: esp,
    bairro: b,
    cidade: c,
  }));
  return { criterio, sugestoes };
}

// O motivo é decidido pelo backend a partir da classificação salva; o n8n não calcula nada.
function triagemManual(ticket) {
  const motivos = [];
  if (ticket.fallback_ia) motivos.push("fallback_ia");
  if (ticket.categoria === "outros") motivos.push("categoria_outros");
  if (ticket.suspeita_manipulacao) motivos.push("suspeita_manipulacao");
  if (ticket.requer_humano) motivos.push("requer_humano");
  if (ticket.confianca != null && ticket.confianca < LIMIAR_CONFIANCA) motivos.push("baixa_confianca");
  if (motivos.length === 0) motivos.push("categoria_nao_roteada");
  return { motivos };
}

const apenasRegistro = () => ({});

export const TRATAMENTOS = {
  urgencia,
  autorizacoes,
  reembolsos,
  financeiro: apenasRegistro,
  atendimento,
  relacionamento: apenasRegistro,
  ouvidoria: apenasRegistro,
  "triagem-manual": triagemManual,
};
