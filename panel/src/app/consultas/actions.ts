"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { parseBookingForm, parseRescheduleForm } from "@/lib/appointment-form";
import { entryFromForm } from "@/lib/clinical-record";
import { dateKey } from "@/lib/format";

export type FormState = { errors?: string[] };

/** 404/409/422 carry a message the front desk can act on (e.g. the slot was just taken). */
function apiErrors(err: unknown): FormState {
  if (err instanceof ApiError && [404, 409, 422].includes(err.status))
    return { errors: [err.detail] };
  throw err;
}

export async function bookAppointment(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = parseBookingForm(form);
  if ("errors" in parsed) return { errors: parsed.errors };
  let notified: boolean;
  try {
    ({ notified } = await api.bookAppointment(parsed.body));
  } catch (err) {
    return apiErrors(err);
  }
  redirect(`/?de=${dateKey(parsed.body.startsAt)}&marcada=${notified ? "avisado" : "1"}`);
}

export async function rescheduleAppointment(
  id: string,
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const parsed = parseRescheduleForm(form);
  if ("errors" in parsed) return { errors: parsed.errors };
  let notified: boolean;
  try {
    ({ notified } = await api.rescheduleAppointment(id, parsed.body));
  } catch (err) {
    return apiErrors(err);
  }
  redirect(`/?de=${dateKey(parsed.body.startsAt)}&remarcada=${notified ? "avisado" : "1"}`);
}

export async function cancelAppointment(
  id: string,
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  if (form.get("confirm") === null) return { errors: ["Marque a confirmação para cancelar."] };
  try {
    await api.cancelAppointment(id);
  } catch (err) {
    return apiErrors(err);
  }
  redirect("/?cancelada=1");
}

/** "Compareceu" / "Faltou": back to where the button was, with a notice or the API's reason. */
export async function markAttendance(id: string, attended: boolean, back: string) {
  const to = back.startsWith("/") && !back.startsWith("//") ? back : "/";
  const sep = to.includes("?") ? "&" : "?";
  try {
    await api.setAttendance(id, attended);
  } catch (err) {
    if (err instanceof ApiError && [404, 409, 422].includes(err.status))
      redirect(`${to}${sep}aviso=${encodeURIComponent(err.detail)}`);
    throw err;
  }
  redirect(`${to}${sep}presenca=${attended ? "compareceu" : "faltou"}`);
}

/** Sends the confirmation to the patient again; the API allows it once a day. */
export async function resendConfirmation(id: string) {
  const back = `/consultas/${encodeURIComponent(id)}`;
  try {
    await api.resendConfirmation(id);
  } catch (err) {
    if (err instanceof ApiError && [404, 409, 422].includes(err.status))
      redirect(`${back}?aviso=${encodeURIComponent(err.detail)}`);
    throw err;
  }
  redirect(
    `${back}?aviso=${encodeURIComponent("Confirmação reenviada ao paciente pelo WhatsApp.")}`,
  );
}

/** Sets or clears the patient's insurance plan and card from the appointment page. */
/** The dentist signs what was done in the visit. The API checks the login and the attendance. */
export async function saveClinicalEntry(
  appointmentId: string,
  patientId: string,
  back: string,
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    await api.addClinicalEntry(patientId, entryFromForm(form, { appointmentId }));
  } catch (err) {
    if (err instanceof ApiError && [403, 404, 422].includes(err.status))
      return { errors: [err.detail] };
    throw err;
  }
  redirect(`${back}?aviso=${encodeURIComponent("Evolução assinada.")}`);
}

export async function savePatientInsurance(patientId: string, back: string, form: FormData) {
  const planId = String(form.get("planId") ?? "") || null;
  const card = String(form.get("card") ?? "").trim();
  let aviso = planId ? "Convênio do paciente salvo." : "Paciente marcado como particular.";
  try {
    await api.setPatientInsurance(patientId, planId ? { planId, card } : { planId: null });
  } catch (err) {
    if (!(err instanceof ApiError && [404, 422].includes(err.status))) throw err;
    aviso = err.detail;
  }
  redirect(`${back}?aviso=${encodeURIComponent(aviso)}`);
}
