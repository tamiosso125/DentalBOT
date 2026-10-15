"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import {
  parseBlockForm,
  parseClinicForm,
  parseDentistForm,
  parseHoursForm,
  parseProcedureForm,
} from "@/lib/clinic-form";

export type FormState = { errors?: string[] };

/** 404/409/422 carry a message the front desk can act on (e.g. a name already taken). */
function apiErrors(err: unknown): FormState {
  if (err instanceof ApiError && [404, 409, 422].includes(err.status))
    return { errors: [err.detail] };
  throw err;
}

const done = (notice: string, path = "/clinica"): never =>
  redirect(`${path}?aviso=${encodeURIComponent(notice)}`);

/** Parses the form, calls the API and maps its refusals; `run` returns the notice to show. */
async function submit<T>(
  parsed: { body: T } | { errors: string[] },
  run: (body: T) => Promise<[notice: string, path?: string]>,
): Promise<FormState> {
  if ("errors" in parsed) return { errors: parsed.errors };
  let result: [string, string?];
  try {
    result = await run(parsed.body);
  } catch (err) {
    return apiErrors(err);
  }
  return done(...result);
}

export async function saveClinic(_prev: FormState, form: FormData) {
  return submit(parseClinicForm(form), async (body) => {
    await api.saveClinic(body);
    return ["Dados da clínica salvos."];
  });
}

export async function createDentist(_prev: FormState, form: FormData) {
  return submit(parseDentistForm(form), async (body) => {
    const { id } = await api.createDentist(body);
    return [
      "Dentista cadastrada. Agora preencha os horários de atendimento.",
      `/clinica/dentistas/${encodeURIComponent(id)}`,
    ];
  });
}

export async function updateDentist(id: string, _prev: FormState, form: FormData) {
  return submit(parseDentistForm(form), async (body) => {
    await api.updateDentist(id, body);
    return ["Dentista salva."];
  });
}

export async function saveHours(dentistId: string, _prev: FormState, form: FormData) {
  return submit(parseHoursForm(form), async (body) => {
    await api.saveHours(dentistId, body);
    return ["Horários de atendimento salvos. O bot já oferece os novos horários."];
  });
}

export async function createProcedure(_prev: FormState, form: FormData) {
  return submit(parseProcedureForm(form), async (body) => {
    await api.createProcedure(body);
    return [`Procedimento "${body.name}" cadastrado.`];
  });
}

export async function updateProcedure(id: string, _prev: FormState, form: FormData) {
  return submit(parseProcedureForm(form), async (body) => {
    await api.updateProcedure(id, body);
    return [`Procedimento "${body.name}" salvo.`];
  });
}

export async function createBlock(_prev: FormState, form: FormData) {
  return submit(parseBlockForm(form), async (body) => {
    const { appointments } = await api.createBlock(body);
    return [
      appointments
        ? `Bloqueio salvo. Há ${appointments} consulta(s) marcada(s) nesse período: remarque ou cancele pela agenda.`
        : "Bloqueio salvo. O bot não oferece horários nesse período.",
    ];
  });
}

export async function deleteBlock(id: string): Promise<void> {
  try {
    await api.deleteBlock(id);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  done("Bloqueio removido.");
}
