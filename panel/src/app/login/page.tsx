"use client";

import { useActionState } from "react";
import { login, type LoginState } from "../actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, {} as LoginState);
  return (
    <main style={{ maxWidth: 360, paddingTop: 80 }}>
      <h1>Painel DentalBOT</h1>
      <form action={action} className="card stack">
        <label>
          Senha da equipe
          <input
            type="password"
            name="password"
            required
            autoFocus
            autoComplete="current-password"
          />
        </label>
        {state.error ? <p className="errors">{state.error}</p> : null}
        <button type="submit" disabled={pending}>
          {pending ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </main>
  );
}
