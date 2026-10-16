"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { passwordProblem } from "@/lib/staff";

const back = (aviso: string) => redirect(`/equipe?aviso=${encodeURIComponent(aviso)}`);
const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
};
const shown = (err: unknown) => {
  if (err instanceof ApiError && [403, 404, 409, 422].includes(err.status)) back(err.detail);
  throw err;
};

export async function createStaff(form: FormData) {
  const password = text(form, "password");
  const problem = passwordProblem(password, text(form, "confirm"));
  if (problem) back(problem);
  const name = text(form, "name").trim();
  try {
    await api.createStaff({
      name,
      email: text(form, "email").trim(),
      role: text(form, "role"),
      password,
    });
  } catch (err) {
    shown(err);
  }
  back(`Login de ${name} criado. Passe a senha para a pessoa; ela pode trocar em "Minha senha".`);
}

export async function setActive(id: string, name: string, active: boolean) {
  try {
    await api.setStaffActive(id, active);
  } catch (err) {
    shown(err);
  }
  back(active ? `${name} pode entrar de novo.` : `${name} não entra mais no painel.`);
}

export async function resetPassword(id: string, name: string, form: FormData) {
  const password = text(form, "password");
  const problem = passwordProblem(password, password);
  if (problem) back(problem);
  try {
    await api.resetStaffPassword(id, password);
  } catch (err) {
    shown(err);
  }
  back(`Senha nova de ${name} salva.`);
}
