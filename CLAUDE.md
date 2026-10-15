# DentalBOT

Chatbot de WhatsApp para clínica odontológica (1 clínica, 1 dentista, particular + Odontoprev).
MVP: agendamento, orçamentos e cobrança. Código e comentários em inglês; textos ao paciente e documentação em pt-BR.

## Stack

Node 22 + TypeScript strict, Fastify, Prisma + Postgres, BullMQ + Redis, Vitest, Zod.
Painel da equipe em Next.js 15 (`panel/`, workspace pnpm). IA: Claude Sonnet 5.5 como atendente e Haiku 5.5 como roteador (`src/ai/`, SDK `@anthropic-ai/sdk`), ligado com `AI_MODE=anthropic`.

## Comandos

- `pnpm dev` | `pnpm test` | `pnpm lint` | `pnpm typecheck` | `pnpm eval` (`pnpm eval --live` usa o Claude real)
- Painel: `pnpm --filter @dentalbot/panel dev|typecheck|test|build`
- `pnpm db:migrate` (cria migration) | `pnpm db:seed` (clínica fictícia)
- `docker compose up -d` sobe Postgres e Redis locais

## Mapa do código

- `src/http/server.ts`: rotas (webhooks WhatsApp e Asaas, health, outbox do sandbox, API da equipe `/admin/*` com token Bearer).
- `src/whatsapp/`: assinatura, schema do webhook, canal (Cloud API ou sandbox), templates.
- `src/conversation/`: handler da fila, detecção de intenção, textos ao paciente, stores.
- `src/payments/`: gateway Asaas (http e mock) e eventos de pagamento.
- `panel/`: painel Next.js (App Router). Chama a API `/admin/*` só pelo servidor (`panel/src/lib/api.ts`, `server-only`); login por senha da equipe com cookie HMAC; `middleware.ts` protege tudo menos `/login`.
- `src/panel/`: consultas de leitura do painel da equipe (agenda, pacientes, catálogo, orçamentos, conversas pausadas), sempre por clínica e com telefone mascarado, as parcelas e o link de pagamento (`billing.ts`), os pedidos do titular da LGPD (`patient-data.ts`: exportar e anonimizar) e o cadastro da clínica (`clinic-setup.ts`: dados, dentistas, horários, procedimentos e preços, convênios e cobertura, bloqueios de agenda).
- `src/quotes/`: `QuoteService` (criar, PDF, enviar, aceite ou recusa pelos botões), PDF com pdfkit e repositórios Prisma/memória.
- `src/ai/`: orquestrador (roteador + atendente), ferramentas com Zod, guarda de saída, prompt, `ScriptedLlm` para testes.
- `src/scheduling/`: contrato `AgendaProvider`, `AgendaService` (regras), repositórios Prisma/memória, lembrete de consulta da véspera com Confirmar/Remarcar (`appointment-reminders.ts`), agenda da recepção pelo painel (`staff-agenda.ts`) e o MCP da agenda (`agenda-mcp.ts`).
- `src/recall/`: retorno de pacientes (`recall.ts`: quem está há meses sem consulta, consentimento de marketing e o convite semanal `convite_retorno`), repositórios Prisma/memória.
- `src/privacy/`: `redact()`, criptografia de campo e normalização de CPF/telefone.
- `tests/conversations/*.yaml`: casos de eval. `tools/mcp/`: MCP servers de desenvolvimento.
- `deploy/`: produção na VPS (`compose.yml` com Caddy/HTTPS, API, painel, Postgres, Redis e backup criptografado com age). Guia em `docs/deploy-vps.md`. Imagens: `Dockerfile` (API) e `panel/Dockerfile`.

## Regras inegociáveis

- Nunca logar CPF, telefone completo, sintomas ou conteúdo de mensagens. Use o logger de `src/lib/logger.ts` (aplica `redact()`) e logue ids.
- Todo dado de saúde ou pessoal passa por `src/privacy`: colunas `*Encrypted` + `*Hash`, nunca texto puro.
- Mensagem iniciada pela clínica só por template aprovado (`src/whatsapp/templates.ts`).
- Marketing exige consentimento registrado e respeita `marketingOptOutAt`.
- O bot nunca diagnostica nem prescreve; intenção clínica vai para handoff humano. Sinal de alarme orienta pronto-socorro e chama a equipe, mesmo com o bot pausado.
- Webhooks (Meta e Asaas): validar assinatura/token, responder 200 em menos de 5 s e processar na fila. Tudo idempotente.
- Toda ferramenta do LLM valida entrada com Zod e checa permissão do tenant. O modelo nunca escreve direto no banco nem inventa preço ou horário: horários vêm de `listar_horarios` e são escolhidos por número, e a guarda de saída (`src/ai/guard.ts`) bloqueia hora ou preço que nenhuma ferramenta devolveu.
- Valores em centavos inteiros; conversão para reais só na borda (Asaas).
- Só dados fictícios em código e testes: CPF 529.982.247-25, celular 55 11 90000-XXXX.

## Contas externas ainda não abertas

Meta Business, Asaas, VPS e chave da Anthropic ainda não existem. Tudo roda com `WHATSAPP_MODE=sandbox`, `ASAAS_ENV=mock`, `QUEUE_MODE=memory` e `AI_MODE=off`. Ver `docs/contas-pendentes.md`.

## Testes

Novos fluxos de conversa entram em `tests/conversations/*.yaml` e rodam no eval (skill `conversa-eval`). Fluxos que cruzam HTTP, fila e banco ganham um teste em `tests/e2e/` (roda com `TEST_DATABASE_URL`, como no CI). Todo PR traz os testes do que muda. Antes de abrir PR: `pnpm lint && pnpm typecheck && pnpm test && pnpm eval`.

## Ferramentas do Claude Code

O plugin `plugins/dentalbot-dev` (habilitado em `.claude/settings.json`) traz as skills, os subagents (`arquiteto-backend`, `revisor-lgpd`, `testador-conversas`, `redator-templates`, `integrador-sistemas`), os comandos `/eval`, `/novo-fluxo`, `/novo-template`, `/onboarding-clinica`, os hooks e os MCP `whatsapp-sandbox` (conversar com o bot como paciente) e `dentalbot-agenda` (ver e mexer na agenda com as regras do atendente; `AGENDA_SOURCE=memory` ou `database`, nunca produção).
