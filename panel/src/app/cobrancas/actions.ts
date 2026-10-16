"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { isClinicMethod, parseReais } from "@/lib/billing";

const withNotice = (path: string, aviso: string) =>
  `${path}${path.includes("?") ? "&" : "?"}aviso=${encodeURIComponent(aviso)}`;

/** 404/409/422 and an Asaas outage (502) carry a message the front desk can act on. */
function notice(err: unknown): string {
  if (err instanceof ApiError && [404, 409, 422, 502].includes(err.status)) return err.detail;
  throw err;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** An open installment was paid at the front desk. `back` is the page to return to. */
export async function receiveInstallment(id: string, back: string, form: FormData) {
  const method = String(form.get("method") ?? "");
  const date = String(form.get("date") ?? "");
  let aviso = "Parcela registrada como paga na clínica. O bot não cobra mais esta parcela.";
  if (!isClinicMethod(method) || !DATE.test(date)) aviso = "Escolha a forma e o dia do pagamento.";
  else
    try {
      await api.receiveInstallment(id, { method, date });
    } catch (err) {
      aviso = notice(err);
    }
  redirect(withNotice(back, aviso));
}

/** A payment outside any quote, for the chosen patient. */
export async function createClinicPayment(patientId: string, patientName: string, form: FormData) {
  const method = String(form.get("method") ?? "");
  const date = String(form.get("date") ?? "");
  const amountCents = parseReais(String(form.get("amount") ?? ""));
  const procedureId = String(form.get("procedureId") ?? "") || null;
  const keep = `/cobrancas/clinica?paciente=${encodeURIComponent(patientId)}&nome=${encodeURIComponent(patientName)}`;
  if (!isClinicMethod(method) || !DATE.test(date) || amountCents === null)
    redirect(withNotice(keep, "Confira o valor (por exemplo 150,00), a forma e o dia."));
  try {
    await api.createClinicPayment({ patientId, procedureId, amountCents, method, date });
  } catch (err) {
    redirect(withNotice(keep, notice(err)));
  }
  redirect(withNotice("/cobrancas/clinica", `Pagamento de ${patientName} registrado.`));
}

export async function voidClinicPayment(id: string) {
  let aviso = "Pagamento desfeito.";
  try {
    await api.voidClinicPayment(id);
  } catch (err) {
    aviso = notice(err);
  }
  redirect(withNotice("/cobrancas/clinica", aviso));
}
