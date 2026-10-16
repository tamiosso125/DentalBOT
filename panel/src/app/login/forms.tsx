"use client";

import { useActionState } from "react";
import { firstAccess, login, type FirstAccessState, type LoginState } from "../actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(login, {} as LoginState);
  return (
    <form action={action} className="card stack">
      <label>
        E-mail
        <input
          type="email"
          name="email"
          required
          autoFocus
          autoComplete="username"
          defaultValue={state.email}
        />
      </label>
      <label>
        Senha
        <input type="password" name="password" required autoComplete="current-password" />
      </label>
      {state.error ? <p className="errors">{state.error}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? "Entrando..." : "Entrar"}
      </button>
      <p className="muted" style={{ margin: 0 }}>
        Esqueceu a senha? Peça para a dentista criar uma nova em &quot;Equipe&quot;.
      </p>
    </form>
  );
}

export function FirstAccessForm() {
  const [state, action, pending] = useActionState(firstAccess, {} as FirstAccessState);
  return (
    <form action={action} className="card stack">
      <p style={{ margin: 0 }}>
        <strong>Primeiro acesso.</strong> Crie o login da dentista. Depois, em &quot;Equipe&quot;,
        ela cria o login de cada pessoa da recepção.
      </p>
      <label>
        Senha do painel (a que foi configurada na instalação)
        <input type="password" name="panelPassword" required autoComplete="off" />
      </label>
      <label>
        Nome da dentista
        <input name="name" required maxLength={80} defaultValue={state.name} />
      </label>
      <label>
        E-mail
        <input
          type="email"
          name="email"
          required
          autoComplete="username"
          defaultValue={state.email}
        />
      </label>
      <label>
        Senha nova (pelo menos 10 caracteres)
        <input
          type="password"
          name="password"
          required
          minLength={10}
          autoComplete="new-password"
        />
      </label>
      <label>
        Repita a senha
        <input type="password" name="confirm" required minLength={10} autoComplete="new-password" />
      </label>
      {state.error ? <p className="errors">{state.error}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? "Criando..." : "Criar login e entrar"}
      </button>
    </form>
  );
}
