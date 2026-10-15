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
  quoteIntro: (firstName: string, total: string, plan: string, validUntil: string | null) =>
    `Olá, ${firstName}! Segue o orçamento do seu tratamento. Total particular: ${total} (${plan}).` +
    (validUntil ? ` Válido até ${validUntil}.` : "") +
    ` Você aprova?`,
  quoteButtons: (quoteId: string) => [
    { id: `quote:${quoteId}:accept`, title: "Aprovar" },
    { id: `quote:${quoteId}:reject`, title: "Não aprovar" },
    { id: "handoff", title: "Falar com a recepção" },
  ],
  quoteAccepted:
    "Obrigado! Registramos a aprovação do seu orçamento. A recepção vai te mandar a cobrança por aqui.",
  quoteAcceptedBilled: (amount: string, dueDate: string, url: string, remaining: number) =>
    `Obrigado! Registramos a aprovação do seu orçamento. ` +
    (remaining > 0
      ? `A 1ª parcela, de ${amount}, vence em ${dueDate}. `
      : `O pagamento, de ${amount}, vence em ${dueDate}. `) +
    `Você pode pagar por Pix, boleto ou cartão neste link: ${url}` +
    (remaining === 1
      ? `\nA 2ª parcela já está registrada para o mês seguinte, e a recepção te envia o link dela.`
      : remaining > 1
        ? `\nAs outras ${remaining} parcelas já estão registradas, uma por mês, e a recepção te envia o link de cada uma.`
        : ""),
  quoteAcceptedNeedsCpf:
    "Obrigado! Registramos a aprovação do seu orçamento. Para emitir a cobrança, a recepção vai te pedir o CPF do responsável pelo pagamento por aqui.",
  quoteAcceptedNoCharge:
    "Obrigado! Registramos a aprovação do seu orçamento. Não há valor particular a pagar; a recepção te chama para combinar os próximos passos.",
  quoteRejected:
    "Tudo bem, registramos que você não vai seguir com este orçamento. Se quiser conversar sobre outras opções, é só chamar a recepção por aqui.",
  quoteAlreadyAnswered: (status: "aprovado" | "não aprovado" | "vencido") =>
    `Este orçamento já está registrado como ${status}. Se precisar de algo, a recepção te ajuda por aqui.`,
  quoteExpired: (validUntil: string) =>
    `Este orçamento venceu em ${validUntil}. Já pedi para a recepção revisar e te enviar um novo.`,
  quoteNotFound: "Não encontrei esse orçamento. Já chamei a recepção, que te responde em breve.",
} as const;
