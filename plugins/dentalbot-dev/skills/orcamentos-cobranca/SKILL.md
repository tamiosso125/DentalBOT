---
name: orcamentos-cobranca
description: Use ao mexer em orçamentos, itens, parcelas, Pix, boleto, cartão, integração e webhooks do Asaas ou textos de cobrança (src/payments, modelos Quote, QuoteItem, Installment).
---

# Orçamentos e cobrança

## Modelo

- `Quote` (DRAFT → SENT → ACCEPTED/REJECTED/EXPIRED) com `QuoteItem` (`coverage`: PRIVATE ou INSURANCE) e `Installment` (PENDING → BILLED → PAID/OVERDUE/CANCELLED).
- Valores sempre em **centavos inteiros** (`*Cents`). A conversão para reais acontece só em `src/payments/asaas.ts` (`centsToReais`).
- Itens cobertos pela Odontoprev entram como `INSURANCE` e não geram cobrança; autorização prévia é feita pela recepção no portal da operadora.

## Asaas

- `PaymentsGateway` é a interface. `AsaasHttpGateway` (sandbox `https://api-sandbox.asaas.com/v3` ou produção `https://api.asaas.com/v3`, header `access_token`) e `MockPaymentsGateway` (sem conta).
- `ASAAS_ENV=mock` enquanto a conta não existe. Com a conta: `sandbox` para testes, `production` no piloto.
- Cada parcela vira uma cobrança Asaas com `externalReference = Installment.id`; o id `pay_...` vai em `Installment.asaasPaymentId`.
- Cliente Asaas criado com `notificationDisabled: true`: quem avisa o paciente é o bot, pelo WhatsApp.

## Webhook (`POST /webhooks/asaas`)

- Autenticado pelo header `asaas-access-token` igual a `ASAAS_WEBHOOK_TOKEN` (comparação em tempo constante).
- Idempotente por `event.id` (tabela `PaymentEvent`); o Asaas pode reenviar.
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
