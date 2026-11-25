// Vocabulário do domínio, compartilhado pelo prompt, pelos schemas e pelos setores.

export const CATEGORIAS = [
  "urgencia_assistencial",
  "autorizacao",
  "reembolso",
  "financeiro",
  "duvida_plano",
  "contrato",
  "ouvidoria",
  "outros",
];
export const PRIORIDADES = ["urgente", "alta", "media", "baixa"];
export const SENTIMENTOS = ["positivo", "neutro", "negativo"];

export const ENUMS_DADOS = {
  paciente: ["titular", "dependente", "nao_informado"],
  tipo_procedimento: ["exame", "cirurgia", "internacao", "terapia", "consulta", "outro"],
  tipo_financeiro: ["boleto", "cobranca_indevida", "reajuste", "outro"],
  acao_contrato: ["troca_plano", "incluir_dependente", "excluir_dependente", "cancelamento", "cadastro", "outro"],
  tipo_manifestacao: ["reclamacao", "elogio", "sugestao"],
};

// Campos de dados_extraidos mantidos por categoria (além de numero_carteirinha, comum a todas).
export const CAMPOS_POR_CATEGORIA = {
  urgencia_assistencial: ["sintoma", "paciente"],
  autorizacao: ["procedimento", "tipo_procedimento", "houve_negativa"],
  reembolso: ["servico", "valor", "data_atendimento"],
  financeiro: ["tipo_financeiro", "competencia", "valor"],
  duvida_plano: ["especialidade", "procedimento", "bairro", "cidade"],
  contrato: ["acao_contrato"],
  ouvidoria: ["tipo_manifestacao", "prestador", "profissional"],
  outros: [],
};

// Limiar usado no IF do n8n ("precisa de humano?"). O backend só o usa para explicar o motivo da triagem.
export const LIMIAR_CONFIANCA = 0.7;

// Remove acentos e passa para minúsculas, para comparações tolerantes.
export function normalizarTexto(texto) {
  return texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}
