"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { profileFromForm } from "@/lib/patient-profile";
import type { FormErrors } from "@/lib/use-kept-form";

/** Fixes name, birth date and CPF. The phone is the patient's WhatsApp identity and stays. */
export async function saveProfile(
  patientId: string,
  _prev: FormErrors,
  form: FormData,
): Promise<FormErrors> {
  try {
    await api.updatePatientProfile(patientId, profileFromForm(form));
  } catch (err) {
    if (err instanceof ApiError && [404, 409, 422].includes(err.status))
      return { errors: [err.detail] };
    throw err;
  }
  redirect(
    `/pacientes/${encodeURIComponent(patientId)}?aviso=${encodeURIComponent("Dados salvos.")}`,
  );
}
