import { dateKey, formatCents, formatDate, formatTime, TIME_ZONE } from "./format";
import { parseReais } from "./quote-form";

/** Turns the "Clínica" forms (cadastro) into API bodies, with messages for the front desk. */

type Form = { get(name: string): FormDataEntryValue | null };
type Parsed<T> = { body: T } | { errors: string[] };

const text = (f: Form, name: string) => {
  const v = f.get(name);
  return typeof v === "string" ? v.trim() : "";
};
const checked = (f: Form, name: string) => f.get(name) !== null;

export const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
/** Morning and afternoon: two time ranges per weekday in the form. */
export const RANGES_PER_DAY = 2;

export type WorkingWindow = { weekday: number; startMinute: number; endMinute: number };

export type SetupView = {
  clinic: { name: string; address: string | null; timeZone: string } | null;
  dentists: Array<{
    id: string;
    name: string;
    cro: string | null;
    active: boolean;
    workingHours: WorkingWindow[];
  }>;
  procedures: Array<{
    id: string;
    name: string;
    durationMinutes: number;
    priceCents: number | null;
    active: boolean;
    aftercareText: string | null;
  }>;
  insurancePlans: Array<{
    id: string;
    name: string;
    coverage: Array<{ procedureId: string; requiresAuthorization: boolean }>;
  }>;
  blocks: Array<{
    id: string;
    dentistId: string;
    dentistName: string;
    startsAt: string;
    endsAt: string;
    reason: string | null;
  }>;
};

