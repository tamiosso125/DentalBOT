export type SummaryTone = "neutral" | "warn" | "danger";
export type SummaryItem = { label: string; value: number; href: string; tone: SummaryTone };

type AgendaRow = { startsAt: string; status: string };

export type SummaryInput = {
  rows: AgendaRow[];
  /** Today as yyyy-mm-dd, in the same format `dayOf` returns. */
  today: string;
  dayOf: (iso: string) => string;
  waitingForReception: number;
  attendanceToMark: number;
  installmentsToCall: number;
  authorizationsPending: number;
};

/** The numbers at the top of the home page; anything above zero asks for attention. */
export function homeSummary(input: SummaryInput): SummaryItem[] {
  const todays = input.rows.filter(
    (r) => input.dayOf(r.startsAt) === input.today && r.status !== "CANCELLED",
  );
  const toConfirm = todays.filter((r) => r.status === "PENDING_CONFIRMATION").length;
  const tone = (n: number, level: SummaryTone): SummaryTone => (n > 0 ? level : "neutral");
  return [
    { label: "Consultas hoje", value: todays.length, href: "#agenda", tone: "neutral" },
    {
      label: "Hoje sem confirmação",
      value: toConfirm,
      href: "#agenda",
      tone: tone(toConfirm, "warn"),
    },
    {
      label: "Esperando a recepção",
      value: input.waitingForReception,
      href: "#recepcao",
      tone: tone(input.waitingForReception, "warn"),
    },
    {
      label: "Presença sem marcar",
      value: input.attendanceToMark,
      href: "#sem-marcacao",
      tone: tone(input.attendanceToMark, "warn"),
    },
    {
      label: "Autorizações pendentes",
      value: input.authorizationsPending,
      href: "/autorizacoes",
      tone: tone(input.authorizationsPending, "warn"),
    },
    {
      label: "Parcelas para ligar",
      value: input.installmentsToCall,
      href: "/cobrancas?filtro=ligar",
      tone: tone(input.installmentsToCall, "danger"),
    },
  ];
}

/** Badge colour for an appointment status; the label always carries the meaning too. */
export function appointmentTone(status: string): "ok" | "warn" | "danger" | "done" {
  if (status === "CONFIRMED") return "ok";
  if (status === "CANCELLED" || status === "NO_SHOW") return "danger";
  if (status === "COMPLETED") return "done";
  return "warn";
}
