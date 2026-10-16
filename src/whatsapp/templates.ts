/**
 * Message templates the clinic may send outside the 24h window.
 * Each one must be submitted to and approved by Meta before use (see the
 * whatsapp-templates skill). The text here mirrors what is submitted, so reviews
 * and evals can read it; Meta stores the real copy.
 */
export type TemplateCategory = "UTILITY" | "MARKETING" | "AUTHENTICATION";

export type TemplateDefinition = {
  name: string;
  category: TemplateCategory;
  language: "pt_BR";
  /** Body with {{1}}, {{2}}... placeholders, in pt-BR. */
  body: string;
  params: readonly string[];
  /** Quick-reply buttons, in order. */
  buttons?: readonly string[];
};

export const TEMPLATES = {
  confirmacao_consulta: {
    name: "confirmacao_consulta",
    category: "UTILITY",
    language: "pt_BR",
    body: "Olá, {{1}}! Sua consulta na {{2}} está marcada para {{3}}. Podemos confirmar?",
    params: ["primeiro_nome", "clinica", "data_hora"],
    buttons: ["Confirmar", "Remarcar"],
  },
  lembrete_consulta: {
    name: "lembrete_consulta",
    category: "UTILITY",
    language: "pt_BR",
    body: "Oi, {{1}}! Lembrete: sua consulta é amanhã, {{2}}, na {{3}}. Até lá!",
    params: ["primeiro_nome", "data_hora", "clinica"],
    buttons: ["Confirmar", "Remarcar"],
  },
  orcamento_disponivel: {
    name: "orcamento_disponivel",
    category: "UTILITY",
    language: "pt_BR",
    body: "Olá, {{1}}! O orçamento do seu tratamento na {{2}} está pronto. Valor total: {{3}}. Quer ver os detalhes?",
    params: ["primeiro_nome", "clinica", "valor_total"],
    buttons: ["Ver orçamento", "Falar com a recepção"],
  },
  /** One reminder per quote, a few days after it went out without an answer. */
  lembrete_orcamento: {
    name: "lembrete_orcamento",
    category: "UTILITY",
    language: "pt_BR",
    body: "Olá, {{1}}! Passando para lembrar do orçamento do seu tratamento na {{2}}, no valor de {{3}}. Ele vale até {{4}}. Quer ver os detalhes ou tirar alguma dúvida com a recepção?",
    params: ["primeiro_nome", "clinica", "valor_total", "validade"],
    buttons: ["Ver orçamento", "Falar com a recepção"],
  },
  cobranca_parcela: {
    name: "cobranca_parcela",
    category: "UTILITY",
    language: "pt_BR",
    body: "Olá, {{1}}. A parcela {{2}} do seu tratamento, no valor de {{3}}, vence em {{4}}. Para pagar, acesse: {{5}}",
    params: ["primeiro_nome", "parcela", "valor", "vencimento", "link_pagamento"],
  },
  /** Once per installment, a day after the due date, while it is still open. */
  parcela_vencida: {
    name: "parcela_vencida",
    category: "UTILITY",
    language: "pt_BR",
    body: "Olá, {{1}}. A parcela {{2}} do seu tratamento na {{3}}, no valor de {{4}}, venceu em {{5}}. Se você já pagou, pode desconsiderar esta mensagem. Para pagar, acesse: {{6}}",
    params: ["primeiro_nome", "parcela", "clinica", "valor", "vencimento", "link_pagamento"],
    buttons: ["Falar com a recepção"],
  },
  /** Asked for by the patient (waiting list), so utility. One slot, first to accept takes it. */
  vaga_disponivel: {
    name: "vaga_disponivel",
    category: "UTILITY",
    language: "pt_BR",
    body: "Olá, {{1}}! Abriu uma vaga para {{2}} na {{3}}: {{4}}. Você está na lista de espera; quer ficar com esse horário?",
    params: ["primeiro_nome", "procedimento", "clinica", "data_hora"],
    buttons: ["Quero esse horário", "Não, obrigado"],
  },
  /** The insurer authorized the procedure of a booked appointment (front desk, via the panel). */
  convenio_autorizado: {
    name: "convenio_autorizado",
    category: "UTILITY",
    language: "pt_BR",
    body: "Olá, {{1}}! O {{2}} autorizou o procedimento da sua consulta de {{3}} na {{4}}. Até lá!",
    params: ["primeiro_nome", "convenio", "data_hora", "clinica"],
  },
  /** The insurer denied it: keep the appointment as private or talk to the front desk. */
  convenio_negado: {
    name: "convenio_negado",
    category: "UTILITY",
    language: "pt_BR",
    body: "Olá, {{1}}. O {{2}} não autorizou o procedimento da sua consulta de {{3}} na {{4}}. Você pode manter a consulta como particular ou falar com a recepção.",
    params: ["primeiro_nome", "convenio", "data_hora", "clinica"],
    buttons: ["Seguir como particular", "Falar com a recepção"],
  },
  /** Once per missed appointment, the day after, while nothing new is booked. */
  consulta_perdida: {
    name: "consulta_perdida",
    category: "UTILITY",
    language: "pt_BR",
    body: "Olá, {{1}}! Sentimos sua falta na consulta de {{2}} na {{3}}. Quer marcar um novo horário?",
    params: ["primeiro_nome", "data_hora", "clinica"],
    buttons: ["Marcar novo horário", "Falar com a recepção"],
  },
  /** The day after an attended appointment, at most once a month per patient. */
  pesquisa_satisfacao: {
    name: "pesquisa_satisfacao",
    category: "UTILITY",
    language: "pt_BR",
    body: "Olá, {{1}}! Obrigado por vir à {{2}} em {{3}}. Queremos saber como foi o seu atendimento: de 1 a 5, que nota você dá?",
    params: ["primeiro_nome", "clinica", "data"],
    buttons: ["5 - Excelente", "4 - Bom", "3 - Regular", "2 - Ruim", "1 - Péssimo"],
  },
  /** Marketing: only to patients with a recorded consent who did not reply "PARAR" since. */
  convite_retorno: {
    name: "convite_retorno",
    category: "MARKETING",
    language: "pt_BR",
    body: "Olá, {{1}}! Já faz um tempo desde a sua última consulta na {{2}}. Que tal marcar o seu retorno para manter o sorriso em dia?",
    params: ["primeiro_nome", "clinica"],
    buttons: ["Quero agendar", "Não quero receber"],
  },
} as const satisfies Record<string, TemplateDefinition>;

export type TemplateName = keyof typeof TEMPLATES;

/** Renders the template locally (sandbox, evals, audit log). */
export function renderTemplate(name: TemplateName, params: readonly string[]): string {
  const tpl: TemplateDefinition = TEMPLATES[name];
  if (params.length !== tpl.params.length) {
    throw new Error(`Template ${name} expects ${tpl.params.length} params, got ${params.length}`);
  }
  return tpl.body.replace(/\{\{(\d+)\}\}/g, (_, i: string) => params[Number(i) - 1] ?? "");
}
