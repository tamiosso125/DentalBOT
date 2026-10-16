"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";

const back = (patientId: string, aviso: string) =>
  redirect(
    `/pacientes/${encodeURIComponent(patientId)}?aviso=${encodeURIComponent(aviso)}#anotacoes`,
  );

/** Staff note on the record. Stays in the panel: the bot never reads it. */
export async function addNote(patientId: string, form: FormData) {
  const text = String(form.get("text") ?? "").trim();
  if (!text) back(patientId, "Escreva a anotação.");
  try {
    // The API signs the note with whoever is logged in.
    await api.addPatientNote(patientId, { text });
  } catch (err) {
    if (err instanceof ApiError && [404, 422].includes(err.status)) back(patientId, err.detail);
    throw err;
  }
  back(patientId, "Anotação salva.");
}

export async function removeNote(patientId: string, noteId: string) {
  try {
    await api.removePatientNote(patientId, noteId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) back(patientId, err.detail);
    throw err;
  }
  back(patientId, "Anotação apagada.");
}
