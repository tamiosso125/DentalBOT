"use client";

import { startTransition, useActionState, type FormEvent, type ReactNode } from "react";
import type { FormState } from "./actions";

/**
 * A cadastro form: shows the errors the action returns and disables itself while saving.
 * Submits through onSubmit instead of `action` so React does not reset the fields when the
 * action answers with an error (the week of working hours would be lost).
 */
export function SetupForm(props: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  submit: string;
  className?: string;
  children: ReactNode;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(props.action, {});
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => action(data));
  };
  return (
    <form onSubmit={onSubmit} className={props.className ?? "stack"}>
      {props.children}
      {state.errors?.length ? (
        <ul className="errors">
          {state.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      <div>
        <button type="submit" disabled={pending}>
          {pending ? "Salvando..." : props.submit}
        </button>
      </div>
    </form>
  );
}
