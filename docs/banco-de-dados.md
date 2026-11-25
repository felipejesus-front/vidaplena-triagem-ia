# Especificação: banco de dados (PostgreSQL) e seed

> Passo 4 da seção 9 do `PLANEJAMENTO.md`. **Implementado** em `db/init/01-schema.sql` e `db/init/02-seed.sql`, executados pelo Postgres via `/docker-entrypoint-initdb.d/`.

---

## 1. Visão geral

```
setores 1───N tickets 1───1 encaminhamentos
   │             │
   │             └──N ticket_events
   └───N encaminhamentos
prestadores (tabela de consulta, sem relação; usada pelo setor "atendimento")
```

- **Schemas:**
  - `public`: tabelas da aplicação;
  - `n8n`: tabelas internas do n8n. **Testado:** o próprio n8n cria o schema e as tabelas dele na primeira subida (`DB_POSTGRESDB_SCHEMA=n8n`); o `01-schema.sql` não precisa criá-lo.
- **Usuário do banco:** um só (`vidaplena`), dono dos dois schemas; a senha vem do `secrets-init`.
- **Enumerações:** colunas `text` com `CHECK (... IN (...))`, em vez de tipos `ENUM` do Postgres. Ficam mais fáceis de alterar e de ler nos prints.
- **Extensão:** `unaccent`, para a busca de prestadores ignorar acentos ("Méier" = "meier").
- **Execução do init:** os scripts só rodam com o volume vazio. Para recriar o banco do zero, use `docker compose down -v` (isso também recria os segredos). Fica registrado no README.

---

## 2. Tabelas

### 2.1 `setores`
Também é a **fonte do mapeamento categoria → setor** usado pelo backend (o backend deriva o setor daqui, não do texto da IA).

| coluna | tipo | regras |
|---|---|---|
| `slug` | text | **PK**; usado na URL `/setores/<slug>/encaminhamentos` |
| `nome` | text | not null |
| `categoria` | text | unique, not null; categoria que leva a este setor |
| `email` | text | not null; fictício, domínio `vidaplena.example` (o TLD `.example` é reservado e nunca resolve) |
| `sla_horas` | integer | not null, > 0 |

### 2.2 `prestadores`
| coluna | tipo | regras |
|---|---|---|
| `id` | integer identity | PK |
| `nome` | text | not null |
| `tipo` | text | `clinica`, `hospital`, `laboratorio`, `consultorio` |
| `especialidade` | text | not null; nome de exibição (ex.: "Cardiologia") |
| `termos_busca` | text[] | sinônimos normalizados, sem acento e minúsculos (ex.: `{cardiologia, cardiologista, cardio, coracao}`) |
| `bairro` | text | not null |
| `cidade` | text | not null |

Índice GIN em `termos_busca`.

**Busca do endpoint `atendimento`:** normaliza a `especialidade` extraída pela IA (minúsculas + `unaccent`) e procura em `termos_busca`. Se houver `bairro`, prioriza os do bairro; se não achar no bairro, devolve os da mesma cidade. Limite de 3 sugestões. Os sinônimos resolvem a diferença entre "cardiologista", que o cliente escreve, e "Cardiologia", que está cadastrado, sem depender da IA.

### 2.3 `tickets`
| coluna | tipo | regras |
|---|---|---|
| `id` | integer identity | PK |
| `protocolo` | text | unique, not null; **gerado pelo banco** (ver 2.6) |
| `nome` | text | not null, 2 a 120 caracteres |
| `email` | text | not null |
| `numero_carteirinha` | text | null; só dígitos, de 8 a 20 |
| `mensagem` | text | not null, 10 a 2.000 caracteres |
| `status` | text | not null, default `recebido`; ver 2.7 |
| `categoria` | text | null até a classificação; uma das 8 categorias |
| `prioridade` | text | null; `urgente`, `alta`, `media`, `baixa` |
| `sentimento` | text | null; `positivo`, `neutro`, `negativo` |
| `resumo` | text | null |
| `justificativa` | text | null |
| `dados_extraidos` | jsonb | not null, default `{}` |
| `confianca` | numeric(3,2) | null; de 0 a 1 |
| `requer_humano` | boolean | null |
| `suspeita_manipulacao` | boolean | not null, default false |
| `setor_slug` | text | FK → `setores.slug`, null até a classificação; setor da categoria e, se o ticket for para a triagem manual, `triagem-manual` |
| `modelo_ia` | text | null |
| `tentativas_ia` | smallint | not null, default 0 |
| `fallback_ia` | boolean | not null, default false |
| `criado_em` | timestamptz | not null, default `now()` |
| `classificado_em` | timestamptz | null |
| `encaminhado_em` | timestamptz | null |
| `atualizado_em` | timestamptz | not null; atualizado por trigger |

