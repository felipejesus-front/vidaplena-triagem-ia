# Especificação: fluxo do n8n, node a node

> Passo 5 da seção 9 do `PLANEJAMENTO.md`. Define cada node, a sua configuração e o dado que entra e sai, já pensando nos prints exigidos pela seção 7 do PDF. **Implementado** em `n8n/workflows/triagem.json`: o JSON foi gerado seguindo esta especificação (versões de node da 2.47.3: Webhook 2.1, IF 2.2, Edit Fields 3.4, Switch 3.2, HTTP Request 4.2) e é importado e publicado automaticamente pelo `n8n-import`. Ajustes feitos na UI devem ser exportados de volta (seção 5).

---

## 1. Visão geral

```
[1 Webhook] ─▶ [2 IF: chamada autêntica?] ──não──▶ [3 Stop and Error]
                         │ sim
                         ▼
               [4 Edit Fields: normalizar entrada]
                         ▼
               [5 HTTP: POST /classify]
                         ▼
               [6 IF: precisa de humano?] ──sim──────────────────────────┐
                         │ não                                           │
                         ▼                                               ▼
               [7 Switch: categoria] ──fallback──────────────▶ [15 HTTP: triagem-manual]
                 ├─ urgencia_assistencial ─▶ [8  HTTP: urgencia]
                 ├─ autorizacao ──────────▶ [9  HTTP: autorizacoes]
                 ├─ reembolso ────────────▶ [10 HTTP: reembolsos]
                 ├─ financeiro ───────────▶ [11 HTTP: financeiro]
                 ├─ duvida_plano ─────────▶ [12 HTTP: atendimento]
                 ├─ contrato ─────────────▶ [13 HTTP: relacionamento]
                 └─ ouvidoria ────────────▶ [14 HTTP: ouvidoria]
```

**15 nodes**, além de 3 *sticky notes* no canvas ("Entrada", "Classificação por IA", "Roteamento por setor"). As notas explicam cada bloco no print do fluxo completo e não precisam de print de configuração.

**Configurações do workflow:**

| item | valor |
|---|---|
| Nome | `VidaPlena - Triagem de mensagens` |
| ID fixo | `vpTriagem0000001` (16 caracteres; o reimport sobrescreve o mesmo workflow) |
| Fuso horário | `America/Sao_Paulo` |
| Salvar execuções com sucesso | sim (necessário para os prints de execução) |

### 1.1 Decisões de desenho

| Decisão | Por quê |
|---|---|
| O webhook recebe **só `ticket_id` e `protocolo`**; a mensagem não passa pelo n8n | Minimização de dados (LGPD): o n8n guarda o histórico das execuções, e a mensagem do cliente pode conter dados de saúde. O texto fica só no banco, e o `/classify` o busca pelo `ticket_id`. |
| Retenção de execuções limitada (`EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE=168`, ou seja, 7 dias) | O resumo e os `dados_extraidos` passam pelo n8n; não há motivo para guardá-los para sempre. |
| Autenticação do webhook por um **IF** que compara o header `X-Api-Key` com `$env.INTERNAL_API_KEY` | A autenticação nativa do Webhook ("Header Auth") exige uma credencial do n8n, que teria de ser importada. Com o IF, não há credencial para importar, e a checagem aparece no fluxo e nos prints. |
| O Webhook responde **imediatamente** | O backend não fica esperando a IA: o `POST /tickets` responde ao cliente logo, com o protocolo. |
| Um node HTTP **por setor** (e não um com URL dinâmica) | Decisão anterior: o roteamento fica visível no desenho e cada setor tem o seu print. |
| A saída *fallback* do Switch também vai para a triagem manual | Rede de segurança: uma categoria inesperada nunca fica sem destino. |
| O `id` da execução do n8n vai no corpo enviado ao setor | Rastreabilidade: a partir de um encaminhamento no banco, dá para achar a execução correspondente no n8n. |

---

## 2. Nodes

Em todos os nodes HTTP: header `X-Api-Key` = `{{ $env.INTERNAL_API_KEY }}`; corpo JSON; base `http://backend:3000` (nome do serviço na rede do Docker).

### 1. Webhook: "Novo ticket"
| campo | valor |
|---|---|
| HTTP Method | POST |
| Path | `novo-ticket` (URL de produção: `http://n8n:5678/webhook/novo-ticket`) |
| Authentication | None (validação no node 2) |
| Respond | Immediately |

