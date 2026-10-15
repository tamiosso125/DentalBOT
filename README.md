# DentalBOT

Chatbot de WhatsApp para clínica odontológica: agendamento, orçamentos e cobrança, com a recepção atendendo no mesmo número (coexistência da WhatsApp Cloud API).

## Rodar localmente (sem nenhuma conta externa)

```bash
pnpm install
cp .env.example .env              # gere as chaves: openssl rand -base64 32
docker compose up -d              # Postgres e Redis
pnpm db:migrate && pnpm db:seed   # banco + clínica fictícia
pnpm dev                          # API em http://localhost:3000
```

Com a API no ar, converse com o bot como paciente pelo Claude Code (MCP `whatsapp-sandbox`) ou veja as respostas em `GET http://localhost:3000/dev/sandbox/outbox`.

## Ligar o atendente com Claude

Sem chave, o bot responde com menu e regras fixas (`AI_MODE=off`). Com uma chave da API da Anthropic, acrescente ao `.env`:

```bash
AI_MODE=anthropic
ANTHROPIC_API_KEY=...          # console.anthropic.com
AI_ATTENDANT_EFFORT=medium     # low | medium | high
```

O roteador (Claude Haiku 5.5) classifica cada mensagem e o atendente (Claude Sonnet 5.5) agenda, remarca e cancela pela conversa, usando só as ferramentas de `src/ai/tools.ts`. Antes de ligar em produção, rode `pnpm eval --live`.

## Verificações

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm eval
```

`pnpm eval` roda os casos de conversa de `tests/conversations/` e falha se algum caso crítico (sinal de alarme, pergunta clínica, privacidade) quebrar.

## Estrutura

| Pasta                    | Conteúdo                                                                   |
| ------------------------ | -------------------------------------------------------------------------- |
| `src/`                   | API (Fastify), WhatsApp, conversa, pagamentos (Asaas), agenda, privacidade |
| `prisma/`                | Modelo de dados, migrations e seed                                         |
| `tests/`                 | Casos de conversa (YAML), fixtures e testes de integração                  |
| `tools/mcp/`             | MCP server `whatsapp-sandbox`                                              |
| `plugins/dentalbot-dev/` | Plugin do Claude Code: skills, subagents, comandos, hooks                  |
| `docs/`                  | Contas pendentes e decisões                                                |

## O que depende de contas externas

Veja [docs/contas-pendentes.md](docs/contas-pendentes.md).

## Plano

O plano completo (escopo, arquitetura, LGPD, custos e roadmap) está no documento "DentalBOT · Plano de Implementação" do projeto.
