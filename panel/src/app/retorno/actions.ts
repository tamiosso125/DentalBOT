"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";

const back = (aviso: string) => redirect(`/retorno?aviso=${encodeURIComponent(aviso)}`);

/** Records the patient's answer about recall invitations (the consent text is on the page). */
export async function setConsent(patientId: string, granted: boolean, form: FormData) {
  if (granted && form.get("confirm") === null)
    back("Marque que o paciente aceitou o texto para registrar o consentimento.");
  try {
    await api.setRecallConsent(patientId, granted);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) back(err.detail);
    throw err;
  }
  back(
    granted
      ? "Consentimento registrado."
      : "Consentimento retirado: o paciente não recebe mais convites.",
  );
}
