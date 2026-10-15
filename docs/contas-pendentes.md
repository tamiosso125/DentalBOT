# Contas pendentes e o que cada uma destrava

O código da Fase 1 roda inteiro sem nenhuma conta externa. Cada conta abaixo troca um mock por um serviço real, sem mudar código: só variáveis de ambiente.

| Conta                                             | Enquanto não existe                                                                                                      | O que muda quando existir                                                                                                                      | Variáveis                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| VPS Hostinger KVM 2                               | Roda local (`docker compose up -d` + `pnpm dev`)                                                                         | Deploy com `docker compose -f deploy/compose.yml up -d --build`: HTTPS no domínio, painel e backup diário criptografado (`docs/deploy-vps.md`) | `DATABASE_URL`, `REDIS_URL`, `QUEUE_MODE=redis`                                                     |
| Asaas (CNPJ)                                      | `ASAAS_ENV=mock`: cobranças simuladas em memória                                                                         | `ASAAS_ENV=sandbox` para testar, `production` no piloto; webhook cadastrado em `/webhooks/asaas`                                               | `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`                                                              |
| Meta Business verificada + número em coexistência | `WHATSAPP_MODE=sandbox`: mensagens ficam em `GET /dev/sandbox/outbox`; MCP `whatsapp-sandbox` simula paciente e recepção | `WHATSAPP_MODE=cloud`, webhook cadastrado em `/webhooks/whatsapp` (campos `messages` e `smb_message_echoes`), templates submetidos             | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` |
| Anthropic (API)                                   | `AI_MODE=off`: menu e regras fixas; testes e `pnpm eval` usam um modelo roteirizado                                      | `AI_MODE=anthropic`: roteador (Haiku 5.5) + atendente (Sonnet 5.5) agendam pela conversa; `pnpm eval --live` testa com o modelo real           | `AI_MODE`, `ANTHROPIC_API_KEY`, `AI_ATTENDANT_EFFORT`                                               |

## Ordem sugerida

1. **VPS**: precisa existir antes da Meta, porque o webhook exige uma URL pública com HTTPS.
2. **Asaas**: abrir com o CNPJ e já gerar a chave do sandbox; dá para testar cobranças antes da Meta.
3. **Anthropic**: criar a chave da API (console.anthropic.com) e rodar `pnpm eval --live` antes de ligar `AI_MODE=anthropic`. Pode ser feita a qualquer momento.
4. **Meta Business**: verificar o CNPJ, conectar o número atual em coexistência e submeter os 6 templates de `src/whatsapp/templates.ts` (confirmação, lembrete, orçamento, cobrança e vaga da lista de espera como utilidade; convite de retorno como marketing).

## Cuidados de LGPD ao contratar

- VPS: escolher datacenter no Brasil; se não houver, o contrato precisa cobrir transferência internacional.
- Meta, Anthropic, Asaas e Hostinger são operadores: guardar os termos/DPA de cada um.
