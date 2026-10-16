"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";

const back = (aviso: string) => redirect(`/autorizacoes?aviso=${encodeURIComponent(aviso)}`);

/** Records the insurer's answer; the API tells the patient on WhatsApp. */
export async function decideAuthorization(appointmentId: string, authorized: boolean) {
  let notified = false;
  try {
    ({ notified } = await api.decideAuthorization(appointmentId, authorized));
  } catch (err) {
    if (err instanceof ApiError && [404, 409, 422].includes(err.status)) back(err.detail);
    throw err;
  }
  const what = authorized ? "Autorização registrada." : "Negativa registrada.";
  back(
    notified
      ? `${what} O paciente recebeu o aviso pelo WhatsApp${authorized ? "" : ", com a opção de seguir como particular"}.`
      : `${what} O aviso pelo WhatsApp não saiu: avise o paciente por telefone.`,
  );
}
