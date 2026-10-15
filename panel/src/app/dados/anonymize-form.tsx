"use client";

import { useActionState } from "react";
import type { FormState } from "./actions";

export function AnonymizeForm(props: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(props.action, {});
  return (
    <form action={action} className="card stack">
      <h2 style={{ margin: 0 }}>Anonimizar</h2>
      <p className="muted" style={{ margin: 0 }}>
        Apaga nome, celular, CPF, data de nascimento, carteirinha e o texto das conversas, e cancela
        as consultas futuras. Orçamentos e pagamentos ficam guardados sem identificar a pessoa,
        porque a clínica precisa deles por lei. Não dá para desfazer. Baixe os dados antes se o
        paciente pediu uma cópia.
      </p>
      <label className="check">
        <input type="checkbox" name="confirm" />
        Confirmo que o paciente pediu a exclusão dos dados
      </label>
      {state.errors?.length ? (
        <ul className="errors">
          {state.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      <div>
        <button type="submit" className="secondary" disabled={pending}>
          {pending ? "Anonimizando..." : "Anonimizar dados"}
        </button>
      </div>
    </form>
  );
}
