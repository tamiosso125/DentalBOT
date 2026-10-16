"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { historyFromForm } from "@/lib/medical-history";

const back = (patientId: string, aviso: string) =>
  redirect(
    `/pacientes/${encodeURIComponent(patientId)}/anamnese?aviso=${encodeURIComponent(aviso)}`,
  );

/** Saves a new version of the anamnese; the API records who filled it in. */
export async function saveHistory(patientId: string, form: FormData) {
  try {
    await api.saveMedicalHistory(patientId, historyFromForm(form));
  } catch (err) {
    if (err instanceof ApiError && [404, 422].includes(err.status)) back(patientId, err.detail);
    throw err;
  }
  back(patientId, "Anamnese salva.");
}
