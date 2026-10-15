---
name: lgpd-saude
description: Use ao tocar dados de paciente, consentimento, logs, retenção, criptografia ou pedidos do titular (LGPD art. 11, dados de saúde). Obrigatória em mudanças de src/privacy, prisma/schema.prisma e logs.
---

# LGPD para dados de saúde no DentalBOT

Dados de saúde são sensíveis (LGPD art. 11). O padrão é coletar o mínimo e proteger tudo.

## Checklist para qualquer mudança

- [ ] **Base legal**: agenda e atendimento usam tutela da saúde (art. 11, II, f). Recall, promoções e NPS exigem consentimento específico (art. 11, I) registrado em `Consent` com `textVersion`.
- [ ] **Minimização**: o campo novo é necessário? Sintomas só na triagem, com opções fechadas. Nada de foto, raio-X ou laudo no chat por padrão.
- [ ] **Criptografia**: telefone, CPF, carteirinha e corpo de mensagem são gravados com `FieldCipher.encrypt()` e buscados por `FieldCipher.hash()` (colunas `*Encrypted` + `*Hash`). Coluna nova com dado pessoal segue o mesmo padrão.
- [ ] **Logs**: só ids. O logger (`src/lib/logger.ts`) aplica `redact()`, mas não conte com isso: não passe objetos de paciente ou payloads para o log. Mensagens de erro de integrações não podem ecoar telefone ou CPF.
- [ ] **Código e testes**: só dados fictícios (CPF 529.982.247-25, celular 55 11 90000-XXXX). O hook do plugin bloqueia CPF e celular reais.
- [ ] **Retenção**: conversas de atendimento por 5 anos (default a validar com o jurídico); dados de marketing apagados quando o consentimento é revogado.
- [ ] **Operadores**: dado novo enviado a terceiro (Meta, Anthropic, Asaas, hospedagem) precisa estar coberto por contrato de operador.

## Comandos do paciente

- `PARAR`: grava `Conversation.marketingOptOutAt`; lembretes de consulta e cobrança continuam (são do atendimento).
- `MEUS DADOS`: cria `DataSubjectRequest`; a equipe responde pelo painel em "Dados (LGPD)" (`src/panel/patient-data.ts`): cópia em JSON e anonimização. A anonimização mantém orçamentos e parcelas (obrigação legal) e é recusada com parcela em aberto. Campo pessoal novo precisa entrar na exportação e na anonimização, com teste em `tests/integration/prisma-patient-data.test.ts`.

## Prontuário

O DentalBOT não é prontuário. O bot guarda só o histórico da conversa. Prontuário (CFO 91/2009) fica fora do bot.

## Incidente

Plano de resposta documentado; comunicação à ANPD e aos titulares em até 3 dias úteis (Res. CD/ANPD 15/2024).

## Antes do go-live

Advogado ou DPO revisa política de privacidade, RIPD e textos de consentimento (`src/conversation/messages.ts`).
