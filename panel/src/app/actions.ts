"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { panelConfig } from "@/lib/config";
import {
  createSession,
  safeEqual,
  SESSION_COOKIE,
  SESSION_HOURS,
  type SessionUser,
} from "@/lib/session";
import { passwordProblem } from "@/lib/staff";

export type LoginState = { error?: string; email?: string };
export type FirstAccessState = { error?: string; name?: string; email?: string };

async function signIn(user: SessionUser) {
  const { sessionSecret } = panelConfig();
  (await cookies()).set(SESSION_COOKIE, await createSession(sessionSecret, user), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
}

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
};

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = text(form, "email").trim();
  let user: SessionUser;
  try {
    user = await api.login({ email, password: text(form, "password") });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 423))
      return { error: err.detail, email };
    throw err;
  }
  await signIn(user);
  redirect("/");
}

/**
 * First access: while the clinic has no login yet, whoever knows PANEL_PASSWORD creates the
 * dentist's own login. After that the shared password opens nothing.
 */
export async function firstAccess(
  _prev: FirstAccessState,
  form: FormData,
): Promise<FirstAccessState> {
  const { password: panelPassword } = panelConfig();
  const name = text(form, "name").trim();
  const email = text(form, "email").trim();
  const keep = { name, email };
  if (!safeEqual(text(form, "panelPassword"), panelPassword)) {
    // Slow down guessing a little; the panel sits behind HTTPS on the clinic's VPS.
    await new Promise((r) => setTimeout(r, 800));
    return { ...keep, error: "Senha do painel incorreta." };
  }
  const password = text(form, "password");
  const problem = passwordProblem(password, text(form, "confirm"));
  if (problem) return { ...keep, error: problem };
  let user: SessionUser;
  try {
    user = await api.bootstrap({ name, email, password });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 409 || err.status === 422))
      return { ...keep, error: err.detail };
    throw err;
  }
  await signIn(user);
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