/** "08:30" -> 510. Null if not a clock time. */
export function parseClock(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 510 -> "08:30". */
export function formatClock(minute: number): string {
  const h = Math.floor(minute / 60);
  return `${String(h).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function parseClinicForm(f: Form): Parsed<{ name: string; address: string | null }> {
  const name = text(f, "name");
  if (name.length < 2) return { errors: ["Informe o nome da clínica."] };
  return { body: { name, address: text(f, "address") || null } };
}

export function parseDentistForm(
  f: Form,
): Parsed<{ name: string; cro: string | null; active: boolean }> {
  const name = text(f, "name");
  if (name.length < 3) return { errors: ["Informe o nome da dentista."] };
  // New dentists have no checkbox: they start active.
  const active = f.get("activeField") === null || checked(f, "active");
  return { body: { name, cro: text(f, "cro") || null, active } };
}

/** Field names: `d<weekday>r<range>start` / `...end`, e.g. "d1r0start". */
export const hourField = (weekday: number, range: number, edge: "start" | "end") =>
  `d${weekday}r${range}${edge}`;

export function parseHoursForm(f: Form): Parsed<{ hours: WorkingWindow[] }> {
  const errors: string[] = [];
  const hours: WorkingWindow[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let range = 0; range < RANGES_PER_DAY; range++) {
      const start = text(f, hourField(weekday, range, "start"));
      const end = text(f, hourField(weekday, range, "end"));
      if (!start && !end) continue;
      const startMinute = parseClock(start);
      const endMinute = parseClock(end);
      if (startMinute === null || endMinute === null) {
        errors.push(`${WEEKDAYS[weekday]}: preencha o início e o fim.`);
        continue;
      }
      if (startMinute % 5 || endMinute % 5) {
        errors.push(`${WEEKDAYS[weekday]}: use horários de 5 em 5 minutos.`);
        continue;
      }
      if (endMinute <= startMinute) {
        errors.push(`${WEEKDAYS[weekday]}: o fim precisa ser depois do início.`);
        continue;
      }
      hours.push({ weekday, startMinute, endMinute });
    }
  }
  for (let weekday = 0; weekday < 7; weekday++) {
    const day = hours.filter((h) => h.weekday === weekday);
    const [a, b] = day.sort((x, y) => x.startMinute - y.startMinute);
    if (a && b && a.endMinute > b.startMinute)
      errors.push(`${WEEKDAYS[weekday]}: os dois horários se sobrepõem.`);
  }
  return errors.length ? { errors } : { body: { hours } };
}

/** The ranges of one weekday, to prefill the form. */
export function rangesOf(hours: WorkingWindow[], weekday: number) {
  return hours
    .filter((h) => h.weekday === weekday)
    .sort((a, b) => a.startMinute - b.startMinute)
    .slice(0, RANGES_PER_DAY)
    .map((h) => ({ start: formatClock(h.startMinute), end: formatClock(h.endMinute) }));
}

/** "Seg 08:00–12:00, 13:00–18:00 · Ter ..." for the dentist summary. */
export function describeHours(hours: WorkingWindow[]): string {
  const days = WEEKDAYS.map((name, weekday) => {
    const ranges = rangesOf(hours, weekday);
    if (!ranges.length) return null;
    return `${name.slice(0, 3)} ${ranges.map((r) => `${r.start}–${r.end}`).join(", ")}`;
  }).filter(Boolean);
  return days.length ? days.join(" · ") : "Sem horário de atendimento";
}

export type ProcedureBody = {
  name: string;
  durationMinutes: number;
  priceCents: number | null;
  active: boolean;
  /** Empty in the form = no care instructions for this procedure. */
  aftercareText: string | null;
};

/** Same limit as the API: the text travels inside a WhatsApp template parameter. */
export const MAX_AFTERCARE_TEXT = 600;

export function parseProcedureForm(f: Form): Parsed<ProcedureBody> {
  const errors: string[] = [];
  const name = text(f, "name");
  if (name.length < 2) errors.push("Informe o nome do procedimento.");
  const duration = Number(text(f, "durationMinutes"));
  if (!Number.isInteger(duration) || duration < 5 || duration > 480 || duration % 5)
    errors.push("A duração vai de 5 a 480 minutos, de 5 em 5.");
  const priceText = text(f, "price");
  const priceCents = priceText ? parseReais(priceText) : null;
  if (priceText && priceCents === null) errors.push("Preço inválido. Exemplo: 250,00");
  const aftercareText = text(f, "aftercareText");
  if (aftercareText.length > MAX_AFTERCARE_TEXT)
    errors.push(`Os cuidados após o procedimento cabem em até ${MAX_AFTERCARE_TEXT} caracteres.`);
  if (errors.length) return { errors };
  const active = f.get("activeField") === null || checked(f, "active");
  return {
    body: {
      name,
      durationMinutes: duration,
      priceCents,
      active,
      aftercareText: aftercareText || null,
    },
  };
}

/** Price as typed in the form ("250,00"), empty when it depends on evaluation. */
export function priceInput(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

export function describePrice(cents: number | null): string {
  return cents === null ? "Após avaliação" : formatCents(cents);
}

export function parsePlanForm(f: Form): Parsed<{ name: string }> {
  const name = text(f, "name");
  if (name.length < 2) return { errors: ["Informe o nome do convênio."] };
  return { body: { name } };
}

export type CoverageBody = {
  items: Array<{ procedureId: string; requiresAuthorization: boolean }>;
};

/** Checkbox names of the coverage table: `cover-<procedureId>` and `auth-<procedureId>`. */
export const coverField = (procedureId: string, kind: "cover" | "auth") => `${kind}-${procedureId}`;

/** Asking for prior authorization implies the plan covers the procedure. */
export function parseCoverageForm(f: FormData): CoverageBody {
  const ids = new Set<string>();
  for (const key of f.keys()) {
    const m = /^(cover|auth)-(.+)$/.exec(key);
    if (m) ids.add(m[2]!);
  }
  return {
    items: [...ids].map((id) => ({
      procedureId: id,
      requiresAuthorization: f.get(coverField(id, "auth")) !== null,
    })),
  };
}

/** "3 procedimentos cobertos, 1 com autorização prévia" for the plan list. */
export function describeCoverage(coverage: CoverageBody["items"]): string {
  if (!coverage.length) return "Cobertura não cadastrada: o bot diz que a recepção confirma";
  const auth = coverage.filter((c) => c.requiresAuthorization).length;
  const covered = `${coverage.length} procedimento${coverage.length > 1 ? "s" : ""} coberto${coverage.length > 1 ? "s" : ""}`;
  return auth ? `${covered}, ${auth} com autorização prévia` : covered;
}

export type BlockBody = {
  dentistId: string;
  fromDate: string;
  toDate: string;
  fromMinute?: number;
  toMinute?: number;
  reason: string | null;
};

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export function parseBlockForm(f: Form): Parsed<BlockBody> {
  const errors: string[] = [];
  const dentistId = text(f, "dentistId");
  if (!dentistId) errors.push("Escolha a dentista.");
  const fromDate = text(f, "fromDate");
  const toDate = text(f, "toDate") || fromDate;
  if (!isDate(fromDate)) errors.push("Informe o primeiro dia do bloqueio.");
  else if (!isDate(toDate) || toDate < fromDate)
    errors.push("O último dia precisa ser igual ou depois do primeiro.");
  const fromTime = text(f, "fromTime");
  const toTime = text(f, "toTime");
  const body: BlockBody = { dentistId, fromDate, toDate, reason: text(f, "reason") || null };
  if (fromTime || toTime) {
    const fromMinute = parseClock(fromTime);
    const toMinute = parseClock(toTime);
    if (fromMinute === null || toMinute === null)
      errors.push("Para bloquear só parte do dia, preencha as duas horas.");
    else if (fromDate === toDate && toMinute <= fromMinute)
      errors.push("A hora final precisa ser depois da inicial.");
    else Object.assign(body, { fromMinute, toMinute });
  }
  return errors.length ? { errors } : { body };
}

/** What still keeps the bot from booking: shown at the top of the page. */
export function setupGaps(view: SetupView): string[] {
  const gaps: string[] = [];
  if (!view.clinic) gaps.push("Salve os dados da clínica.");
  const active = view.dentists.filter((d) => d.active);
  if (!active.length) gaps.push("Cadastre a dentista.");
  else if (!active.some((d) => d.workingHours.length))
    gaps.push("Preencha os horários de atendimento da dentista.");
  if (!view.procedures.some((p) => p.active)) gaps.push("Cadastre pelo menos um procedimento.");
  return gaps;
}

/** "24/12/2026 a 31/12/2026" for whole days, "24/12/2026, 13:00 às 18:00" for part of one. */
export function describeBlock(b: { startsAt: string; endsAt: string }, timeZone = TIME_ZONE) {
  const [startTime, endTime] = [formatTime(b.startsAt, timeZone), formatTime(b.endsAt, timeZone)];
  const first = dateKey(b.startsAt, timeZone);
  if (startTime === "00:00" && endTime === "00:00") {
    const last = dateKey(new Date(Date.parse(b.endsAt) - 60_000), timeZone);
    return first === last ? formatDate(first) : `${formatDate(first)} a ${formatDate(last)}`;
  }
  const last = dateKey(b.endsAt, timeZone);
  return first === last
    ? `${formatDate(first)}, ${startTime} às ${endTime}`
    : `${formatDate(first)} ${startTime} a ${formatDate(last)} ${endTime}`;
}
