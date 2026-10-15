"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { parseBookingForm, parseRescheduleForm } from "@/lib/appointment-form";
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
