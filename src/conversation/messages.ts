/** Patient-facing texts (pt-BR). Changes here must be reviewed by the clinic. */
export const MESSAGES = {
  privacyNotice: (clinic: string, policyUrl: string) =>
    `Olá! Sou o assistente virtual da ${clinic}. ` +
    `Uso seus dados só para cuidar do seu atendimento, conforme nossa política de privacidade: ${policyUrl}. ` +
    `Se não quiser receber mensagens de lembrete e novidades, responda PARAR.`,
  menu: "Como posso ajudar?",
  menuButtons: [
    { id: "menu:agendar", title: "Agendar consulta" },
    { id: "menu:orcamento", title: "Orçamento/pagamento" },
    { id: "handoff", title: "Falar com a recepção" },
  ],
  handoff: "Certo! Vou chamar a recepção, que te responde por aqui em breve.",
  clinical:
    "Não consigo dar orientações clínicas por aqui, mas a nossa equipe vai te ajudar. " +
    "Já avisei a recepção, que te responde em breve.",
  emergency:
    "Pelo que você descreveu, pode ser uma urgência. Se houver dificuldade para respirar ou engolir, " +
    "sangramento que não para ou febre alta, procure agora um pronto-socorro ou ligue 192 (SAMU). " +
    "Já avisei a nossa equipe para falar com você.",
  optOut:
    "Pronto, você não vai mais receber lembretes de retorno nem novidades. " +
    "Avisos das suas consultas e pagamentos continuam chegando. Se mudar de ideia, é só pedir.",
  dataRequest:
    "Recebi seu pedido sobre seus dados pessoais. A equipe da clínica vai responder por aqui " +
    "com as informações de acesso, correção ou exclusão.",
  schedulingSoon:
    "Vou passar seu pedido de agendamento para a recepção, que confirma o melhor horário com você por aqui.",
  quoteSoon:
    "Vou passar seu pedido sobre orçamento ou pagamento para a recepção, que te responde por aqui.",
} as const;
