/**
 * Deterministic keyword detection for commands and safety signals.
 * Runs before any LLM call: these paths must never depend on model output.
 */

export type Intent =
  | { kind: "opt_out" }
  | { kind: "data_request" }
  | { kind: "human" }
  | { kind: "emergency" }
  | { kind: "clinical" }
  | { kind: "menu_choice"; choice: MenuChoice }
  | { kind: "quote_action"; quoteId: string; action: QuoteAction }
  | { kind: "appointment_action"; appointmentId: string; action: AppointmentAction }
  /** Buttons of the recall invitation (convite_retorno). */
  | { kind: "recall_schedule" }
  /** Answer to the bot's question about recall invitations (asked after a confirmation). */
  | { kind: "recall_consent"; granted: boolean }
  /** Buttons of a waiting-list offer (vaga_disponivel). */
  | { kind: "waitlist_answer"; offerId: string; accept: boolean }
  | { kind: "other" };

export type MenuChoice = "agendar" | "orcamento" | "info";
export type QuoteAction = "view" | "accept" | "reject";
export type AppointmentAction = "confirm" | "reschedule";

const QUOTE_REPLY = /^quote:([\w-]{1,64}):(view|accept|reject)$/;
const APPOINTMENT_REPLY = /^appt:([\w-]{1,64}):(confirm|reschedule)$/;
const WAITLIST_REPLY = /^wait:([\w-]{1,64}):(yes|no)$/;

export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Alarm signs from the plan: swelling that hinders breathing/swallowing, high fever,
// bleeding that does not stop, trauma. Any match goes straight to a human.
const EMERGENCY = [
  /inchad[oa].*(respirar|engolir)|(respirar|engolir).*inchad[oa]|inchaco.*(respirar|engolir)/,
  /falta de ar|nao consigo respirar|dificuldade (para|pra|de) (respirar|engolir)/,
  /febre (alta|de 39|de 40)|febre muito/,
  /sangr(amento|ando|a).*(nao para|sem parar|muito)/,
  /\b(trauma|acidente|batida|bati o dente|dente quebrou|caiu o dente|dente caiu|quebrei o dente)\b/,
];

const CLINICAL = [
  /\b(dor|doendo|doi|inchad[oa]|inchaco|sangr\w*|febre|pus|infec\w*|sensibilidade|ferida|afta)\b/,
  /\b(remedio|medicamento|antibiotico|posso tomar|diagnostico|raio.?x|exame)\b/,
];

const HUMAN = /\b(atendente|humano|recepcao|recepcionista|pessoa|falar com alguem)\b/;

export function detectIntent(text: string | undefined, replyId?: string): Intent {
  if (replyId === "menu:agendar") return { kind: "menu_choice", choice: "agendar" };
  if (replyId === "menu:orcamento") return { kind: "menu_choice", choice: "orcamento" };
  if (replyId === "menu:info") return { kind: "menu_choice", choice: "info" };
  if (replyId === "handoff") return { kind: "human" };
  if (replyId === "recall:schedule") return { kind: "recall_schedule" };
  if (replyId === "recall:stop") return { kind: "opt_out" };
  if (replyId === "recall:consent:yes") return { kind: "recall_consent", granted: true };
  if (replyId === "recall:consent:no") return { kind: "recall_consent", granted: false };
  const quote = replyId?.match(QUOTE_REPLY);
  if (quote) return { kind: "quote_action", quoteId: quote[1]!, action: quote[2] as QuoteAction };
  const appt = replyId?.match(APPOINTMENT_REPLY);
  if (appt)
    return {
      kind: "appointment_action",
      appointmentId: appt[1]!,
      action: appt[2] as AppointmentAction,
    };
  const wait = replyId?.match(WAITLIST_REPLY);
  if (wait) return { kind: "waitlist_answer", offerId: wait[1]!, accept: wait[2] === "yes" };

  const t = normalize(text ?? "");
  if (t === "parar" || t === "pare" || t === "sair") return { kind: "opt_out" };
  if (t === "meus dados") return { kind: "data_request" };
  if (EMERGENCY.some((re) => re.test(t))) return { kind: "emergency" };
  if (CLINICAL.some((re) => re.test(t))) return { kind: "clinical" };
  if (HUMAN.test(t)) return { kind: "human" };
  return { kind: "other" };
}
