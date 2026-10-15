"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { panelConfig } from "@/lib/config";
import { createSession, safeEqual, SESSION_COOKIE, SESSION_HOURS } from "@/lib/session";

export type LoginState = { error?: string };

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const { password, sessionSecret } = panelConfig();
  const typed = form.get("password");
  if (typeof typed !== "string" || !safeEqual(typed, password)) {
    // Slow down guessing a little; the panel sits behind HTTPS on the clinic's VPS.
    await new Promise((r) => setTimeout(r, 800));
    return { error: "Senha incorreta." };
  }
  (await cookies()).set(SESSION_COOKIE, await createSession(sessionSecret), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