**Índices:** `status`, `categoria`, `prioridade` e `criado_em DESC`, para os filtros e a ordenação da listagem.

**Coerência garantida pelo banco** (última linha de defesa, além do Zod):
- `CHECK`: se `status` estiver em (`classificado`, `encaminhado`, `triagem_manual`), então `categoria`, `prioridade` e `setor_slug` não podem ser nulos;
- `CHECK`: se `categoria = 'urgencia_assistencial'`, então `prioridade = 'urgente'`.

### 2.4 `encaminhamentos`
| coluna | tipo | regras |
|---|---|---|
| `id` | integer identity | PK |
| `ticket_id` | integer | FK → `tickets.id`, **unique** |
| `setor_slug` | text | FK → `setores.slug`, not null |
| `payload` | jsonb | not null; o que o n8n enviou |
| `resultado` | jsonb | not null; o que o setor produziu (nº de solicitação, sugestões de prestadores, orientação de urgência, motivo da triagem...) |
| `criado_em` | timestamptz | default `now()` |

**Formato do `resultado`:** a parte específica do setor mais três campos comuns: `setor`, `sla_horas` e `prazo_resposta` (data do encaminhamento + SLA). Partes específicas:
- `urgencia`: `alerta: true` e `orientacao` (texto fixo com o 192);
- `autorizacoes`: `numero_solicitacao` no formato `AUT-AAAAMMDD-NNNNNN` (mesma data e número do protocolo) e `pendencias` (ex.: procedimento não informado);
- `reembolsos`: `valor_informado`, `data_atendimento` e `pendencias` (lista do que falta);
- `atendimento`: `criterio` (`bairro`, `cidade`, `especialidade`, `sem_especialidade` ou `especialidade_nao_encontrada`) e `sugestoes` (até 3 prestadores);
- `triagem-manual`: `motivos`, calculados pelo backend a partir da classificação salva: `fallback_ia`, `categoria_outros`, `suspeita_manipulacao`, `requer_humano`, `baixa_confianca` ou, se nenhum se aplicar, `categoria_nao_roteada`;
- `financeiro`, `relacionamento` e `ouvidoria`: só os campos comuns.

**Idempotência:** `ticket_id` é unique. Se o n8n reexecutar o fluxo (nova tentativa, reexecução manual na UI), o endpoint do setor devolve o encaminhamento já existente com `200`, em vez de duplicar. Isso responde ao "e se a automação rodar duas vezes?" e vale uma frase no README.

### 2.5 `ticket_events`
| coluna | tipo | regras |
|---|---|---|
| `id` | bigint identity | PK; **é o `id` do evento SSE** (`Last-Event-ID`) |
| `ticket_id` | integer | FK → `tickets.id`, on delete cascade |
| `etapa` | text | not null; ver a lista abaixo |
| `status` | text | `ok`, `aviso`, `erro` |
| `detalhe` | jsonb | not null, default `{}`; dado real exibido ao expandir a etapa na timeline |
| `criado_em` | timestamptz | default `now()` |

Índice em (`ticket_id`, `id`).

**Etapas** (todas gravadas pelo Express; as que representam ações do n8n são registradas quando o n8n chama a API):

| etapa | quando | `detalhe` (exemplos) |
|---|---|---|
| `recebido` | `POST /tickets` validou a entrada | campos aceitos (sem e-mail completo) |
| `salvo` | ticket inserido | protocolo |
| `enviado_automacao` | webhook do n8n chamado | status HTTP |
| `ia_solicitada` | n8n chamou `/classify` | modelo, tentativa |
| `ia_respondeu` | resposta do Gemini | JSON bruto da IA |
| `ia_nova_tentativa` | resposta rejeitada | erro do validador |
| `validacao` | validação concluída | avisos e correções aplicadas |
| `fallback` | IA indisponível ou inválida | motivo |
| `classificado` | classificação salva | categoria, prioridade, setor |
| `roteado` | o endpoint do setor foi chamado | setor escolhido pelo n8n |
| `encaminhado` | o setor processou | `resultado` do setor |

**Nunca** vão para `detalhe`: chaves, segredos, headers de autenticação.

