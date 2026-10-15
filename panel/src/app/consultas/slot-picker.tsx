"use client";

import { useActionState } from "react";
import type { StaffSlot } from "@/lib/api";
import { slotValue } from "@/lib/appointment-form";
import { formatTime } from "@/lib/format";
import type { FormState } from "./actions";

/**
 * Radio list of free times plus the "avisar o paciente" checkbox. `hidden` fields carry
 * what earlier steps chose; `newPatient` shows the name and phone fields.
 */
export function SlotPicker(props: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  slots: StaffSlot[];
  dentists: Record<string, string>;
  hidden: Record<string, string>;
  newPatient?: boolean;
  submitLabel: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(props.action, {});
  const manyDentists = new Set(props.slots.map((s) => s.dentistId)).size > 1;
  return (
    <form action={action} className="card stack">
      {Object.entries(props.hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {props.newPatient ? (
        <div className="row">
          <label>
            Nome completo do paciente
            <input name="name" required minLength={3} maxLength={120} />
          </label>
          <label>
            Celular com DDD (WhatsApp)
            <input name="phone" required inputMode="tel" placeholder="(11) 90000-0000" />
          </label>
        </div>
      ) : null}
      {props.slots.length === 0 ? (
        <p className="muted">Nenhum horário livre neste dia. Escolha outra data.</p>
      ) : (
        <fieldset className="slots">
          <legend>Horário</legend>
          {props.slots.map((s) => (
            <label key={slotValue(s)} className="slot">
              <input type="radio" name="slot" value={slotValue(s)} required />
              {formatTime(s.startsAt)}
              {manyDentists ? ` · ${props.dentists[s.dentistId] ?? ""}` : null}
            </label>
          ))}
        </fieldset>
      )}
      <label className="check">
        <input type="checkbox" name="notify" defaultChecked />
        Avisar o paciente pelo WhatsApp (com os botões Confirmar e Remarcar)
      </label>
      {state.errors?.length ? (
        <ul className="errors">
          {state.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      <div>
        <button type="submit" disabled={pending || props.slots.length === 0}>
          {pending ? "Salvando..." : props.submitLabel}
        </button>
      </div>
    </form>
  );
}
