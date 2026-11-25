-- =============================================================================
-- VidaPlena Saúde: schema da aplicação (schema "public").
-- Executado pelo Postgres só na primeira subida (volume vazio).
-- As tabelas do n8n ficam no schema "n8n", criado pelo próprio n8n.
-- Especificação: docs/banco-de-dados.md
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS unaccent;

-- -----------------------------------------------------------------------------
-- setores: também é a fonte do mapeamento categoria → setor
-- -----------------------------------------------------------------------------
CREATE TABLE setores (
    slug       text PRIMARY KEY,
    nome       text NOT NULL,
    categoria  text NOT NULL UNIQUE
               CHECK (categoria IN ('urgencia_assistencial', 'autorizacao', 'reembolso', 'financeiro',
                                    'duvida_plano', 'contrato', 'ouvidoria', 'outros')),
    email      text NOT NULL,
    sla_horas  integer NOT NULL CHECK (sla_horas > 0)
);

-- -----------------------------------------------------------------------------
-- prestadores: rede credenciada fictícia, consultada pelo setor "atendimento"
-- -----------------------------------------------------------------------------
CREATE TABLE prestadores (
    id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nome           text NOT NULL,
    tipo           text NOT NULL CHECK (tipo IN ('clinica', 'hospital', 'laboratorio', 'consultorio')),
    especialidade  text NOT NULL,
    termos_busca   text[] NOT NULL DEFAULT '{}',   -- sinônimos sem acento e minúsculos
    bairro         text NOT NULL,
    cidade         text NOT NULL
);

CREATE INDEX prestadores_termos_busca_idx ON prestadores USING gin (termos_busca);

-- -----------------------------------------------------------------------------
-- tickets
-- -----------------------------------------------------------------------------
CREATE TABLE tickets (
    id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    protocolo             text NOT NULL UNIQUE,      -- preenchido pelo trigger tickets_gerar_protocolo

    -- entrada
    nome                  text NOT NULL CHECK (char_length(nome) BETWEEN 2 AND 120),
    email                 text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    numero_carteirinha    text CHECK (numero_carteirinha ~ '^[0-9]{8,20}$'),
    mensagem              text NOT NULL CHECK (char_length(mensagem) BETWEEN 10 AND 2000),

    -- controle
    status                text NOT NULL DEFAULT 'recebido'
                          CHECK (status IN ('recebido', 'classificado', 'encaminhado', 'triagem_manual', 'erro')),

    -- classificação
    categoria             text CHECK (categoria IN ('urgencia_assistencial', 'autorizacao', 'reembolso', 'financeiro',
                                                    'duvida_plano', 'contrato', 'ouvidoria', 'outros')),
    prioridade            text CHECK (prioridade IN ('urgente', 'alta', 'media', 'baixa')),
    sentimento            text CHECK (sentimento IN ('positivo', 'neutro', 'negativo')),
    resumo                text,
    justificativa         text,
    dados_extraidos       jsonb NOT NULL DEFAULT '{}'::jsonb,
    confianca             numeric(3,2) CHECK (confianca BETWEEN 0 AND 1),
    requer_humano         boolean,
    suspeita_manipulacao  boolean NOT NULL DEFAULT false,
    setor_slug            text REFERENCES setores (slug),
    modelo_ia             text,
    tentativas_ia         smallint NOT NULL DEFAULT 0 CHECK (tentativas_ia >= 0),
    fallback_ia           boolean NOT NULL DEFAULT false,

    -- datas
    criado_em             timestamptz NOT NULL DEFAULT now(),
    classificado_em       timestamptz,
    encaminhado_em        timestamptz,
    atualizado_em         timestamptz NOT NULL DEFAULT now(),

    -- coerência (última linha de defesa, além do Zod no backend).
    -- O backend grava categoria, prioridade e setor no mesmo UPDATE que muda o status.
    CONSTRAINT tickets_classificacao_completa CHECK (
        status NOT IN ('classificado', 'encaminhado', 'triagem_manual')
        OR (categoria IS NOT NULL AND prioridade IS NOT NULL AND setor_slug IS NOT NULL)
    ),
    CONSTRAINT tickets_urgencia_e_urgente CHECK (
        categoria IS DISTINCT FROM 'urgencia_assistencial' OR prioridade = 'urgente'
    )
);

CREATE INDEX tickets_status_idx     ON tickets (status);
CREATE INDEX tickets_categoria_idx  ON tickets (categoria);
CREATE INDEX tickets_prioridade_idx ON tickets (prioridade);
CREATE INDEX tickets_criado_em_idx  ON tickets (criado_em DESC);

-- Protocolo VP-AAAAMMDD-NNNNNN, com a data de criação no horário de Brasília.
-- Em BEFORE INSERT, o id (identity) e o criado_em (default) já estão preenchidos.
CREATE FUNCTION gerar_protocolo() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.protocolo := 'VP-'
        || to_char(NEW.criado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYYMMDD')
        || '-'
        || lpad(NEW.id::text, 6, '0');
    RETURN NEW;
END;
$$;

CREATE TRIGGER tickets_gerar_protocolo
    BEFORE INSERT ON tickets
    FOR EACH ROW EXECUTE FUNCTION gerar_protocolo();

-- atualizado_em sempre reflete a última alteração.
CREATE FUNCTION tocar_atualizado_em() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.atualizado_em := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER tickets_tocar_atualizado_em
    BEFORE UPDATE ON tickets
    FOR EACH ROW EXECUTE FUNCTION tocar_atualizado_em();

-- -----------------------------------------------------------------------------
-- encaminhamentos: um por ticket (unique), para o endpoint do setor ser idempotente
-- -----------------------------------------------------------------------------
CREATE TABLE encaminhamentos (
    id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id   integer NOT NULL UNIQUE REFERENCES tickets (id) ON DELETE CASCADE,
    setor_slug  text NOT NULL REFERENCES setores (slug),
    payload     jsonb NOT NULL,   -- o que o n8n enviou
    resultado   jsonb NOT NULL,   -- o que o setor produziu
    criado_em   timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- ticket_events: linha do tempo do ticket; o id é o "id" do evento SSE
-- -----------------------------------------------------------------------------
CREATE TABLE ticket_events (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id  integer NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    etapa      text NOT NULL
               CHECK (etapa IN ('recebido', 'salvo', 'enviado_automacao', 'ia_solicitada', 'ia_respondeu',
                                'ia_nova_tentativa', 'validacao', 'fallback', 'classificado',
                                'roteado', 'encaminhado')),
    status     text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'aviso', 'erro')),
    detalhe    jsonb NOT NULL DEFAULT '{}'::jsonb,
    criado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ticket_events_ticket_idx ON ticket_events (ticket_id, id);