### 2.6 Protocolo
- Formato: `VP-AAAAMMDD-NNNNNN` (ex.: `VP-20261125-000042`), onde `NNNNNN` é o `id` com zeros à esquerda.
- Gerado por **trigger `BEFORE INSERT`** no banco, com a data de criação em horário de Brasília (`America/Sao_Paulo`). Sem condição de corrida, sem lógica no backend.

### 2.7 Ciclo de vida do `status`

```
recebido ──▶ classificado ──▶ encaminhado
    │              │
    │              └────────▶ triagem_manual
    └──▶ erro  (falha ao acionar o n8n)
```

- `erro` só ocorre se o webhook do n8n estiver inacessível. O ticket fica salvo e visível na listagem com esse status.
- Reprocessamento: fora do Marco 1. Fica como ideia futura um botão "reprocessar" na listagem.

---

## 3. Seed (dados fictícios)

Todos os nomes, e-mails, carteirinhas e prestadores são **inventados**. E-mails no domínio `example.com`, reservado para documentação.

### 3.1 `setores` (8)

| slug | nome | categoria | e-mail | SLA (h) |
|---|---|---|---|---|
| `urgencia` | Fila prioritária / Enfermagem | urgencia_assistencial | urgencia@vidaplena.example | 1 |
| `autorizacoes` | Autorizações | autorizacao | autorizacoes@vidaplena.example | 48 |
| `reembolsos` | Reembolsos | reembolso | reembolsos@vidaplena.example | 120 |
| `financeiro` | Financeiro | financeiro | financeiro@vidaplena.example | 72 |
| `atendimento` | Atendimento | duvida_plano | atendimento@vidaplena.example | 24 |
| `relacionamento` | Relacionamento | contrato | relacionamento@vidaplena.example | 72 |
| `ouvidoria` | Ouvidoria | ouvidoria | ouvidoria@vidaplena.example | 120 |
| `triagem-manual` | Triagem manual | outros | triagem@vidaplena.example | 4 |

Os SLAs são fictícios e servem só para a demo; não refletem prazos regulatórios.

### 3.2 `prestadores` (25, Rio de Janeiro e Niterói)

| # | nome | tipo | especialidade | bairro | cidade |
|---|---|---|---|---|---|
| 1 | Clínica Coração Atlântico | clinica | Cardiologia | Copacabana | Rio de Janeiro |
| 2 | Instituto Cardio Botafogo | clinica | Cardiologia | Botafogo | Rio de Janeiro |
| 3 | Consultório Dr. Renato Paiva | consultorio | Cardiologia | Tijuca | Rio de Janeiro |
| 4 | Derma Leme | clinica | Dermatologia | Copacabana | Rio de Janeiro |
| 5 | Clínica Pele & Saúde | clinica | Dermatologia | Barra da Tijuca | Rio de Janeiro |
| 6 | OrtoMove | clinica | Ortopedia | Barra da Tijuca | Rio de Janeiro |
| 7 | Centro Ortopédico Méier | clinica | Ortopedia | Méier | Rio de Janeiro |
| 8 | Clínica Crescer | clinica | Pediatria | Tijuca | Rio de Janeiro |
| 9 | Pediatria Icaraí | consultorio | Pediatria | Icaraí | Niterói |
| 10 | Espaço Mulher Botafogo | clinica | Ginecologia | Botafogo | Rio de Janeiro |
| 11 | Clínica Gênesis | clinica | Ginecologia | Centro | Rio de Janeiro |
| 12 | Visão Clara Oftalmologia | clinica | Oftalmologia | Copacabana | Rio de Janeiro |
| 13 | Instituto de Olhos Niterói | clinica | Oftalmologia | Icaraí | Niterói |
| 14 | Mente Sã | consultorio | Psiquiatria | Botafogo | Rio de Janeiro |
| 15 | Clínica Equilíbrio | clinica | Psicologia | Tijuca | Rio de Janeiro |
| 16 | FisioAtiva | clinica | Fisioterapia | Copacabana | Rio de Janeiro |
| 17 | ReabilitaRio | clinica | Fisioterapia | Méier | Rio de Janeiro |
| 18 | Policlínica Central | clinica | Clínica geral | Centro | Rio de Janeiro |
| 19 | Clínica Família Barra | clinica | Clínica geral | Barra da Tijuca | Rio de Janeiro |
| 20 | Laboratório Análise Certa | laboratorio | Exames laboratoriais | Copacabana | Rio de Janeiro |
| 21 | ImagemRio Diagnósticos | laboratorio | Exames de imagem | Botafogo | Rio de Janeiro |
| 22 | Diagnóstica Niterói | laboratorio | Exames de imagem | Icaraí | Niterói |
| 23 | Hospital Santa Aurora | hospital | Pronto-socorro | Tijuca | Rio de Janeiro |
| 24 | Hospital Atlântico Sul | hospital | Pronto-socorro | Barra da Tijuca | Rio de Janeiro |
| 25 | Hospital Boa Esperança | hospital | Pronto-socorro | Icaraí | Niterói |

