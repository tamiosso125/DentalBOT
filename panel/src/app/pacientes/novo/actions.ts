"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { newPatientFromForm } from "@/lib/patient-profile";
import type { FormErrors } from "@/lib/use-kept-form";

/** Registers someone who phoned or walked in, then opens their record. */
export async function createPatient(_prev: FormErrors, form: FormData): Promise<FormErrors> {
  let id: string;
  try {
    ({ id } = await api.createPatient(newPatientFromForm(form)));
  } catch (err) {
    if (err instanceof ApiError && [409, 422].includes(err.status)) return { errors: [err.detail] };
    throw err;
  }
  redirect(
    `/pacientes/${encodeURIComponent(id)}?aviso=${encodeURIComponent("Paciente cadastrado.")}`,
  );
}
