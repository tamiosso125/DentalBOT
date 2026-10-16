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

Na véspera de cada consulta (entre 9h e 19h no fuso da clínica) o bot manda o template `lembrete_consulta` com os botões Confirmar e Remarcar. Confirmar marca a consulta como confirmada, mesmo com a recepção atendendo; Remarcar abre a remarcação pela conversa com a IA ligada, ou passa para a recepção. Consulta remarcada recebe um lembrete novo. Quando a recepção marca "Faltou", o bot manda no dia seguinte (9h–19h, até 3 dias depois da consulta) uma vez o template `consulta_perdida` com os botões "Marcar novo horário" e "Falar com a recepção"; não manda se o paciente já marcou outra consulta ou se a recepção está na conversa. "Marcar novo horário" abre o agendamento pela conversa com a IA ligada, ou passa para a recepção; a consulta perdida continua como falta. Os dois rodam no mesmo intervalo:

```bash
APPOINTMENT_REMINDER_INTERVAL_MINUTES=60   # 0 desliga
```

### Retorno de pacientes

Quem teve a última consulta há mais de 6 meses e não tem nada marcado recebe, nas terças entre 9h e 12h (fuso da clínica), o template de marketing `convite_retorno` com os botões "Quero agendar" e "Não quero receber". Vai um convite por última consulta, no máximo 50 por rodada, e só para quem tem consentimento de marketing registrado pela recepção (página "Retorno" do painel, texto versão `retorno-v1`). PARAR ou "Não quero receber" depois do consentimento bloqueiam o convite até a recepção registrar um consentimento novo. Além da recepção, o próprio bot pergunta uma vez, quando o paciente confirma uma consulta pelo botão (e não pediu PARAR nem respondeu antes), se ele quer o convite; a resposta fica registrada como consentimento vindo do WhatsApp (texto `retorno-whatsapp-v1`). "Quero agendar" abre o agendamento pela conversa com a IA ligada, ou passa para a recepção. Ajustes opcionais no `.env`:

```bash
RECALL_AFTER_MONTHS=6        # meses desde a última consulta
RECALL_INTERVAL_MINUTES=60   # de quanto em quanto tempo verifica; 0 desliga
```

### Lista de espera

Quem quer um horário mais cedo do que os livres entra na lista de espera de um procedimento, até um dia escolhido: pela conversa com o bot (com a IA ligada, a ferramenta `entrar_lista_espera` guarda o pedido até a véspera do primeiro horário livre) ou pela recepção, na página "Lista de espera" do painel. A cada poucos minutos, entre 8h e 20h no fuso da clínica, o bot procura horários livres antes da data de cada paciente e oferece cada um aos três primeiros da fila pelo template `vaga_disponivel`, com os botões "Quero esse horário" e "Não, obrigado". Quem aceitar primeiro fica com a vaga (se já tinha uma consulta mais tarde do mesmo procedimento, ela é antecipada); quem aceitar depois recebe o aviso de que a vaga foi preenchida e continua na fila. Uma vaga sem resposta passa aos próximos depois de 1 h, e o mesmo horário nunca é oferecido duas vezes à mesma pessoa. As respostas valem mesmo com a recepção na conversa. Passada a data, o pedido expira. Para mudar a frequência:

```bash
WAITLIST_INTERVAL_MINUTES=5   # 0 desliga
```

### Pesquisa de satisfação

Depois que a recepção marca "Compareceu" no painel, o paciente recebe no dia seguinte, entre 10h e 19h (fuso da clínica), o template `pesquisa_satisfacao` com as notas de 1 a 5 em botões. Vai no máximo uma pesquisa por paciente a cada 30 dias, nunca depois de falta, e não sai enquanto a recepção estiver conversando com o paciente; se a marcação atrasar, a pesquisa ainda vai até 3 dias depois da consulta. A nota vale mesmo com a recepção na conversa e só conta uma vez. Nota 1 ou 2 responde com um pedido de desculpas e chama a recepção. O painel mostra, na Agenda, a nota média do mês, quantos responderam e as notas baixas dos últimos 30 dias. A pesquisa não pede comentário escrito: um texto livre seria confundido com as mensagens normais do paciente. Para mudar a frequência:

```bash
SURVEY_INTERVAL_MINUTES=60   # 0 desliga
```

### Convênio e autorização prévia

