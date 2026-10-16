---
name: orcamentos-cobranca
description: Use ao mexer em orçamentos, PDF do orçamento, itens, parcelas, Pix, boleto, cartão, integração e webhooks do Asaas ou textos de cobrança (src/quotes, src/payments, modelos Quote, QuoteItem, Installment).
---

# Orçamentos e cobrança

## Modelo

- `Quote` (DRAFT → SENT → ACCEPTED/REJECTED/EXPIRED) com `QuoteItem` (`coverage`: PRIVATE ou INSURANCE) e `Installment` (PENDING → BILLED → PAID/OVERDUE/CANCELLED).
- Valores sempre em **centavos inteiros** (`*Cents`). A conversão para reais acontece só em `src/payments/asaas.ts` (`centsToReais`).
- Itens cobertos pela Odontoprev entram como `INSURANCE` e não geram cobrança; autorização prévia é feita pela recepção no portal da operadora.

## Fluxo do orçamento (`src/quotes/`)

- `QuoteService.create` valida com Zod (`newQuoteSchema`) e checa clínica, dentista, paciente e procedimento. Preço vem da tabela (`Procedure.priceCents`) ou da dentista; item `INSURANCE` custa 0 e fica fora do total.
- `send`: dentro da janela de 24 h manda o PDF (`document`, upload em `/media`) e os botões; fora dela só o template `orcamento_disponivel`, com payloads `quote:<id>:view` e `handoff`.
- Botões `quote:<id>:view|accept|reject` (`detectIntent`) chegam a `handleAction`, que só atende o próprio paciente do orçamento (os outros recebem "não encontrei"). Funcionam mesmo com o bot pausado pela recepção.
- `respond` só muda orçamento `SENT` (update condicional): toque duplo ou concorrente não grava duas vezes. Aceite cria as parcelas (`installmentPlan`: 1ª em hoje + 3 dias, depois mensais; resto dos centavos na 1ª) ; vencido vira `EXPIRED` e vai para a recepção.
- Depois do aceite, `QuoteBillingService` (`quote-billing.ts`) cria o cliente Asaas (CPF do paciente, `externalReference = Patient.id`) e uma cobrança por parcela (`billingType: UNDEFINED`, o paciente escolhe Pix, boleto ou cartão na fatura), marca a parcela `BILLED` e o bot manda o link da 1ª parcela. Antes de criar, procura por `externalReference` (retomada após falha não cobra duas vezes). A descrição é só `Parcela N/M - <clínica>`: nome de procedimento é dado de saúde e não vai para o Asaas.
- Sem CPF no cadastro, com Asaas fora do ar ou orçamento só de convênio: a aprovação fica registrada, o paciente recebe aviso sem link e a recepção é chamada (handoff `quote:accepted:*`).
- Lembrete das parcelas 2 em diante: `InstallmentReminders` (`src/payments/installment-reminders.ts`) roda de hora em hora no processo da API (`INSTALLMENT_REMINDER_INTERVAL_MINUTES`, 0 desliga), pega parcelas `BILLED` que vencem nos próximos `INSTALLMENT_REMINDER_DAYS` dias no fuso da clínica, só entre 9h e 19h, reserva com `Installment.reminderSentAt` (update condicional, um lembrete por parcela) e manda o template `cobranca_parcela` com o link atual do Asaas. Já paga no Asaas: não manda. Falha no envio: libera para a próxima rodada.
- Orçamento sem resposta: `QuoteFollowUps` (`src/quotes/quote-follow-up.ts`, `QUOTE_FOLLOW_UP_INTERVAL_MINUTES`) manda uma vez o template `lembrete_orcamento` (payloads `quote:<id>:view` e `handoff`) `QUOTE_REMINDER_DAYS` dias depois do envio, entre 9h e 19h, reservando com `Quote.reminderSentAt`; espera se o bot está pausado. Depois de `validUntil` (no fuso da clínica) o orçamento `SENT` vira `EXPIRED`. O painel lê `GET /admin/quotes/follow-up` (esperando resposta e aceite do mês).
- Parcela vencida: `OverdueNotices` (`src/payments/overdue-notices.ts`, roda junto com os lembretes) manda uma vez o template `parcela_vencida` (link do Asaas, botão `handoff`) `OVERDUE_NOTICE_DAYS` dia(s) depois do vencimento, até 30 dias, entre 9h e 19h, reservando com `Installment.overdueNoticeAt`; consulta o Asaas antes (paga: não manda) e espera se o bot está pausado. Com 7 dias ou mais de atraso a parcela entra no filtro `ligar` do painel e no aviso da página inicial.

## Asaas

- `PaymentsGateway` é a interface. `AsaasHttpGateway` (sandbox `https://api-sandbox.asaas.com/v3` ou produção `https://api.asaas.com/v3`, header `access_token`) e `MockPaymentsGateway` (sem conta).
- `ASAAS_ENV=mock` enquanto a conta não existe. Com a conta: `sandbox` para testes, `production` no piloto.
- Cada parcela vira uma cobrança Asaas com `externalReference = Installment.id`; o id `pay_...` vai em `Installment.asaasPaymentId`.
- Cliente Asaas criado com `notificationDisabled: true`: quem avisa o paciente é o bot, pelo WhatsApp.

## Webhook (`POST /webhooks/asaas`)

- Autenticado pelo header `asaas-access-token` igual a `ASAAS_WEBHOOK_TOKEN` (comparação em tempo constante).
- Idempotente por `event.id` (tabela `PaymentEvent`); o Asaas pode reenviar.
- A parcela é achada pelo `asaasPaymentId` ou pelo `externalReference` (id da parcela), caso o pagamento chegue antes de gravarmos o id.
- `PAYMENT_RECEIVED` e `PAYMENT_CONFIRMED` marcam a parcela como paga; `PAYMENT_OVERDUE` marca como vencida (nunca uma já paga).
- O handler roda na fila; a rota só valida e enfileira.

## Textos de cobrança

- Tom neutro, sem constrangimento, sem ameaça; nunca expor valor em grupo ou para terceiros.
- Lembrete de parcela fora da janela de 24 h usa o template `cobranca_parcela` (utility).
- Desconto e parcelamento só dentro das regras cadastradas pela clínica; o modelo de IA nunca inventa valor (preço vem de ferramenta).

## Quando a conta Asaas existir

1. Abrir a conta com o CNPJ e gerar a chave de API (primeiro no sandbox).
2. Preencher `ASAAS_API_KEY`, mudar `ASAAS_ENV=sandbox`.
3. Cadastrar o webhook `https://<domínio>/webhooks/asaas` com o token de `ASAAS_WEBHOOK_TOKEN`, eventos de cobrança.
4. Confirmar as taxas por Pix, boleto e cartão na tabela do Asaas.
