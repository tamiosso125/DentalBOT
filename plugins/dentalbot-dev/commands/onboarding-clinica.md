---
description: Guia a configuração da clínica (dados, dentistas, procedimentos, convênios, contas)
---

Conduza em pt-BR o onboarding da clínica, um passo por vez, conferindo o que já existe no banco (`prisma/seed.ts` mostra o formato):

1. Dados da clínica (nome, endereço), dentistas (nome, CRO), horários de atendimento, procedimentos com duração e preço particular e bloqueios de agenda: a equipe cadastra em "Clínica", no painel. Confira com ela o que a página ainda lista como pendente. Defina também a política de privacidade (`PRIVACY_POLICY_URL`).
2. Convênio Odontoprev: a equipe marca em "Clínica" > convênio os procedimentos cobertos e os que exigem autorização prévia, conferindo com a tabela do contrato.
3. Contas externas, em ordem: VPS Hostinger KVM 2, Asaas (CNPJ), Meta Business verificada e número em coexistência. Para cada uma, diga quais variáveis do `.env.example` passam a ser preenchidas.
4. Templates a submeter à Meta (`src/whatsapp/templates.ts`).
   Nunca peça para colar segredos no chat: eles vão direto no `.env` da VPS.
