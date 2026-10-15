# DentalBOT

Chatbot de WhatsApp para clínica odontológica (1 clínica, 1 dentista, particular + Odontoprev).
MVP: agendamento, orçamentos e cobrança. Código e comentários em inglês; textos ao paciente e documentação em pt-BR.

## Stack

Node 22 + TypeScript strict, Fastify, Prisma + Postgres, BullMQ + Redis, Vitest, Zod.
Painel em Next.js (ainda não criado). IA: Claude Sonnet 5.5 como atendente e Haiku 5.5 como roteador (orquestrador ainda não criado).

## Comandos

- `pnpm dev` | `pnpm test` | `pnpm lint` | `pnpm typecheck` | `pnpm eval`
- `pnpm db:migrate` (cria migration) | `pnpm db:seed` (clínica fictícia)
- `docker compose up -d` sobe Postgres e Redis locais

## Mapa do código

- `src/http/server.ts`: rotas (webhooks WhatsApp e Asaas, health, outbox do sandbox).
- `src/whatsapp/`: assinatura, schema do webhook, canal (Cloud API ou sandbox), templates.
- `src/conversation/`: handler da fila, detecção de intenção, textos ao paciente, stores.
- `src/payments/`: gateway Asaas (http e mock) e eventos de pagamento.
- `src/scheduling/`: contrato `AgendaProvider` e cálculo de horários livres.
- `src/privacy/`: `redact()`, criptografia de campo e normalização de CPF/telefone.
- `tests/conversations/*.yaml`: casos de eval. `tools/mcp/`: MCP servers de desenvolvimento.

## Regras inegociáveis

- Nunca logar CPF, telefone completo, sintomas ou conteúdo de mensagens. Use o logger de `src/lib/logger.ts` (aplica `redact()`) e logue ids.
- Todo dado de saúde ou pessoal passa por `src/privacy`: colunas `*Encrypted` + `*Hash`, nunca texto puro.
- Mensagem iniciada pela clínica só por template aprovado (`src/whatsapp/templates.ts`).
- Marketing exige consentimento registrado e respeita `marketingOptOutAt`.
- O bot nunca diagnostica nem prescreve; intenção clínica vai para handoff humano. Sinal de alarme orienta pronto-socorro e chama a equipe, mesmo com o bot pausado.
- Webhooks (Meta e Asaas): validar assinatura/token, responder 200 em menos de 5 s e processar na fila. Tudo idempotente.
- Toda ferramenta do LLM valida entrada com Zod e checa permissão do tenant. O modelo nunca escreve direto no banco nem inventa preço ou horário.
- Valores em centavos inteiros; conversão para reais só na borda (Asaas).
- Só dados fictícios em código e testes: CPF 529.982.247-25, celular 55 11 90000-XXXX.

## Contas externas ainda não abertas

Meta Business, Asaas e VPS ainda não existem. Tudo roda com `WHATSAPP_MODE=sandbox`, `ASAAS_ENV=mock` e `QUEUE_MODE=memory`. Ver `docs/contas-pendentes.md`.

## Testes

Novos fluxos de conversa entram em `tests/conversations/*.yaml` e rodam no eval (skill `conversa-eval`). Antes de abrir PR: `pnpm lint && pnpm typecheck && pnpm test && pnpm eval`.

## Ferramentas do Claude Code

O plugin `plugins/dentalbot-dev` (habilitado em `.claude/settings.json`) traz as skills, os subagents (`arquiteto-backend`, `revisor-lgpd`, `testador-conversas`, `redator-templates`, `integrador-sistemas`), os comandos `/eval`, `/novo-fluxo`, `/novo-template`, `/onboarding-clinica`, os hooks e o MCP `whatsapp-sandbox`.