Os `termos_busca` são definidos na implementação, com sinônimos comuns. Exemplos:
- "Exames de imagem": `{exames de imagem, ressonancia, tomografia, raio x, ultrassom}`;
- "Pronto-socorro": `{pronto socorro, emergencia, urgencia, hospital}`.

### 3.3 `tickets` de exemplo (16: 2 por categoria)

Datas espalhadas pelos últimos 10 dias (relativas a `now()`, para a listagem nunca parecer velha). Os textos são diferentes dos exemplos few-shot do prompt e das mensagens do eval.

| # | mensagem (resumida) | categoria | prioridade | sentimento | status |
|---|---|---|---|---|---|
| 1 | Mãe desmaiou e está confusa; o hospital pediu autorização para tomografia | urgencia_assistencial | urgente | negativo | encaminhado |
| 2 | Filho com febre alta e convulsão; precisa saber para onde levar | urgencia_assistencial | urgente | negativo | encaminhado |
| 3 | Pedido de autorização para cirurgia de catarata | autorizacao | media | neutro | encaminhado |
| 4 | Fisioterapia negada após cirurgia no ombro | autorizacao | alta | negativo | encaminhado |
| 5 | Reembolso de consulta com psiquiatra, R$ 400 | reembolso | media | neutro | encaminhado |
| 6 | Reembolso de exame pago há 40 dias e ainda não caiu | reembolso | media | negativo | encaminhado |
| 7 | Mensalidade cobrada em duplicidade em outubro | financeiro | media | negativo | encaminhado |
| 8 | Pedido de segunda via do boleto | financeiro | baixa | neutro | encaminhado |
| 9 | Dermatologista na Barra da Tijuca? | duvida_plano | baixa | neutro | encaminhado |
| 10 | O plano cobre pilates? Qual a carência? | duvida_plano | baixa | neutro | encaminhado |
| 11 | Incluir esposa como dependente | contrato | media | positivo | encaminhado |
| 12 | Quero cancelar o plano | contrato | media | negativo | encaminhado |
| 13 | Recepção da clínica tratou mal o paciente idoso | ouvidoria | media | negativo | encaminhado |
| 14 | Elogio à equipe do laboratório | ouvidoria | baixa | positivo | encaminhado |
| 15 | "Vocês vendem seguro de carro?" | outros | baixa | neutro | triagem_manual |
| 16 | Tentativa de injection disfarçada de dúvida sobre carência | duvida_plano | baixa | neutro | triagem_manual (`suspeita_manipulacao`) |

Cada ticket do seed também recebe:
- **um encaminhamento** com `resultado` coerente: nº de solicitação na autorização, sugestões de prestadores do seed nas dúvidas, orientação fixa na urgência;
- **eventos resumidos** (`recebido`, `classificado`, `roteado`, `encaminhado`), para a timeline do Marco 2 ter o que mostrar no replay.

---

## 4. Verificação (feita com `docker compose up`, banco vazio)
- Os dois scripts rodam sem erro; contagens: 8 setores, 25 prestadores, 16 tickets, 16 encaminhamentos, 64 eventos.
- **Protocolo:** a data sai no horário de Brasília (`AT TIME ZONE 'America/Sao_Paulo'`), e o número acompanha a ordem de criação.
- **Ciclo do backend:** insert (`recebido`) → um `UPDATE` com status + categoria + prioridade + setor (`classificado`) → `encaminhado` passou; `atualizado_em` é tocado pelo trigger.
- **Recusados pelo banco, como esperado:** status `classificado` sem categoria; urgência com prioridade diferente de `urgente`; carteirinha com letras; segundo encaminhamento do mesmo ticket; etapa de evento inexistente.
- **Busca de prestadores:** `unaccent(lower('Cardiologista')) = ANY(termos_busca)` encontra os 3 de cardiologia.
- Observação: um `INSERT` recusado consome um número da sequência, então podem surgir lacunas nos protocolos. É o comportamento normal do Postgres e não afeta a unicidade.
