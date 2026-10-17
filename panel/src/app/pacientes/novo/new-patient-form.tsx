"use client";

import { useKeptForm, type FormErrors } from "@/lib/use-kept-form";
import { ErrorSummary } from "../../error-summary";

/** Name, mobile, birth date and CPF. Keeps what was typed when the API refuses it. */
export function NewPatientForm(props: {
  action: (prev: FormErrors, form: FormData) => Promise<FormErrors>;
}) {
  const { state, onSubmit, pending } = useKeptForm(props.action);
  return (
    <form className="stack" onSubmit={onSubmit}>
      <label>
        Nome
        <input name="name" minLength={2} maxLength={120} required autoFocus />
      </label>
      <label>
        Celular com DDD (o WhatsApp do paciente)
        <input name="phone" type="tel" inputMode="tel" maxLength={25} required />
      </label>
      <label>
        Nascimento
        <input name="birthDate" type="date" />
      </label>
      <label>
        CPF (opcional)
        <input name="cpf" inputMode="numeric" autoComplete="off" maxLength={14} />
      </label>
      <ErrorSummary errors={state.errors} />
      <div>
        <button type="submit" disabled={pending}>
          {pending ? "Salvando..." : "Cadastrar"}
        </button>
      </div>
    </form>
  );
}
