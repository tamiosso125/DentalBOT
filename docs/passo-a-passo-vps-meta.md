# Passo a passo: VPS e Meta (WhatsApp)

Para quem vai abrir as contas (normalmente o dono da clínica, com o CNPJ à mão). A VPS vem primeiro porque o webhook da Meta exige um endereço HTTPS público. A Meta é a etapa mais demorada (verificação do CNPJ e aprovação dos templates levam dias), então comece as duas no mesmo dia.

As telas da Meta mudam com frequência. Os nomes abaixo são os de hoje; se algo estiver em outro lugar, procure pelo nome do item na busca do painel da Meta.

## Parte 1: VPS (cerca de 1 hora de trabalho)

Antes de começar, tenha: um domínio da clínica (ou um novo) com acesso ao DNS, e um cartão para pagar a VPS.

1. Contrate a VPS (Hostinger KVM 2, Ubuntu 24.04, datacenter no Brasil). Cadastre a sua chave SSH.
2. No DNS, crie um registro **A** `atendimento.suaclinica.com.br` apontando para o IP da VPS.
3. Siga `docs/deploy-vps.md` do passo 2 ao 5 (preparar o servidor, chave do backup, `deploy/.env`, subir). Deixe `WHATSAPP_MODE=sandbox`, `ASAAS_ENV=mock` e `AI_MODE=off` por enquanto.
4. Confira: `https://atendimento.suaclinica.com.br/health` responde `{"status":"ok"}` e o painel abre.
5. Guarde num gerenciador de senhas: a chave privada do backup, `PII_ENCRYPTION_KEY`, `PII_HASH_SECRET` e `deploy/.env`. Sem as chaves, dado e backup não abrem.

Pronto: a VPS está no ar e a Meta já tem onde chamar.

## Parte 2: Meta Business e WhatsApp

### 2.1 Conta e verificação do CNPJ (começa agora, leva dias)

1. Crie (ou use) o **Meta Business Portfolio** da clínica em business.facebook.com, com um e-mail da clínica.
2. Em Configurações > Centro de Segurança, inicie a **Verificação da empresa** com o CNPJ: razão social, endereço e telefone iguais ao cartão CNPJ, e um documento ou e-mail do domínio da clínica. A análise pode levar de 2 a 10 dias úteis.
3. Crie um **app** em developers.facebook.com (tipo Empresa) ligado a esse portfólio e adicione o produto **WhatsApp**.

### 2.2 Conectar o número atual (coexistência)

A coexistência deixa o mesmo número no aplicativo WhatsApp Business (a recepção continua respondendo pelo celular) e na API (o bot). Exige o aplicativo atualizado.

1. No painel do app, em WhatsApp > Configuração da API, escolha adicionar um número e siga o fluxo de **Cadastro incorporado** para conectar um número que já usa o aplicativo WhatsApp Business. Ele mostra um QR code para ler no aplicativo da clínica.
2. Confirme o nome de exibição da clínica. Ele passa por aprovação.
3. Anote o **Phone number ID** (vira `WHATSAPP_PHONE_NUMBER_ID`).
4. Observação importante: a coexistência tem limitações (por exemplo, algumas funções do aplicativo ficam restritas). Leia a tela de aviso antes de confirmar.

### 2.3 Chaves

1. Em Configurações da empresa > Usuários do sistema, crie um usuário do sistema e gere um **token permanente** com as permissões `whatsapp_business_messaging` e `whatsapp_business_management`. Vira `WHATSAPP_ACCESS_TOKEN`.
2. Em Configurações do app > Básico, copie o **App Secret**. Vira `WHATSAPP_APP_SECRET`.
3. `WHATSAPP_VERIFY_TOKEN` é o valor que você já gerou no `deploy/.env`.

### 2.4 Webhook

No app, em WhatsApp > Configuração > Webhook:

1. URL de retorno: `https://atendimento.suaclinica.com.br/webhooks/whatsapp`. Token de verificação: o `WHATSAPP_VERIFY_TOKEN`.
2. Assine os campos **`messages`** e **`smb_message_echoes`** (este avisa o bot quando a recepção responde pelo aplicativo, e o bot pausa naquela conversa).

### 2.5 Templates (aprovação em horas ou dias)

Em Gerenciador do WhatsApp > Modelos de mensagem, crie os 14 templates de `src/whatsapp/templates.ts` com **exatamente** o nome, o idioma `pt_BR`, o texto, as variáveis e os botões do arquivo. Treze são categoria **Utilidade** e `convite_retorno` é **Marketing**. Se a Meta recategorizar algum, o custo muda, mas o fluxo funciona. Se reprovar, ajuste o texto no arquivo e no pedido, nunca só na Meta (a conversa e os testes leem o arquivo).

### 2.6 Ligar o bot ao número

Na VPS, em `deploy/.env`:

```bash
WHATSAPP_MODE=cloud
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_APP_SECRET=...
```

Depois `docker compose -f deploy/compose.yml up -d`. Mande "oi" de um celular da equipe para o número da clínica e confira a resposta. Siga então o teste combinado de `docs/roteiro-piloto.md`.

## Ordem sugerida do dia 1

1. Contratar a VPS e criar o registro DNS.
2. Pedir a verificação do CNPJ na Meta (o relógio começa aqui).
3. Subir a pilha na VPS com os modos de teste.
4. Criar o app, o usuário do sistema e os 14 templates enquanto a verificação corre.
5. Quando a Meta liberar: conectar o número, cadastrar o webhook e mudar para `WHATSAPP_MODE=cloud`.