Odontoprev não tem API pública, então a autorização é pedida pela recepção no portal do convênio. Quando o paciente diz que é do convênio, o atendente com IA pede o número da carteirinha e registra pela ferramenta `informar_convenio` (a carteirinha fica criptografada e o bot não a repete na conversa). Se o procedimento marcado pede autorização prévia na tabela de cobertura do convênio, a consulta aparece no painel em "Autorizações", com a carteirinha completa, e a Agenda mostra quantas estão pendentes. A recepção pede no portal e marca "Autorizado" ou "Negado". O paciente recebe o template `convenio_autorizado` ou `convenio_negado`; este traz os botões "Seguir como particular" (a consulta fica, e o bot informa o preço particular do procedimento) e "Falar com a recepção". O botão vale mesmo com a recepção na conversa. A recepção também cadastra ou corrige o convênio e a carteirinha do paciente na página da consulta.

## Orçamentos

A dentista monta (pelo painel ou pela API) o orçamento e o bot manda o PDF pelo WhatsApp. Se o paciente escreveu nas últimas 24 h, vão o PDF e os botões Aprovar / Não aprovar; senão vai o template `orcamento_disponivel`, e o botão "Ver orçamento" traz o PDF. Na aprovação o bot registra as parcelas, cria uma cobrança no Asaas para cada uma e manda ao paciente o link da primeira, onde ele escolhe Pix, boleto ou cartão. Se o paciente não tem CPF no cadastro (o Asaas exige) ou o Asaas falhar, a aprovação fica registrada e a recepção é chamada para cobrar. Com `ASAAS_ENV=mock` as cobranças são simuladas.

As parcelas seguintes recebem um lembrete com o link de pagamento pelo template `cobranca_parcela`, a partir de 3 dias antes do vencimento, uma vez só e entre 9h e 19h no fuso da clínica. Parcela já paga no Asaas não recebe lembrete. Ajustes opcionais no `.env`:

```bash
INSTALLMENT_REMINDER_DAYS=3                # dias antes do vencimento
INSTALLMENT_REMINDER_INTERVAL_MINUTES=60   # de quanto em quanto tempo verifica; 0 desliga
OVERDUE_NOTICE_DAYS=1                      # dias depois do vencimento para o aviso de parcela vencida
```

Parcela que vence sem pagamento recebe, uma vez, o template `parcela_vencida` no dia seguinte (com o link do Asaas e o botão "Falar com a recepção"), entre 9h e 19h e só se a recepção não estiver conversando com o paciente. O bot consulta o Asaas antes e não manda nada para quem já pagou; parcelas vencidas há mais de 30 dias ficam com a recepção. Se a parcela continuar em aberto uma semana depois do vencimento, o painel mostra o aviso "Parcelas para cobrar por telefone".

Orçamento enviado sem resposta recebe um lembrete, uma vez só, 3 dias depois do envio, pelo template `lembrete_orcamento` (com a validade e o mesmo botão "Ver orçamento"), entre 9h e 19h no fuso da clínica. Se a recepção estiver conversando com o paciente (bot pausado), o lembrete espera. Quando a validade acaba, o orçamento passa a vencido sozinho, sem lembrete. Ajustes opcionais no `.env`:

```bash
QUOTE_REMINDER_DAYS=3                  # dias depois do envio
QUOTE_FOLLOW_UP_INTERVAL_MINUTES=60    # de quanto em quanto tempo verifica; 0 desliga
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
| `GET /admin/quotes/follow-up`              | Orçamentos esperando resposta e aprovados/recusados/vencidos do mês   |
| `GET /admin/agenda?from=AAAA-MM-DD&days=7` | Consultas do período, por dia no fuso da clínica                      |
| `GET /admin/patients?q=maria`              | Busca paciente por nome ou pelo celular completo                      |
| `GET /admin/catalog`                       | Dentistas ativos e procedimentos (para montar o orçamento)            |
| `GET /admin/handoffs`                      | Conversas com o bot pausado esperando a recepção                      |
| `GET /admin/data-requests`                 | Pedidos MEUS DADOS em aberto                                          |
| `GET /admin/patients/:id/export`           | Cópia dos dados do paciente em JSON (também por `/data-requests/:id`) |
| `POST /admin/patients/:id/anonymize`       | Anonimiza o paciente (também por `/data-requests/:id`)                |
| `POST /admin/data-requests/:id/resolve`    | Marca o pedido como respondido                                        |

As rotas de leitura alimentam o painel da equipe e mostram só os 4 últimos dígitos do celular.

Exemplo com o paciente fictício do seed:

```bash
curl -X POST localhost:3000/admin/quotes -H "authorization: Bearer $ADMIN_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"patientId":"patient_dev","dentistId":"dentist_dev","items":[{"procedureId":"<id da limpeza>"}],"installmentCount":2}'
```

## Painel da equipe

O painel (`panel/`, Next.js) mostra a agenda da semana, as conversas com o bot pausado esperando a recepção e os orçamentos. Nele a recepção marca, remarca e cancela consultas (com as mesmas regras de horário do bot; ao marcar ou remarcar, o paciente pode receber o template `confirmacao_consulta` com Confirmar e Remarcar) e cria um orçamento, vê o PDF e envia pelo WhatsApp. Em "Orçamentos" ela vê os que esperam resposta do paciente (há quantos dias e se o lembrete já saiu) e a taxa de aceite do mês. Em "Cobranças" ela acompanha as parcelas (em aberto, vencidas, para ligar e pagas, com os totais do mês) e abre o link de pagamento do Asaas de uma parcela para mandar ao paciente; o orçamento aprovado mostra as próprias parcelas. Depois do horário de uma consulta, ela marca "Compareceu" ou "Faltou" na agenda (que lista as consultas passadas ainda sem marcação) ou no detalhe da consulta, e a página inicial mostra as atendidas, as faltas e a taxa de falta do mês, além de quantos faltosos receberam o convite para remarcar e quantos marcaram de novo; falta não conta como visita para o retorno. Em "Lista de espera" ela põe ou tira pacientes da fila e vê a última vaga oferecida a cada um. Em "Retorno" ela vê quem está há meses sem consulta e registra (ou retira) o consentimento para os convites de retorno. Ele só fala com a API do DentalBOT pelo servidor: o token nunca chega ao navegador. O acesso é por uma senha da equipe, com sessão de 12 h num cookie assinado.

Com a API rodando (`pnpm dev`), crie `panel/.env.local`:

```bash
DENTALBOT_API_URL=http://localhost:3000
ADMIN_API_TOKEN=...            # o mesmo da API
PANEL_PASSWORD=...             # senha da equipe
PANEL_SESSION_SECRET=...       # openssl rand -hex 32
```

e rode `pnpm --filter @dentalbot/panel dev`. O painel abre em http://localhost:3001.

## Cadastro da clínica

Em "Clínica", no painel, a equipe cadastra tudo o que o bot oferece:

- dados da clínica (nome e endereço);
- dentistas, com CRO, e os horários de atendimento de cada dia da semana (manhã e tarde);
- procedimentos, com duração e preço particular em reais (sem preço, o bot diz que o valor sai depois da avaliação). Procedimento inativo some do bot e continua no histórico;
- convênios (Odontoprev), com os procedimentos que cada um cobre e os que pedem autorização prévia. O atendente com IA só diz que algo é coberto quando está marcado ali; sem tabela cadastrada, diz que a recepção confirma;
- bloqueios de agenda (férias, feriados, compromissos), em dias inteiros ou em parte de um dia. Consultas já marcadas no período não são canceladas: o painel avisa quantas são para a recepção remarcar.

O topo da página lista o que ainda falta para o bot conseguir marcar consultas. Numa instalação nova, basta escolher um id em `DEFAULT_CLINIC_ID` (por exemplo `clinica`): a clínica é criada no primeiro "Salvar dados". As alterações valem na hora para as próximas conversas.

## Dados do paciente (LGPD)

O paciente pede acesso ou exclusão escrevendo MEUS DADOS no WhatsApp, ou por outro canal. Os pedidos aparecem no painel em "Dados (LGPD)", onde a recepção:

- baixa a cópia dos dados em JSON (cadastro, consentimentos, consultas, lista de espera, autorizações de convênio, notas da pesquisa de satisfação, orçamentos, pagamentos e conversas, com CPF e celular completos) para entregar ao próprio paciente;
- anonimiza: apaga nome, celular, CPF, nascimento, carteirinha, observações dos orçamentos e o texto das mensagens, e cancela as consultas futuras e a lista de espera. Orçamentos, parcelas e pagamentos ficam, sem identificar a pessoa, porque a clínica precisa guardá-los. Com parcela em aberto a anonimização é recusada até a quitação ou o cancelamento da cobrança. O cliente no Asaas não é apagado: isso é feito no painel do Asaas.

A exportação e a anonimização ficam no log só com os ids. O prazo da LGPD para a resposta completa é de 15 dias.

## Produção (VPS)

`deploy/compose.yml` sobe a pilha inteira com HTTPS automático (Caddy), API, painel, Postgres, Redis e backup diário criptografado. Só as portas 80 e 443 ficam abertas, e a API da equipe (`/admin/*`) não é exposta. Passo a passo em [`docs/deploy-vps.md`](docs/deploy-vps.md).

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
| `deploy/`                | Produção na VPS: compose, Caddy (HTTPS) e backup                           |
| `docs/`                  | Contas pendentes, instalação na VPS e decisões                             |

## O que depende de contas externas

Veja [docs/contas-pendentes.md](docs/contas-pendentes.md).

## Plano

O plano completo (escopo, arquitetura, LGPD, custos e roadmap) está no documento "DentalBOT · Plano de Implementação" do projeto.
