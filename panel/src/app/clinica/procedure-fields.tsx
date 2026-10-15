import { priceInput } from "@/lib/clinic-form";

/** Fields of the procedure form, empty for a new one. */
export function ProcedureFields(props: {
  procedure?: { name: string; durationMinutes: number; priceCents: number | null; active: boolean };
}) {
  const p = props.procedure;
  return (
    <>
      <div className="row">
        <label>
          Nome
          <input name="name" defaultValue={p?.name} required maxLength={80} />
        </label>
        <label>
          Duração (minutos)
          <input
            type="number"
            name="durationMinutes"
            defaultValue={p?.durationMinutes ?? 30}
            min={5}
            max={480}
            step={5}
            required
          />
        </label>
        <label>
          Preço particular (R$)
          <input
            name="price"
            inputMode="decimal"
            defaultValue={priceInput(p?.priceCents ?? null)}
            placeholder="Vazio = após avaliação"
          />
        </label>
      </div>
      {p ? (
        <label className="check">
          <input type="hidden" name="activeField" value="1" />
          <input type="checkbox" name="active" defaultChecked={p.active} />
          Ativo (o bot oferece este procedimento)
        </label>
      ) : null}
    </>
  );
}
