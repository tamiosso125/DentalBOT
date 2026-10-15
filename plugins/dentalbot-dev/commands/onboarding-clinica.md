---
description: Guia a configuração da clínica (dados, dentistas, procedimentos, convênios, contas)
---

Conduza em pt-BR o onboarding da clínica, um passo por vez, conferindo o que já existe no banco (`prisma/seed.ts` mostra o formato):

1. Dados da clínica: nome, endereço, horários, política de privacidade.
2. Dentistas (nome, CRO) e horários de atendimento.
3. Procedimentos com duração e preço particular.
4. Convênio Odontoprev: procedimentos cobertos e os que exigem autorização prévia.
5. Contas externas, em ordem: VPS Hostinger KVM 2, Asaas (CNPJ), Meta Business verificada e número em coexistência. Para cada uma, diga quais variáveis do `.env.example` passam a ser preenchidas.
6. Templates a submeter à Meta (`src/whatsapp/templates.ts`).
   Nunca peça para colar segredos no chat: eles vão direto no `.env` da VPS.
