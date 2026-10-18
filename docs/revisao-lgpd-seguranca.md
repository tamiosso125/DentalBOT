# Revisão de LGPD e segurança (Fase 1)

Revisão do conjunto antes do piloto: o que é gravado, o que é logado, o que é criptografado e quem pode o quê. Feita lendo o código e o esquema do banco; os pontos marcados com "ainda depende de você" não são código.

## O que é gravado e como

| Dado                                        | Onde                      | Como                                                                                         |
| ------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| Celular do paciente                         | `Patient`, `Conversation` | `phoneEncrypted` + `phoneHash` (busca e chave)                                               |
| CPF                                         | `Patient`                 | `cpfEncrypted` + `cpfHash`; nunca aparece na tela                                            |
| Carteirinha do convênio                     | `Patient`                 | `insuranceCardEncrypted`; a tela mostra só os 4 últimos                                      |
| Texto das mensagens                         | `Message`                 | `bodyEncrypted`; apagado na anonimização                                                     |
| Anamnese (todas as versões)                 | `MedicalHistory`          | `dataEncrypted`; o bot nunca lê                                                              |
| Evolução clínica e adendos                  | `ClinicalEntry`           | `dataEncrypted`; sem edição nem exclusão                                                     |
| Anotações da equipe                         | `PatientNote`             | `textEncrypted`; o bot nunca lê                                                              |
| Observação do orçamento                     | `Quote`                   | `notesEncrypted` (**corrigido nesta revisão**: era texto puro e pode descrever o tratamento) |
| E-mail dos logins, senha                    | `StaffUser`               | e-mail criptografado; senha só como hash scrypt                                              |
| Nome e data de nascimento                   | `Patient`                 | texto puro (identificação; some na anonimização)                                             |
| Consultas, procedimentos, valores, parcelas | várias                    | texto puro, sem dado de saúde livre                                                          |

Texto puro que sobra é dado da clínica (endereço, motivo de bloqueio de agenda, descrição de item de orçamento, textos de template), não do paciente. As chaves (`PII_ENCRYPTION_KEY` e `PII_HASH_SECRET`) ficam só no ambiente do servidor; sem elas o banco e os backups não revelam nada.

## O que é logado

- Todo log passa por `src/lib/logger.ts`, que aplica `redact()`: chaves sensíveis (cpf, phone, name, text, body, message, email, birthDate, address, token) são removidas e CPF, celular e e-mail dentro de textos e de mensagens de erro são mascarados.
- O código loga ids, nomes de campos alterados e códigos de erro, nunca valores.
- Registro de acessos (tabela `AccessLog`): cada rota que toca dado de paciente grava ação, data, hora, quem e qual paciente, sem conteúdo. Fica 365 dias por padrão (mínimo 180).

A agenda (`GET /admin/agenda`) mostra, para cada consulta que não foi cancelada, os alertas de saúde da anamnese atual (alergia, anticoagulante, coagulação, coração, gestação): só essas frases curtas, nunca o formulário. Por isso abrir a agenda entra no registro de acessos como `VIEW_AGENDA`.

## Quem pode o quê

Toda rota `/admin/*` exige o token Bearer, que só o painel (servidor Next.js) conhece; o navegador nunca fala com a API. O painel exige login por pessoa (cookie assinado, trava após 5 erros) e a API confere a cada pedido se o login ainda está ativo.

| Só a dentista                                                                 | Dentista e recepção                                                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Criar, desativar e redefinir senha de logins (`/equipe`)                      | Agenda, pacientes, ficha, pendências, orçamentos, cobranças, autorizações, lista de espera, retorno |
| Assinar evolução clínica e adendos                                            | Anamnese (preencher e ver), anotações, atestado, agenda do dia em PDF                               |
| **Ver "Acessos" e o "Resumo" do mês** (**novo**: antes a recepção também via) | Dados (LGPD): exportar e anonimizar, cadastro da clínica                                            |

Decisão que fica para a dentista: exportar e anonimizar dados e mexer no cadastro da clínica continuam abertos à recepção, porque são o dia a dia. Se preferir restringir, é uma linha por rota.

## Outros pontos conferidos

- Webhooks da Meta e do Asaas validam assinatura ou token, respondem 200 rápido e processam na fila, com idempotência.
- `/dev/sandbox/*` só existe com `WHATSAPP_MODE=sandbox`; em produção a rota não é registrada.
- A API `/admin/*` não é exposta pelo Caddy; só 80 e 443 ficam abertas na VPS.
- Dependências: o CI roda `pnpm audit --prod --audit-level=high`. Fastify e Next ficam em versões corrigidas; `postcss` e `yaml` têm piso no `pnpm.overrides`. Um aviso aceito: `deepmerge-ts` dentro do CLI do Prisma (só lê o arquivo de configuração da casa, sem entrada externa), registrado em `pnpm.auditConfig.ignoreGhsas`; reavaliar quando o Prisma atualizar.
- Mensagem iniciada pela clínica só sai por template; marketing exige consentimento e respeita `PARAR`.
- A guarda de saída do atendente bloqueia horário ou preço que nenhuma ferramenta devolveu, e intenção clínica vira atendimento humano.

## Ainda depende de você

1. **Limite de tentativas**: só o login tem trava (5 erros). Não há limite geral de requisições; o Caddy e o firewall da VPS são a camada para isso. Aceitável para uma clínica com tráfego pequeno; reavaliar se o endereço do painel for divulgado.
2. **Contratos**: guardar os termos/DPA de Meta, Anthropic, Asaas e Hostinger (ver `docs/contas-pendentes.md`).
3. **Backup**: guardar a chave privada do `age` fora da VPS e testar uma restauração antes do piloto (`docs/deploy-vps.md`).
4. **Aviso de privacidade**: o texto que o paciente lê na primeira mensagem precisa ser revisado por quem responde pela clínica.
