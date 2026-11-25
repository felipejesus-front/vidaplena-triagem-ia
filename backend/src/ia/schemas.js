// Schemas da classificação: o responseSchema enviado ao Gemini (1ª camada) e o Zod do Express (2ª camada).
// Especificação: docs/prompt-e-validacao.md, seções 4 e 5.
import { z } from "zod";
import { CAMPOS_POR_CATEGORIA, CATEGORIAS, ENUMS_DADOS, PRIORIDADES, SENTIMENTOS } from "../dominio.js";

const ORDEM_CAMPOS = [
  "justificativa",
  "categoria",
  "prioridade",
  "sentimento",
  "resumo",
  "dados_extraidos",
  "confianca",
  "requer_humano",
  "suspeita_manipulacao",
];

const texto = { type: "STRING", nullable: true };
const enumNulavel = (valores) => ({ type: "STRING", nullable: true, enum: valores });

const PROPRIEDADES_DADOS = {
  numero_carteirinha: texto,
  sintoma: texto,
  paciente: enumNulavel(ENUMS_DADOS.paciente),
  procedimento: texto,
  tipo_procedimento: enumNulavel(ENUMS_DADOS.tipo_procedimento),
  houve_negativa: { type: "BOOLEAN", nullable: true },
  servico: texto,
  valor: { type: "NUMBER", nullable: true },
  data_atendimento: texto,
  tipo_financeiro: enumNulavel(ENUMS_DADOS.tipo_financeiro),
  competencia: texto,
  especialidade: texto,
  bairro: texto,
  cidade: texto,
  acao_contrato: enumNulavel(ENUMS_DADOS.acao_contrato),
  tipo_manifestacao: enumNulavel(ENUMS_DADOS.tipo_manifestacao),
  prestador: texto,
  profissional: texto,
};
// Todos obrigatórios (e anuláveis): sem isso, o Gemini tende a omitir os campos e não extrair nada.
const CAMPOS_DADOS = Object.keys(PROPRIEDADES_DADOS);

export const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    justificativa: { type: "STRING" },
    categoria: { type: "STRING", enum: CATEGORIAS },
    prioridade: { type: "STRING", enum: PRIORIDADES },
    sentimento: { type: "STRING", enum: SENTIMENTOS },
    resumo: { type: "STRING" },
    dados_extraidos: {
      type: "OBJECT",
      properties: PROPRIEDADES_DADOS,
      required: CAMPOS_DADOS,
      propertyOrdering: CAMPOS_DADOS,
    },
    confianca: { type: "NUMBER" },
    requer_humano: { type: "BOOLEAN" },
    suspeita_manipulacao: { type: "BOOLEAN" },
  },
  required: ORDEM_CAMPOS,
  propertyOrdering: ORDEM_CAMPOS,
};

// Forma da resposta. dados_extraidos é validado campo a campo depois (um campo ruim não derruba a resposta).
export const respostaIaSchema = z.object({
  justificativa: z.string().trim().min(1, "justificativa vazia"),
  categoria: z.enum(CATEGORIAS),
  prioridade: z.enum(PRIORIDADES),
  sentimento: z.enum(SENTIMENTOS),
  resumo: z.string().trim().min(10, "resumo com menos de 10 caracteres").max(300, "resumo com mais de 300 caracteres"),
  dados_extraidos: z.record(z.string(), z.unknown()),
  confianca: z.number().min(0).max(1),
  requer_humano: z.boolean(),
  suspeita_manipulacao: z.boolean(),
});

// ---------------------------------------------------------------------------
// Validação de cada campo de dados_extraidos
// ---------------------------------------------------------------------------
const textoCurto = z.string().trim().min(1).max(200);

function dataValidaNaoFutura(valor) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const data = new Date(`${valor}T00:00:00Z`);
  if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== valor) return false;
  return data.getTime() <= Date.now();
}

const VALIDADORES_CAMPO = {
  // Aceita "0012 3456-7890" e normaliza para só dígitos.
  numero_carteirinha: z
    .string()
    .transform((v) => v.replace(/[\s.\-/]/g, ""))
    .pipe(z.string().regex(/^\d{8,20}$/, "deve ter de 8 a 20 dígitos")),
  sintoma: textoCurto,
  paciente: z.enum(ENUMS_DADOS.paciente),
  procedimento: textoCurto,
  tipo_procedimento: z.enum(ENUMS_DADOS.tipo_procedimento),
  houve_negativa: z.boolean(),
  servico: textoCurto,
  valor: z.number().nonnegative("não pode ser negativo").max(1_000_000),
  data_atendimento: z.string().refine(dataValidaNaoFutura, "data inválida ou no futuro"),
  tipo_financeiro: z.enum(ENUMS_DADOS.tipo_financeiro),
  competencia: textoCurto,
  especialidade: textoCurto,
  bairro: textoCurto,
  cidade: textoCurto,
  acao_contrato: z.enum(ENUMS_DADOS.acao_contrato),
  tipo_manifestacao: z.enum(ENUMS_DADOS.tipo_manifestacao),
  prestador: textoCurto,
  profissional: textoCurto,
};

/**
 * Mantém só os campos da categoria (mais numero_carteirinha) e valida cada um.
 * Campo inválido vira null e gera um aviso; campos de outras categorias são descartados.
 * @returns {{ dados: object, avisos: string[] }}
 */
export function filtrarDadosPorCategoria(categoria, dadosBrutos = {}) {
  const campos = ["numero_carteirinha", ...(CAMPOS_POR_CATEGORIA[categoria] ?? [])];
  const dados = {};
  const avisos = [];
  for (const campo of campos) {
    const bruto = dadosBrutos?.[campo];
    if (bruto === null || bruto === undefined || bruto === "") {
      dados[campo] = null;
      continue;
    }
    const resultado = VALIDADORES_CAMPO[campo].safeParse(bruto);
    if (resultado.success) {
      dados[campo] = resultado.data;
    } else {
      dados[campo] = null;
      avisos.push(`dados_extraidos.${campo} descartado: ${resultado.error.issues[0]?.message ?? "inválido"}`);
    }
  }
  return { dados, avisos };
}

// Formata um ZodError em uma frase curta (usada como feedback para a IA e em respostas 400).
export function descreverErroZod(erro) {
  return erro.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
    .join("; ");
}
