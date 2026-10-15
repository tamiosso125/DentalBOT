---
name: whatsapp-cloud-api
description: Use ao mexer no webhook do WhatsApp, envio de mensagens, botões, mídia, status de entrega ou coexistência com o app WhatsApp Business (src/whatsapp, src/http/server.ts).
---

# WhatsApp Cloud API no DentalBOT

## Onde fica cada coisa

- `src/whatsapp/signature.ts`: valida `X-Hub-Signature-256` (HMAC-SHA256 do corpo cru com o App Secret).
- `src/whatsapp/webhook-schema.ts`: schema Zod do payload e `normalizeWebhook()`, que vira eventos internos `inbound`, `echo` e `status`.
- `src/whatsapp/channel.ts`: interface `WhatsAppChannel`. `CloudApiChannel` fala com a Meta; `SandboxChannel` guarda em memória.
- `src/whatsapp/fake-payloads.ts`: payloads falsos no formato real (testes, eval e MCP `whatsapp-sandbox`).
- `src/http/server.ts`: rotas `GET/POST /webhooks/whatsapp`.

## Regras

1. O webhook só valida a assinatura, faz o parse e enfileira. Responder 200 em menos de 5 s; todo o processamento acontece no worker (`src/conversation/handler.ts`).
2. A assinatura é calculada sobre os bytes recebidos (`req.rawBody`), nunca sobre `JSON.stringify(req.body)`.
3. Payload desconhecido recebe 200 e um log sem conteúdo: a Meta reenviaria o mesmo payload para sempre.
4. A Meta reentrega webhooks. Tudo é idempotente por `waMessageId` (`jobId` na fila + `hasMessage` + unique no banco).
5. Fora da janela de 24 h desde a última mensagem do paciente, só template aprovado (skill `whatsapp-templates`, arquivo `src/whatsapp/templates.ts`).
6. Botões de resposta: no máximo 3, título com até 20 caracteres. Use ids estáveis (`menu:agendar`, `handoff`).
7. Nunca logue `from`, `to`, `text` ou o payload inteiro; o logger já passa tudo por `redact()`, mas prefira logar ids.

## Coexistência (mesmo número no app e na API)

- Mensagens que a recepção manda pelo app chegam como `smb_message_echoes` (`value.message_echoes[]`). O handler trata como `echo` e pausa o bot por `HANDOFF_PAUSE_MINUTES`.
- Mensagens enviadas pelo app não são cobradas pela Meta.
- O app precisa ser aberto ao menos a cada 13 dias; não desinstalar. WhatsApp para Windows deixa de ser suportado.
- Sinal de alarme (urgência) é respondido mesmo com o bot pausado.

## Sem conta Meta (agora)

- `WHATSAPP_MODE=sandbox`: nada sai para a Meta; a saída fica em `GET /dev/sandbox/outbox`.
- Para conversar com o bot no Claude Code, use o MCP `whatsapp-sandbox` (`send_patient_message`, `reception_reply`, `get_outbox`).

## Quando a conta Meta existir

1. Meta Business verificada com o CNPJ; app do tipo Business com o produto WhatsApp.
2. Conectar o número atual em coexistência (Embedded Signup ou fluxo do BSP) e anotar o `phone_number_id`.
3. Gerar token de usuário do sistema (permanente) com `whatsapp_business_messaging` e `whatsapp_business_management`.
4. Cadastrar o webhook `https://<domínio>/webhooks/whatsapp` com o `WHATSAPP_VERIFY_TOKEN`, assinando os campos `messages` e `smb_message_echoes`.
5. Preencher `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, mudar `WHATSAPP_MODE=cloud` e gravar o `phone_number_id` em `Clinic.whatsappPhoneNumberId`.

## Erros comuns da Cloud API

- 131047: fora da janela de 24 h, mande template.
- 131026: número sem WhatsApp ou não alcançável.
- 132000/132001: parâmetros do template não batem ou template não aprovado nesse idioma.
- 130429/131056: limite de envio; a fila reprocessa com backoff.
