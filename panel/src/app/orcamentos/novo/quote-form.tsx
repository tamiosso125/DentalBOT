"use client";

import Link from "next/link";
import type { Catalog } from "@/lib/api";
import { formatCents } from "@/lib/format";
import { ITEM_ROWS } from "@/lib/quote-form";
import { useKeptForm } from "@/lib/use-kept-form";
import { createQuote } from "../actions";

export function QuoteForm(props: {
  patientId: string;
  patientName: string;
  dentists: Catalog["dentists"];
  procedures: Catalog["procedures"];
}) {
  // Keeps the items typed so far when the API refuses the quote.
  const { state, onSubmit, pending } = useKeptForm(createQuote);
  return (
    <form onSubmit={onSubmit} className="card stack">
      <input type="hidden" name="patientId" value={props.patientId} />
      <p>
        Paciente: <strong>{props.patientName}</strong> <Link href="/orcamentos/novo">trocar</Link>
      </p>
      <label>
        Dentista
        <select name="dentistId" required defaultValue={props.dentists[0]?.id}>
          {props.dentists.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.cro ? ` (${d.cro})` : ""}
            </option>
          ))}
        </select>
      </label>

      <div className="items">
        <div className="item muted" style={{ fontSize: 13 }}>
          <span>Procedimento</span>
          <span>Qtd</span>
          <span>Cobertura</span>
          <span>Valor unit. (R$)</span>
        </div>
        {Array.from({ length: ITEM_ROWS }, (_, i) => (
          <div key={i} className="item">
            <select
              name={`item${i}.procedureId`}
              defaultValue=""
              aria-label={`Procedimento ${i + 1}`}
            >
              <option value="">-</option>
              {props.procedures.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (
                  {p.priceCents === null ? "sem preço na tabela" : formatCents(p.priceCents)})
                </option>
              ))}
            </select>
            <input
              name={`item${i}.quantity`}
              type="number"
              min={1}
              max={32}
              defaultValue={1}
              aria-label={`Quantidade ${i + 1}`}
            />
            <select
              name={`item${i}.coverage`}
              defaultValue="PRIVATE"
              aria-label={`Cobertura ${i + 1}`}
            >
              <option value="PRIVATE">Particular</option>
              <option value="INSURANCE">Odontoprev</option>
            </select>
            <input
              name={`item${i}.price`}
              inputMode="decimal"
              placeholder="da tabela"
              aria-label={`Valor ${i + 1}`}
            />
          </div>
        ))}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Deixe o valor em branco para usar o da tabela. Itens do convênio não entram no total.
      </p>

      <div className="row">
        <label>
          Parcelas
          <input name="installmentCount" type="number" min={1} max={12} defaultValue={1} />
        </label>
        <label>
          Validade (dias)
          <input name="validDays" type="number" min={1} max={90} defaultValue={15} />
        </label>
      </div>
      <label>
        Observações no PDF (sem diagnóstico)
        <textarea name="notes" rows={3} maxLength={500} />
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
          {pending ? "Criando..." : "Criar orçamento"}
        </button>
      </div>
    </form>
  );
}
