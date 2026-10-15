"use server";

import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { parseQuoteForm } from "@/lib/quote-form";

export type FormState = { errors?: string[] };

export async function createQuote(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = parseQuoteForm(form);
  if ("errors" in parsed) return { errors: parsed.errors };
  let id: string;
  try {
    ({ id } = await api.createQuote(parsed.body));
  } catch (err) {
    // 422 carries the API's validation message (e.g. a procedure without table price).
    if (err instanceof ApiError && err.status === 422) return { errors: [err.detail] };
    throw err;
  }
  redirect(`/orcamentos/${id}?criado=1`);
}

export async function sendQuote(id: string) {
  const { via } = await api.sendQuote(id);
  redirect(`/orcamentos/${id}?enviado=${via}`);
}
