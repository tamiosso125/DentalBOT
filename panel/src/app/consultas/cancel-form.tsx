"use client";

import { useActionState } from "react";
import type { FormState } from "./actions";
import { ErrorSummary } from "../error-summary";

export function CancelForm(props: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(props.action, {});
  return (
    <form action={action} className="card stack">
      <h2 style={{ margin: 0 }}>Cancelar consulta</h2>
      <p className="muted" style={{ margin: 0 }}>
        O horário fica livre na agenda. O bot não avisa o paciente: combine com ele pelo WhatsApp.
      </p>
      <label className="check">
        <input type="checkbox" name="confirm" />
        Confirmo o cancelamento desta consulta
      </label>
      <ErrorSummary errors={state.errors} />
      <div>
        <button type="submit" className="secondary" disabled={pending}>
          {pending ? "Cancelando..." : "Cancelar consulta"}
        </button>
      </div>
    </form>
  );
}
