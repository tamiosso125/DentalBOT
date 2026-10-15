# Instalação na VPS

Passo a passo para subir o DentalBOT numa VPS (plano previsto: Hostinger KVM 2, Ubuntu 24.04). Tudo roda em containers definidos em `deploy/compose.yml`:

| Serviço    | O que faz                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `caddy`    | Única porta aberta (80 e 443). Tira o certificado HTTPS sozinho. Manda `/webhooks/*` e `/health` para a API e o resto para o painel. |
| `api`      | Bot, webhooks da Meta e do Asaas, lembretes. Aplica as migrations do banco ao iniciar.                                               |
| `panel`    | Painel da equipe. Fala com a API pela rede interna: a API da equipe (`/admin/*`) nunca fica exposta na internet.                     |
| `postgres` | Banco de dados, num volume do Docker.                                                                                                |
| `redis`    | Fila das mensagens.                                                                                                                  |
| `backup`   | Cópia criptografada do banco todo dia, guardada 14 dias. Opcionalmente enviada para fora da VPS.                                     |

## 1. Contratar a VPS e apontar o domínio

1. Contrate a VPS com datacenter no Brasil (LGPD) e Ubuntu 24.04. Cadastre a sua chave SSH em vez de senha.
2. Escolha um endereço, por exemplo `atendimento.suaclinica.com.br`, e crie no DNS do domínio um registro **A** apontando para o IP da VPS. O HTTPS só funciona depois que o DNS propagar.

## 2. Preparar o servidor

Entre por SSH e rode:

```bash
apt update && apt upgrade -y
# Firewall: só SSH e HTTPS
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
# Docker
curl -fsSL https://get.docker.com | sh
# Código
git clone https://github.com/tamiosso125/DentalBOT.git /opt/dentalbot
cd /opt/dentalbot
```

## 3. Gerar a chave do backup (no seu computador, não na VPS)

O backup é criptografado com [age](https://github.com/FiloSottile/age). A chave privada fica com você; a VPS só recebe a pública. Assim, quem roubar um backup não consegue ler.

```bash
age-keygen -o dentalbot-backup.key   # mostra "Public key: age1..."
```

Guarde `dentalbot-backup.key` em dois lugares seguros (por exemplo, gerenciador de senhas e um pendrive). Sem ela não dá para restaurar.

## 4. Criar o `deploy/.env`

Na VPS, crie `/opt/dentalbot/deploy/.env` (ele não vai para o Git). Gere cada segredo com o comando indicado.

```bash
DOMAIN=atendimento.suaclinica.com.br

# Banco e chaves dos dados pessoais
POSTGRES_PASSWORD=          # openssl rand -hex 24
PII_ENCRYPTION_KEY=         # openssl rand -base64 32
PII_HASH_SECRET=            # openssl rand -hex 32

# Painel da equipe
ADMIN_API_TOKEN=            # openssl rand -hex 32
PANEL_PASSWORD=             # senha que a recepção vai usar
PANEL_SESSION_SECRET=       # openssl rand -hex 32
DEFAULT_CLINIC_ID=          # id da clínica cadastrada no banco

# WhatsApp (sandbox até a Meta liberar o número)
WHATSAPP_MODE=sandbox
WHATSAPP_VERIFY_TOKEN=      # openssl rand -hex 16
WHATSAPP_APP_SECRET=        # da Meta; enquanto isso, openssl rand -hex 16
# WHATSAPP_ACCESS_TOKEN=, WHATSAPP_PHONE_NUMBER_ID=  (quando WHATSAPP_MODE=cloud)

# Asaas (mock até a conta existir)
ASAAS_ENV=mock
ASAAS_WEBHOOK_TOKEN=        # openssl rand -hex 16
# ASAAS_API_KEY=            (quando ASAAS_ENV=sandbox ou production)

# IA (desligada até existir a chave)
AI_MODE=off
# ANTHROPIC_API_KEY=

PRIVACY_POLICY_URL=https://suaclinica.com.br/privacidade

# Backup
BACKUP_AGE_RECIPIENT=age1...   # a chave pública do passo 3
BACKUP_HOUR_UTC=6              # 6 UTC = 3h em Brasília
BACKUP_KEEP_DAYS=14
# RCLONE_REMOTE=drive:dentalbot-backups   (opcional, passo 7)
```

Proteja o arquivo: `chmod 600 deploy/.env`.

**Atenção:** `PII_ENCRYPTION_KEY` e `PII_HASH_SECRET` abrem os dados criptografados do banco (telefone, CPF, mensagens). Guarde uma cópia junto com a chave do backup. Um backup restaurado sem elas fica ilegível, e trocar essas chaves depois perde os dados.

## 5. Subir

```bash
cd /opt/dentalbot
docker compose -f deploy/compose.yml up -d --build
docker compose -f deploy/compose.yml ps        # todos "Up", api e panel "healthy"
curl https://atendimento.suaclinica.com.br/health   # {"status":"ok"}
```

Abra `https://atendimento.suaclinica.com.br` no navegador e entre com a `PANEL_PASSWORD`.

O cadastro da clínica real (dados, dentista, horários, procedimentos e preços) entra no banco antes do piloto; o comando `/onboarding-clinica` do Claude Code conduz esse passo. O id criado vai em `DEFAULT_CLINIC_ID` (depois rode o `up -d` de novo).

## 6. Atualizar para uma versão nova

```bash
cd /opt/dentalbot
git pull
docker compose -f deploy/compose.yml up -d --build
```

As migrations do banco rodam sozinhas quando a API reinicia. Rode um backup antes de atualizar (próximo passo).

## 7. Backup e restauração

Rodar um backup na hora e ver os arquivos:

```bash
docker compose -f deploy/compose.yml exec backup backup.sh once
docker compose -f deploy/compose.yml exec backup ls -l /backups
```

**Cópia fora da VPS (recomendado).** Se a VPS se perder, os backups dela se perdem junto. Configure o [rclone](https://rclone.org/docs/) com um destino (Google Drive, Backblaze B2, S3), coloque o `rclone.conf` em `deploy/rclone/rclone.conf` e defina `RCLONE_REMOTE` no `.env`. Os arquivos já saem criptografados.

**Restaurar** (num servidor novo ou para conferir um backup):

```bash
# No seu computador: decifrar o backup com a chave privada
age -d -i dentalbot-backup.key dentalbot-AAAAMMDDTHHMMSSZ.dump.age > dentalbot.dump
# Na VPS, com a pilha no ar e o arquivo copiado para lá:
docker compose -f deploy/compose.yml exec -T postgres \
  pg_restore -U dentalbot -d dentalbot --clean --if-exists --no-owner < dentalbot.dump
rm dentalbot.dump
```

Teste uma restauração uma vez por mês: backup que nunca foi restaurado não é garantia.

## 8. Ligar os serviços externos

Quando cada conta existir, troque as variáveis no `deploy/.env` (tabela em `docs/contas-pendentes.md`) e rode `docker compose -f deploy/compose.yml up -d`. Os endereços a cadastrar:

- Meta: `https://SEU_DOMINIO/webhooks/whatsapp` com o `WHATSAPP_VERIFY_TOKEN`.
- Asaas: `https://SEU_DOMINIO/webhooks/asaas` com o `ASAAS_WEBHOOK_TOKEN`.

## Logs

```bash
docker compose -f deploy/compose.yml logs -f api
```

Os logs têm só ids, sem telefone, CPF ou texto de mensagem. O Caddy não grava log de acesso, porque a busca do painel pode levar o nome de um paciente na URL.
