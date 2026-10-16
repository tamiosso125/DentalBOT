"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { entryFromForm } from "@/lib/clinical-record";
import type { FormErrors } from "@/lib/use-kept-form";

/** An addendum corrects an earlier entry without changing it. */
export async function addAddendum(
  patientId: string,
  entryId: string,
  _prev: FormErrors,
  form: FormData,
): Promise<FormErrors> {
  try {
    await api.addClinicalEntry(patientId, entryFromForm(form, { amendsId: entryId }));
  } catch (err) {
    if (err instanceof ApiError && [403, 404, 422].includes(err.status))
      return { errors: [err.detail] };
    throw err;
  }
  const aviso = "Adendo assinado.";
  redirect(
    `/pacientes/${encodeURIComponent(patientId)}/prontuario?aviso=${encodeURIComponent(aviso)}`,
  );
}
