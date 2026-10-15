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
  /** Asked for by the patient (waiting list), so utility. One slot, first to accept takes it. */
  vaga_disponivel: {
    name: "vaga_disponivel",
    category: "UTILITY",
    language: "pt_BR",
    body: "Olá, {{1}}! Abriu uma vaga para {{2}} na {{3}}: {{4}}. Você está na lista de espera; quer ficar com esse horário?",
    params: ["primeiro_nome", "procedimento", "clinica", "data_hora"],
    buttons: ["Quero esse horário", "Não, obrigado"],
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
