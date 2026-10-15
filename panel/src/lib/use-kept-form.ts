import { startTransition, useActionState, type FormEvent } from "react";

/** What the panel's server actions answer: errors to show, if any. */
export type FormErrors = { errors?: string[] };

/**
 * useActionState for forms that must keep what was typed when the server action answers
 * with errors. Passing the action to `<form action>` makes React reset the fields after
 * every submission; submitting through onSubmit does not.
 */
export function useKeptForm(action: (prev: FormErrors, form: FormData) => Promise<FormErrors>) {
  const [state, dispatch, pending] = useActionState<FormErrors, FormData>(action, {});
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => dispatch(data));
  };
  return { state, onSubmit, pending };
}
