"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { passwordProblem } from "@/lib/staff";

const back = (aviso: string) => redirect(`/conta?aviso=${encodeURIComponent(aviso)}`);
const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
};

export async function changePassword(form: FormData) {
  const password = text(form, "password");
  const problem = passwordProblem(password, text(form, "confirm"));
  if (problem) back(problem);
  try {
    await api.changeOwnPassword(text(form, "current"), password);
  } catch (err) {
    if (err instanceof ApiError && err.status === 422) back(err.detail);
    throw err;
  }
  back("Senha trocada.");
}
