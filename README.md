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

O MCP `dentalbot-agenda` deixa o Claude Code consultar e mexer na agenda com as mesmas regras do atendente: horários livres, reservar, remarcar e cancelar, sempre por opções numeradas e com o telefone mascarado. Por padrão usa uma clínica fictícia em memória; com `AGENDA_SOURCE=database` usa o Postgres local do `.env` (recusa rodar com `NODE_ENV=production`).

## Ligar o atendente com Claude

Sem chave, o bot responde com menu e regras fixas (`AI_MODE=off`). Com uma chave da API da Anthropic, acrescente ao `.env`:

```bash
AI_MODE=anthropic
ANTHROPIC_API_KEY=...          # console.anthropic.com
AI_ATTENDANT_EFFORT=medium     # low | medium | high
```

O roteador (Claude Haiku 5.5) classifica cada mensagem e o atendente (Claude Sonnet 5.5) agenda, remarca e cancela pela conversa, usando só as ferramentas de `src/ai/tools.ts`. Antes de ligar em produção, rode `pnpm eval --live`.

Na véspera de cada consulta (entre 9h e 19h no fuso da clínica) o bot manda o template `lembrete_consulta` com os botões Confirmar e Remarcar. Confirmar marca a consulta como confirmada, mesmo com a recepção atendendo; Remarcar abre a remarcação pela conversa com a IA ligada, ou passa para a recepção. Consulta remarcada recebe um lembrete novo. Para mudar a frequência da verificação:

```bash
APPOINTMENT_REMINDER_INTERVAL_MINUTES=60   # 0 desliga
```

## Orçamentos

A dentista monta (pelo painel ou pela API) o orçamento e o bot manda o PDF pelo WhatsApp. Se o paciente escreveu nas últimas 24 h, vão o PDF e os botões Aprovar / Não aprovar; senão vai o template `orcamento_disponivel`, e o botão "Ver orçamento" traz o PDF. Na aprovação o bot registra as parcelas, cria uma cobrança no Asaas para cada uma e manda ao paciente o link da primeira, onde ele escolhe Pix, boleto ou cartão. Se o paciente não tem CPF no cadastro (o Asaas exige) ou o Asaas falhar, a aprovação fica registrada e a recepção é chamada para cobrar. Com `ASAAS_ENV=mock` as cobranças são simuladas.

As parcelas seguintes recebem um lembrete com o link de pagamento pelo template `cobranca_parcela`, a partir de 3 dias antes do vencimento, uma vez só e entre 9h e 19h no fuso da clínica. Parcela já paga no Asaas não recebe lembrete. Ajustes opcionais no `.env`:

```bash
INSTALLMENT_REMINDER_DAYS=3                # dias antes do vencimento
INSTALLMENT_REMINDER_INTERVAL_MINUTES=60   # de quanto em quanto tempo verifica; 0 desliga
```

Ligue a API da equipe acrescentando ao `.env` um token (`openssl rand -hex 32`) e o id da clínica:

```bash
ADMIN_API_TOKEN=...
DEFAULT_CLINIC_ID=clinic_dev
```

| Rota                                       | O que faz                                                             |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `POST /admin/quotes`                       | Cria o orçamento (itens da tabela ou com preço da dentista, parcelas) |
| `GET /admin/quotes/:id`                    | Mostra o orçamento e o status                                         |
| `GET /admin/quotes/:id/pdf`                | Baixa o PDF                                                           |
| `POST /admin/quotes/:id/send`              | Envia ao paciente pelo WhatsApp                                       |
| `GET /admin/quotes?status=SENT`            | Lista os orçamentos (filtro opcional por status)                      |
| `GET /admin/agenda?from=AAAA-MM-DD&days=7` | Consultas do período, por dia no fuso da clínica                      |
| `GET /admin/patients?q=maria`              | Busca paciente por nome ou pelo celular completo                      |
| `GET /admin/catalog`                       | Dentistas ativos e procedimentos (para montar o orçamento)            |
| `GET /admin/handoffs`                      | Conversas com o bot pausado esperando a recepção                      |

As rotas de leitura alimentam o painel da equipe e mostram só os 4 últimos dígitos do celular.

Exemplo com o paciente fictício do seed:

```bash
curl -X POST localhost:3000/admin/quotes -H "authorization: Bearer $ADMIN_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"patientId":"patient_dev","dentistId":"dentist_dev","items":[{"procedureId":"<id da limpeza>"}],"installmentCount":2}'
```

## Painel da equipe

O painel (`panel/`, Next.js) mostra a agenda da semana, as conversas com o bot pausado esperando a recepção e os orçamentos, e permite criar um orçamento, ver o PDF e enviar pelo WhatsApp. Ele só fala com a API do DentalBOT pelo servidor: o token nunca chega ao navegador. O acesso é por uma senha da equipe, com sessão de 12 h num cookie assinado.

Com a API rodando (`pnpm dev`), crie `panel/.env.local`:

```bash
DENTALBOT_API_URL=http://localhost:3000
ADMIN_API_TOKEN=...            # o mesmo da API
PANEL_PASSWORD=...             # senha da equipe
PANEL_SESSION_SECRET=...       # openssl rand -hex 32
```

e rode `pnpm --filter @dentalbot/panel dev`. O painel abre em http://localhost:3001.

## Verificações

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm eval
pnpm --filter @dentalbot/panel typecheck && pnpm --filter @dentalbot/panel test
```

Com um Postgres descartável, `TEST_DATABASE_URL=postgresql://... pnpm test` também roda os testes de integração e os de ponta a ponta (`tests/e2e/`): servidor HTTP de verdade, webhook assinado, fila, banco e saída do sandbox, montados pelo mesmo `createApp()` da produção. O CI roda tudo isso em cada PR. `pnpm test:e2e` roda só esses.

`pnpm eval` roda os casos de conversa de `tests/conversations/` e falha se algum caso crítico (sinal de alarme, pergunta clínica, privacidade) quebrar.

## Estrutura

| Pasta                    | Conteúdo                                                                   |
| ------------------------ | -------------------------------------------------------------------------- |
| `src/`                   | API (Fastify), WhatsApp, conversa, pagamentos (Asaas), agenda, privacidade |
| `panel/`                 | Painel da equipe (Next.js): agenda, orçamentos, conversas pausadas         |
| `prisma/`                | Modelo de dados, migrations e seed                                         |
| `tests/`                 | Casos de conversa (YAML), fixtures e testes de integração                  |
| `tools/mcp/`             | MCP servers `whatsapp-sandbox` e `dentalbot-agenda`                        |
| `plugins/dentalbot-dev/` | Plugin do Claude Code: skills, subagents, comandos, hooks                  |
| `docs/`                  | Contas pendentes e decisões                                                |

## O que depende de contas externas

Veja [docs/contas-pendentes.md](docs/contas-pendentes.md).

## Plano

O plano completo (escopo, arquitetura, LGPD, custos e roadmap) está no documento "DentalBOT · Plano de Implementação" do projeto.
