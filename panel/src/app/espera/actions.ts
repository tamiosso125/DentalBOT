"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";

const back = (aviso: string, keep = "") =>
  redirect(`/espera?${keep}aviso=${encodeURIComponent(aviso)}`);

/** Puts the chosen patient on the waiting list for a procedure until a day (inclusive). */
export async function addToWaitlist(patientId: string, patientName: string, form: FormData) {
  const procedureId = String(form.get("procedureId") ?? "");
  const until = String(form.get("until") ?? "");
  const keep = `paciente=${encodeURIComponent(patientId)}&nome=${encodeURIComponent(patientName)}&`;
  if (!procedureId || !/^\d{4}-\d{2}-\d{2}$/.test(until))
    back("Escolha o procedimento e até que dia avisar.", keep);
  try {
    await api.addToWaitlist({ patientId, procedureId, until });
  } catch (err) {
    if (err instanceof ApiError && [404, 409, 422].includes(err.status)) back(err.detail, keep);
    throw err;
  }
  back(`${patientName} entrou na lista de espera.`);
}

export async function removeFromWaitlist(id: string) {
  try {
    await api.removeFromWaitlist(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) back(err.detail);
    throw err;
  }
  back("Paciente tirado da lista de espera.");
}
