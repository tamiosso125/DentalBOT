"use client";

import type { ReactNode } from "react";
import { useKeptForm } from "@/lib/use-kept-form";
import type { FormState } from "./actions";

/** A cadastro form: shows the errors the action returns and disables itself while saving. */
export function SetupForm(props: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  submit: string;
  className?: string;
  children: ReactNode;
}) {
  const { state, onSubmit, pending } = useKeptForm(props.action);
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