**Entrada (enviada pelo backend):**
```json
{ "headers": { "x-api-key": "•••" }, "body": { "ticket_id": 42, "protocolo": "VP-20261125-000042" } }
```

### 2. IF: "Chamada autêntica?"
- Condição (String, *is equal to*): `{{ $json.headers['x-api-key'] }}` = `{{ $env.INTERNAL_API_KEY }}`
- **true** → node 4; **false** → node 3.

> Nos prints, a comparação aparece como expressão; o valor do segredo não aparece. Conferir antes de publicar a imagem.

### 3. Stop and Error: "Chamada não autorizada"
- Error message: `Webhook chamado sem X-Api-Key válida.`
- A execução fica marcada como erro no histórico do n8n, onde é fácil de auditar.

### 4. Edit Fields (Set): "Normalizar entrada"
- Mode: Manual Mapping; **Include Other Input Fields: off**, para descartar headers e o resto da requisição.

| campo | tipo | valor |
|---|---|---|
| `ticket_id` | Number | `{{ $json.body.ticket_id }}` |
| `protocolo` | String | `{{ $json.body.protocolo }}` |
| `recebido_no_n8n_em` | String | `{{ $now.toISO() }}` |

**Saída:**
```json
{ "ticket_id": 42, "protocolo": "VP-20261125-000042", "recebido_no_n8n_em": "2026-11-25T14:03:11.204-03:00" }
```
É também a única linha de defesa contra lixo no payload: só esses três campos seguem adiante.

### 5. HTTP Request: "Classificar com IA"
| campo | valor |
|---|---|
| Method / URL | POST `http://backend:3000/classify` |
| Body | `{ "ticket_id": {{ $json.ticket_id }} }` |
| Timeout | 60 000 ms (a IA pode precisar de 2 tentativas) |
| Retry On Fail | sim, 2 tentativas, 5 s de espera |

**Saída:** a resposta do `/classify` (ver `prompt-e-validacao.md`, seção 6), com `classificacao`, `setor` e `meta`.

> O `/classify` é **idempotente**: se o ticket já estiver classificado, devolve a classificação salva sem chamar a IA de novo. Isso torna o *Retry On Fail* e as reexecuções manuais seguros.

### 6. IF: "Precisa de humano?"
- Combinação: **OR**
  - `{{ $json.classificacao.requer_humano }}` (Boolean) *is true*
  - `{{ $json.classificacao.confianca }}` (Number) *is less than* `0.7`
- **true** → node 15; **false** → node 7.

### 7. Switch: "Rotear por categoria"
- Mode: Rules; valor avaliado: `{{ $json.classificacao.categoria }}`
- 7 regras (*is equal to*), com as saídas renomeadas:

| saída | valor | destino |
|---|---|---|
| Urgência | `urgencia_assistencial` | node 8 |
| Autorização | `autorizacao` | node 9 |
| Reembolso | `reembolso` | node 10 |
| Financeiro | `financeiro` | node 11 |
| Dúvida sobre o plano | `duvida_plano` | node 12 |
| Contrato | `contrato` | node 13 |
| Ouvidoria | `ouvidoria` | node 14 |
| *Fallback Output* | (qualquer outro) | node 15 |

### 8 a 14. HTTP Request: "Encaminhar → <Setor>"
Os 7 nodes são iguais, mudando só o slug na URL.

| node | URL |
|---|---|
| 8 | `/setores/urgencia/encaminhamentos` |
| 9 | `/setores/autorizacoes/encaminhamentos` |
| 10 | `/setores/reembolsos/encaminhamentos` |
| 11 | `/setores/financeiro/encaminhamentos` |
| 12 | `/setores/atendimento/encaminhamentos` |
| 13 | `/setores/relacionamento/encaminhamentos` |
| 14 | `/setores/ouvidoria/encaminhamentos` |

**Corpo (igual em todos):**
```json
{
  "ticket_id": "{{ $json.ticket_id }}",
  "classificacao": "{{ $json.classificacao }}",
  "roteado_por": "n8n",
  "execucao_n8n": "{{ $execution.id }}"
}
```
(Na UI, os valores entram como expressões com o tipo correto, não como texto.)

- Retry On Fail: sim, 2 tentativas. É seguro porque o encaminhamento é idempotente (`ticket_id` unique).
- O backend confere se o slug da URL corresponde à categoria recebida. Se não corresponder, responde `409`, protegendo contra um Switch mal configurado.

