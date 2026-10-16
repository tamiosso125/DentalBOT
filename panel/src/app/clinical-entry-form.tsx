"use client";

import { useKeptForm, type FormErrors } from "@/lib/use-kept-form";

/** The visit's clinical entry (or an addendum). Keeps what was typed when the API refuses it. */
export function ClinicalEntryForm(props: {
  action: (prev: FormErrors, form: FormData) => Promise<FormErrors>;
  label: string;
  performedLabel: string;
  signedBy?: string;
}) {
  const { state, onSubmit, pending } = useKeptForm(props.action);
  return (
    <form className="stack" onSubmit={onSubmit} style={{ marginTop: 8 }}>
      <label>
        {props.performedLabel}
        <textarea name="performed" rows={4} maxLength={2000} required />
      </label>
      <label>
        Dentes (numeração FDI, separados por vírgula)
        <input name="teeth" maxLength={200} placeholder="36, 37" />
      </label>
      <label>
        Observações
        <textarea name="notes" rows={2} maxLength={2000} />
      </label>
      {state.errors?.length ? (
        <ul className="errors">
          {state.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      <div>
        <button type="submit" disabled={pending}>
          {pending ? "Assinando..." : props.label}
        </button>
        {props.signedBy ? (
          <span className="muted" style={{ marginLeft: 8 }}>
            Fica assinada por {props.signedBy}.
          </span>
        ) : null}
      </div>
    </form>
  );
}
