import Link from "next/link";
import { notFound } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { CONDITION_LABEL, CONDITIONS, EMPTY_HISTORY, historySummary } from "@/lib/medical-history";
import { Nav } from "../../../nav";
import { saveHistory } from "./actions";

export const dynamic = "force-dynamic";

/** The patient's medical history: only the staff sees it, the bot never reads it. */
export default async function AnamnesePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ aviso?: string }>;
}) {
  const { id } = await params;
  const { aviso } = await searchParams;
  const missing = (err: unknown) => {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  };
  const [record, history] = await Promise.all([
    api.patientRecord(id).catch(missing),
    api.medicalHistory(id).catch(missing),
  ]);
  const p = record.patient;
  const current = history.versions[0];
  const d = current?.data ?? EMPTY_HISTORY;
  const ficha = `/pacientes/${encodeURIComponent(p.id)}`;

  return (
    <>
      <Nav />
      <main>
        <p>
          <Link href={ficha}>← Ficha de {p.name}</Link>
        </p>
        <h1>Anamnese</h1>
        {aviso ? <p className="notice">{aviso}</p> : null}
        {history.alerts.length > 0 ? (
          <p className="alert" role="alert">
            <strong>Atenção:</strong>{" "}
            {history.alerts.map((a) => (
              <span key={a} className="badge danger" style={{ marginRight: 6 }}>
                {a}
              </span>
            ))}
          </p>
        ) : null}
        <p className="muted">
          {current
            ? `Última atualização em ${formatDateTime(current.at)}${current.staffName ? ` por ${current.staffName}` : ""}.`
            : "Ainda não preenchida."}{" "}
          Só a equipe vê. O bot não lê nem pergunta nada disso ao paciente.
        </p>

        {p.anonymizedAt ? (
          <p className="notice">Dados anonimizados: a anamnese foi apagada.</p>
        ) : (
          <form action={saveHistory.bind(null, p.id)} className="card stack">
            <label>
              Alergias (remédios, látex, anestésico...)
              <textarea
                name="allergies"
                rows={2}
                maxLength={500}
                defaultValue={d.allergies ?? ""}
                placeholder="Deixe em branco se não tem"
              />
            </label>
            <label>
              Remédios em uso
              <textarea
                name="medications"
                rows={2}
                maxLength={500}
                defaultValue={d.medications ?? ""}
              />
            </label>
            <fieldset className="slots">
              <legend>Doenças</legend>
              {CONDITIONS.map((c) => (
                <label key={c} className="check">
                  <input
                    type="checkbox"
                    name="conditions"
                    value={c}
                    defaultChecked={d.conditions.includes(c)}
                  />
                  {CONDITION_LABEL[c]}
                </label>
              ))}
            </fieldset>
            <label className="check">
              <input type="checkbox" name="anticoagulant" defaultChecked={d.anticoagulant} />
              Usa anticoagulante (AAS, varfarina...)
            </label>
            <label className="check">
              <input type="checkbox" name="pregnant" defaultChecked={d.pregnant} />
              Gestante
            </label>
            <label className="check">
              <input type="checkbox" name="smoker" defaultChecked={d.smoker} />
              Fumante
            </label>
            <label>
              Cirurgias e internações
              <textarea
                name="surgeries"
                rows={2}
                maxLength={500}
                defaultValue={d.surgeries ?? ""}
              />
            </label>
            <label>
              Observações
              <textarea name="notes" rows={3} maxLength={1000} defaultValue={d.notes ?? ""} />
            </label>
            <div>
              <button type="submit">Salvar anamnese</button>
              <span className="muted" style={{ marginLeft: 8 }}>
                A versão anterior fica no histórico.
              </span>
            </div>
          </form>
        )}

        {history.versions.length > 0 ? (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Histórico</h2>
            <ul style={{ marginBottom: 0 }}>
              {history.versions.map((v) => (
                <li key={v.id} style={{ marginTop: 8 }}>
                  <div className="muted">
                    {formatDateTime(v.at)}
                    {v.staffName ? ` · ${v.staffName}` : ""}
                  </div>
                  <div>{historySummary(v.data)}</div>
                  {v.data.notes ? (
                    <div className="muted" style={{ whiteSpace: "pre-wrap" }}>
                      {v.data.notes}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
    </>
  );
}
