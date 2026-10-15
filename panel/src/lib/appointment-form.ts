/** Turns the "marcar / remarcar consulta" forms into API bodies. */

type Form = { get(name: string): FormDataEntryValue | null };

const text = (f: Form, name: string) => {
  const v = f.get(name);
  return typeof v === "string" ? v.trim() : "";
};

/** A slot travels in the form as "<dentistId>|<startsAt ISO>". */
export const slotValue = (s: { dentistId: string; startsAt: string }) =>
  `${s.dentistId}|${s.startsAt}`;

function parseSlot(value: string): { dentistId: string; startsAt: string } | null {
  const [dentistId, startsAt, extra] = value.split("|");
  if (!dentistId || !startsAt || extra !== undefined) return null;
  if (Number.isNaN(Date.parse(startsAt))) return null;
  return { dentistId, startsAt };
}

/** Checkbox: present = on. Unchecked boxes are not sent at all. */
const checked = (f: Form, name: string) => f.get(name) !== null;

export type BookingBody = {
  patient: { id: string } | { name: string; phone: string };
  procedureId: string;
  dentistId: string;
  startsAt: string;
  notify: boolean;
};

export function parseBookingForm(f: Form): { body: BookingBody } | { errors: string[] } {
  const errors: string[] = [];
  const patientId = text(f, "patientId");
  const name = text(f, "name");
  const phone = text(f, "phone");
  let patient: BookingBody["patient"] | null = null;
  if (patientId) patient = { id: patientId };
  else {
    if (name.length < 3) errors.push("Informe o nome completo do paciente.");
    if (phone.replace(/\D/g, "").length < 10) errors.push("Informe o celular com DDD.");
    patient = { name, phone };
  }
  const procedureId = text(f, "procedureId");
  if (!procedureId) errors.push("Escolha o procedimento.");
  const slot = parseSlot(text(f, "slot"));
  if (!slot) errors.push("Escolha um horário.");
  if (errors.length || !slot) return { errors };
  return { body: { patient, procedureId, ...slot, notify: checked(f, "notify") } };
}

export type RescheduleBody = { dentistId: string; startsAt: string; notify: boolean };

export function parseRescheduleForm(f: Form): { body: RescheduleBody } | { errors: string[] } {
  const slot = parseSlot(text(f, "slot"));
  if (!slot) return { errors: ["Escolha o novo horário."] };
  return { body: { ...slot, notify: checked(f, "notify") } };
}