**Saída (ex.: atendimento):**
```json
{
  "ticket_id": 37, "setor": "atendimento", "status": "encaminhado",
  "resultado": { "sugestoes": [ { "nome": "Clínica Coração Atlântico", "bairro": "Copacabana" } ], "sla_horas": 24 }
}
```

### 15. HTTP Request: "Encaminhar → Triagem manual"
- URL: `/setores/triagem-manual/encaminhamentos`; corpo igual ao dos nodes 8 a 14.
- Recebe três origens: o IF do node 6 (requer humano ou confiança baixa) e a saída *fallback* do Switch.
- O **backend** decide e grava o motivo (`requer_humano`, `baixa_confianca`, `suspeita_manipulacao`, `fallback_ia`, `categoria_nao_roteada`) a partir da classificação. O n8n não precisa calcular nada.

---

## 3. Contrato entre backend e n8n (resumo)

| chamada | quem chama | autenticação | idempotente? |
|---|---|---|---|
| `POST http://n8n:5678/webhook/novo-ticket` | backend | `X-Api-Key` (checado no node 2) | — |
| `POST /classify` | n8n | `X-Api-Key` | sim (devolve a classificação salva) |
| `POST /setores/<slug>/encaminhamentos` | n8n | `X-Api-Key` | sim (`ticket_id` unique) |

Se o webhook do n8n falhar (n8n fora do ar), o backend marca o ticket com status `erro` e grava o evento `enviado_automacao` com status `erro`.

---

## 4. Roteiro de prints (complementa o checklist 6.2 do PLANEJAMENTO)

Preparação: workflow ativo e tickets criados via `POST /tickets` (curl ou front).

| # | print | como obter |
|---|---|---|
| 1 | Fluxo completo | canvas inteiro, com as sticky notes visíveis (zoom "fit") |
| 2 | Execução com sucesso, rota normal | Executions → ticket de autorização → caminho verde até o node 9 |
| 3 | Execução com sucesso, triagem manual | Executions → ticket com injection ou mensagem vaga → node 15 |
| 4 | Execução bloqueada | curl direto no webhook sem `X-Api-Key` → node 3 (mostra a segurança) |
| 5 a 19 | Configuração de cada node (15) | abrir cada node; para os nodes 8 a 14, um print de cada (o PDF pede print individual) |
| 20 | Dado de entrada do webhook | node 1, aba Output, de uma execução real |
| 21 | Saída do Edit Fields | node 4, Output |
| 22 | JSON da IA | node 5, Output (mostra a `classificacao` e a `justificativa`) |
| 23 | Decisão do IF/Switch | node 6/7, mostrando para qual saída o item foi |
| 24 | Resposta do setor | node 12, Output (sugestões de prestadores; é o resultado mais visual) |

Antes de salvar cada imagem: verificar que nenhum print mostra o valor da `X-Api-Key` nem dados reais.

---

## 5. Exportação e importação
- **Exportar** (depois de alterar o fluxo na UI):
  `docker compose exec n8n n8n export:workflow --id=vpTriagem0000001 --pretty --output=/workflows/triagem.json`
  (a pasta `n8n/workflows/` é montada em `/workflows`).
- Antes do commit, conferir o JSON: sem `pinData`, sem valores de segredo (só a expressão `$env.INTERNAL_API_KEY`) e com `"id": "vpTriagem0000001"`.
- **Importar**: feito pelo `n8n-import` em cada `docker compose up` (ver a seção 6 do PLANEJAMENTO).

---

## 6. Verificação (feita com o stack completo)
- Import antes da primeira subida do n8n e publicação automática: ok.
- `$json.headers['x-api-key']` no IF: ok. A expressão usa `?? ''` para que a ausência do header seja comparada como texto vazio (com validação de tipo estrita, `undefined` geraria erro de tipo em vez de cair na saída *false*).
- `$env.INTERNAL_API_KEY` nos nodes: ok.
- Saída *fallback* do Switch e saída *true* do IF ligadas ao mesmo node de triagem: ok.
- Testes: formulário → n8n → `/classify` (fallback) → triagem manual; as 7 saídas do Switch (tickets pré-classificados, aproveitando a idempotência do `/classify`); chamadas sem chave ou com chave errada terminam em erro no node 3.
- Observação: como o Webhook responde imediatamente, uma chamada não autorizada também recebe `200 Workflow was started`; ela só aparece como execução com erro no histórico, sem processar nada.
