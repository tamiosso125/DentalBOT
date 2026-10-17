# Roteiro do piloto para a equipe da clínica

Para a dentista e a recepção. Antes de começar, a pessoa que instala o sistema confirma que o painel abre no endereço da clínica, que o WhatsApp está conectado e que os 14 templates estão aprovados na Meta (`docs/contas-pendentes.md`).

## Antes do primeiro dia (uma vez)

1. **Dentista**: abra o painel pela primeira vez, entre com o e-mail e a senha provisória e crie o seu login (primeiro acesso). Troque a senha em "Minha senha".
2. **Dentista**: em "Equipe", crie o login de cada pessoa da recepção. Cada uma entra só com o próprio login; nunca compartilhem.
3. **Clínica**: confira em "Clínica" os dados, o dentista, os horários, os procedimentos com preço e duração, os convênios e o que cada um cobre. Texto de cuidados pós-procedimento: a dentista escreve o dela em cada procedimento.
4. **Todos**: combinem que o mesmo número continua sendo atendido por pessoas. Quando alguém da recepção responde pelo aplicativo, o bot pausa sozinho naquela conversa.

## Teste combinado (antes de chamar pacientes reais)

Use o celular de alguém da equipe como "paciente". Marque cada item:

- [ ] Escrever "oi" e receber o menu.
- [ ] Marcar uma consulta de avaliação: o bot mostra horários numerados, você escolhe um número e a consulta aparece na Agenda do painel.
- [ ] Receber a confirmação e, na véspera, o lembrete com os botões Confirmar e Remarcar.
- [ ] Remarcar e cancelar pelo WhatsApp e ver a agenda mudar.
- [ ] Perguntar o preço de um procedimento: o valor tem que bater com o cadastro da clínica.
- [ ] Escrever algo clínico ("estou com dor de dente"): o bot não orienta tratamento e chama a recepção, que aparece em Pendências ou na lista de atendimento humano.
- [ ] Escrever "dor forte, rosto inchado e febre": o bot orienta procurar pronto-socorro e chama a equipe.
- [ ] Criar um orçamento para o paciente de teste: o PDF chega por WhatsApp, o paciente aceita pelo botão e as parcelas aparecem em "Cobranças".
- [ ] Pagar uma parcela no ambiente de teste do Asaas e ver a baixa no painel.
- [ ] Registrar um pagamento no balcão.
- [ ] Escrever PARAR e conferir que nenhuma mensagem de marketing sai depois.
- [ ] Escrever MEUS DADOS e ver o pedido em "Dados (LGPD)".

Se algum item falhar, anote a hora e o que foi escrito (use um paciente de teste, nunca dados de paciente real) e avise quem instalou.

## O primeiro dia com pacientes reais

**Manhã, antes de abrir**

1. Abra a Agenda do dia e a **Pendências**: veja parcelas vencidas e consultas sem confirmação.
2. Imprima a **agenda do dia** (botão na Agenda): ela traz plano e alertas de anamnese, sem telefone.
3. A dentista olha os alertas de saúde (alergia, anticoagulante, gestação) dos pacientes do dia na ficha.

**Durante o dia** 4. Paciente novo que ligou ou veio ao balcão: **Pacientes > Novo paciente** (nome e celular com DDD; CPF se for emitir cobrança). 5. Antes de atender, abra a **ficha** e confira a anamnese. Se não existe, preencha com o paciente. 6. Depois da consulta, marque **Compareceu** (ou **Faltou**) na Agenda. É isso que dispara os cuidados pós-procedimento e a pesquisa de satisfação. 7. Dentista: assine a **evolução clínica** da consulta. Não dá para editar nem apagar; correção é por adendo. 8. Conversa com o botão "falar com a recepção": responda pelo WhatsApp do aplicativo. O bot fica pausado e volta sozinho depois de algumas horas. 9. Convênio: consultas que precisam de autorização aparecem em **Autorizações**. Peça no portal da Odontoprev e marque autorizado ou negado; o paciente é avisado.

**Fim do dia** 10. Veja Pendências de novo: consulta sem marcação de comparecimento é a mais comum. 11. Confira **Cobranças**: parcelas que venceram hoje.

## Regras do dia a dia

- Não escreva dado de saúde em lugar nenhum fora do painel (nem no aplicativo de mensagens pessoal, nem em papel solto). Anotações da equipe e anamnese ficam na ficha.
- Cada pessoa usa o próprio login e sai do painel ao deixar o computador.
- O bot nunca diagnostica nem receita. Se o paciente insistir, atenda por pessoa.
- Pedido do paciente de ver ou apagar os dados: abrir em **Dados (LGPD)**; o prazo é de 15 dias.

## Quando algo der errado

- **Bot não responde**: confira se a conversa não está pausada (ficha do paciente mostra "pausado até"). Se não estiver, avise quem instalou.
- **Mensagem não chegou ao paciente**: fora da janela de 24 horas só sai template; o paciente precisa ter respondido antes ou a mensagem é um aviso aprovado.
- **Horário errado na agenda**: a agenda do painel é a fonte; corrija por lá e avise o paciente.

## Ao fim da primeira semana

Dentista e recepção sentam por 30 minutos: quantas conversas o bot resolveu sem ajuda, quantas foram para a recepção, o que o paciente estranhou. Olhe o **Resumo** do mês (só a dentista) e as notas da pesquisa de satisfação. Anote os ajustes para a próxima rodada.
