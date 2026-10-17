"use client";

import { useKeptForm, type FormErrors } from "@/lib/use-kept-form";
import { ErrorSummary } from "../../../error-summary";

/** Name, birth date and CPF. Keeps what was typed when the API refuses it. */
export function ProfileForm(props: {
  action: (prev: FormErrors, form: FormData) => Promise<FormErrors>;
  name: string;
  birthDate: string | null;
  hasCpf: boolean;
}) {
  const { state, onSubmit, pending } = useKeptForm(props.action);
  return (
    <form className="stack" onSubmit={onSubmit}>
      <label>
        Nome
        <input name="name" defaultValue={props.name} minLength={2} maxLength={120} required />
      </label>
      <label>
        Nascimento
        <input name="birthDate" type="date" defaultValue={props.birthDate ?? ""} />
      </label>
      <label>
        CPF {props.hasCpf ? "(deixe vazio para manter o cadastrado)" : ""}
        <input name="cpf" inputMode="numeric" autoComplete="off" maxLength={14} />
      </label>
      {props.hasCpf ? (
        <label>
          <input name="removeCpf" type="checkbox" /> Remover o CPF cadastrado
        </label>
      ) : null}
      <ErrorSummary errors={state.errors} />
      <div>
        <button type="submit" disabled={pending}>
          {pending ? "Salvando..." : "Salvar"}
        </button>
      </div>
    </form>
  );
}
