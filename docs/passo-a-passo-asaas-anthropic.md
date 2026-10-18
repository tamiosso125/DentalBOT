# Passo a passo: Asaas e Anthropic

Para quem vai abrir as contas (normalmente o dono da clínica, com o CNPJ à mão). As duas podem ser feitas antes da Meta e não dependem uma da outra. Pelo mesmo motivo do passo a passo da Meta, a VPS (`docs/passo-a-passo-vps-meta.md`, parte 1) precisa estar no ar antes de cadastrar o webhook do Asaas, porque ele exige um endereço HTTPS público.

As telas mudam com frequência. Os nomes abaixo são os de hoje; se algo estiver em outro lugar, procure pelo nome do item na busca do painel.

## Parte 1: Asaas (cobrança)

O Asaas emite as cobranças das parcelas do orçamento aprovado (Pix, boleto e cartão) e avisa o bot, pelo webhook, quando uma parcela é paga ou vence. Não há mensalidade fixa: paga-se uma taxa por cobrança liquidada. Confira a tabela atual no site do Asaas antes de combinar valores com os pacientes.

### 1.1 Conta de produção (com o CNPJ)

1. Abra a conta em asaas.com como pessoa jurídica, com o CNPJ da clínica e os dados do responsável.
2. Envie os documentos que o Asaas pedir (contrato social ou certificado MEI, documento e selfie do responsável, comprovante bancário). A análise pode levar alguns dias úteis.
3. Cadastre a conta bancária da clínica para receber os repasses.

### 1.2 Conta de testes (sandbox), pode ser hoje

1. Crie a conta no ambiente de testes em sandbox.asaas.com. Ela é separada da produção e não movimenta dinheiro.
2. Em Integrações > Chave de API, gere a chave de sandbox. Vira `ASAAS_API_KEY`.

### 1.3 Webhook

No Asaas, em Integrações > Webhooks, crie um webhook de cobranças:

1. URL: `https://atendimento.suaclinica.com.br/webhooks/asaas`.
2. Token de autenticação: um valor secreto de pelo menos 16 caracteres (por exemplo, `openssl rand -hex 24`). Ele vira `ASAAS_WEBHOOK_TOKEN` e o Asaas o envia no cabeçalho `asaas-access-token`; o bot recusa chamadas sem ele.
3. Marque os eventos de cobrança: `PAYMENT_RECEIVED`, `PAYMENT_CONFIRMED` e `PAYMENT_OVERDUE`.
   O bot responde 200 na hora e processa o evento depois; repetições do mesmo evento são ignoradas.

### 1.4 Ligar o bot

Na VPS, em `deploy/.env`, primeiro o sandbox:

```bash
ASAAS_ENV=sandbox
ASAAS_API_KEY=...        # chave de sandbox
ASAAS_WEBHOOK_TOKEN=...  # o mesmo cadastrado no webhook
```

Depois `docker compose -f deploy/compose.yml up -d`. Crie um orçamento de teste pelo painel, aprove pelo WhatsApp e confira, no painel do sandbox, que as parcelas foram criadas. Pague uma parcela pelo botão de simulação do sandbox e veja a baixa chegar ao painel do DentalBOT.

Quando a conta de produção for aprovada, gere a chave de produção, cadastre o webhook de novo no ambiente de produção (o token e a URL são cadastrados separadamente) e troque para `ASAAS_ENV=production` com a nova `ASAAS_API_KEY`. Comece o piloto com poucos pacientes e valores baixos.

## Parte 2: Anthropic (inteligência do atendente)

A chave da API liga o roteador (Haiku 5.5) e o atendente (Sonnet 5.5), que conversam e agendam. Sem ela, o bot responde só com menu e regras fixas.

### 2.1 Conta e chave

1. Crie a conta em console.anthropic.com com o e-mail da clínica e confirme o e-mail.
2. Em Billing, adicione um cartão e um crédito inicial. Defina um **limite mensal de gasto** baixo no começo, para o piloto não ter surpresa.
3. Em API Keys, crie uma chave só para este projeto (por exemplo, "dentalbot-producao"). Ela aparece uma única vez; copie na hora para o gerenciador de senhas. Vira `ANTHROPIC_API_KEY`.
4. Guarde os termos de uso e o DPA da Anthropic: ela é operadora dos dados das conversas (LGPD).

### 2.2 Testar antes de ligar

No seu computador, com a chave só na sessão do terminal (nunca em arquivo versionado):

```bash
ANTHROPIC_API_KEY=... pnpm eval --live
```

Isso roda os casos de `tests/conversations/` com o modelo real. Todos os casos marcados como críticos precisam passar. Anote o consumo mostrado no painel da Anthropic depois da rodada: é a primeira medida real de custo por conversa.

### 2.3 Ligar o bot

Na VPS, em `deploy/.env`:

```bash
AI_MODE=anthropic
ANTHROPIC_API_KEY=...
AI_ATTENDANT_EFFORT=medium   # low, medium ou high; mais alto custa mais e demora mais
```

Depois `docker compose -f deploy/compose.yml up -d`. Converse com o bot de um celular da equipe e peça para agendar. Confira que os horários oferecidos vêm da agenda e que perguntas clínicas vão para a recepção.

Para desligar a qualquer momento, volte `AI_MODE=off`: o menu e as regras fixas assumem sem mudar nada no código.

## Ordem sugerida

1. Criar a conta sandbox do Asaas e a chave de API da Anthropic (menos de 1 hora, sem dependências).
2. Pedir a conta de produção do Asaas (o relógio da análise começa aqui).
3. Rodar `pnpm eval --live`.
4. Com a VPS no ar, cadastrar o webhook do Asaas e ligar `ASAAS_ENV=sandbox` e `AI_MODE=anthropic`.
5. Quando o Asaas liberar a produção: trocar a chave e o webhook e fazer o teste de `docs/roteiro-piloto.md`.
