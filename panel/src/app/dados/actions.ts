"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { anonymizedNotice, parseSubject } from "@/lib/data-subject";

export type FormState = { errors?: string[] };

/** 404/409 carry a message the front desk can act on (e.g. an installment still open). */
function apiErrors(err: unknown): FormState {
  if (err instanceof ApiError && [404, 409].includes(err.status)) return { errors: [err.detail] };
  throw err;
}

export async function anonymize(
  tipo: string,
  id: string,
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const subject = parseSubject(tipo, id);
  if (!subject) return { errors: ["Pedido não encontrado."] };
  if (form.get("confirm") === null) return { errors: ["Marque a confirmação para anonimizar."] };
  let notice: string;
  try {
    notice = anonymizedNotice(await api.anonymize(subject));
  } catch (err) {
    return apiErrors(err);
  }
  redirect(`/dados?aviso=${encodeURIComponent(notice)}`);
}

export async function resolveRequest(id: string): Promise<void> {
  try {
    await api.resolveDataRequest(id);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  redirect(`/dados?aviso=${encodeURIComponent("Pedido marcado como respondido.")}`);
}
