import { MAX_AFTERCARE_TEXT, priceInput } from "@/lib/clinic-form";

/** Fields of the procedure form, empty for a new one. */
export function ProcedureFields(props: {
  procedure?: {
    name: string;
    durationMinutes: number;
    priceCents: number | null;
    active: boolean;
    aftercareText: string | null;
  };
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
      <label>
        Cuidados após o procedimento
        <textarea
          name="aftercareText"
          rows={4}
          maxLength={MAX_AFTERCARE_TEXT}
          defaultValue={p?.aftercareText ?? ""}
          placeholder="Ex.: Não cuspa nem faça bochecho nas primeiras 24 horas. Compressa fria no rosto..."
        />
        <span className="muted">
          Quando a recepção marca &quot;Compareceu&quot;, o paciente recebe este texto pelo
          WhatsApp, do jeito que está aqui, e no dia seguinte o bot pergunta como ele está. Vazio =
          nada é enviado.
        </span>
      </label>
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
