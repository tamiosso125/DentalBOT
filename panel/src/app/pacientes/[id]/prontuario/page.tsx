import Link from "next/link";
import { notFound } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { canWriteClinical, threadsByVisit, type ClinicalEntry } from "@/lib/clinical-record";
import { currentUser } from "@/lib/current-user";
import { formatDateTime } from "@/lib/format";
import { ClinicalEntryForm } from "../../../clinical-entry-form";
import { Nav } from "../../../nav";
import { addAddendum } from "./actions";

export const dynamic = "force-dynamic";

function EntryText({ e }: { e: ClinicalEntry }) {
  return (
    <>
      <div className="muted">
        {formatDateTime(e.at)} · {e.signedBy ? `assinado por ${e.signedBy}` : "assinatura removida"}
      </div>
      <div style={{ whiteSpace: "pre-wrap" }}>{e.data.performed}</div>
      {e.data.teeth.length > 0 ? <div>Dentes: {e.data.teeth.join(", ")}</div> : null}
      {e.data.notes ? (
        <div className="muted" style={{ whiteSpace: "pre-wrap" }}>
          {e.data.notes}
        </div>
      ) : null}
    </>
  );
}

/** The patient's clinical record: what was done in each visit. Entries are never edited. */
export default async function ClinicalRecordPage({
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
  const [record, entries, user] = await Promise.all([
    api.patientRecord(id).catch(missing),
    api.clinicalRecord(id).catch(missing),
    currentUser(),
  ]);
  const p = record.patient;
  const visits = threadsByVisit(entries);
  const canWrite = canWriteClinical(user) && !p.anonymizedAt;

  return (
    <>
      <Nav />
      <main>
        <p>
          <Link href={`/pacientes/${encodeURIComponent(p.id)}`}>← Ficha de {p.name}</Link>
        </p>
        <h1>Prontuário</h1>
        {aviso ? <p className="notice">{aviso}</p> : null}
        <p className="muted">
          A dentista registra a evolução na consulta, depois de marcar &quot;Compareceu&quot;. Um
          registro assinado não é editado nem apagado: para corrigir, a dentista assina um adendo.
          Só a equipe vê. O bot não lê.
        </p>
        {visits.length === 0 ? (
          <section className="card">
            <p style={{ margin: 0 }} className="muted">
              Nenhuma evolução registrada.
            </p>
          </section>
        ) : (
          visits.map((v) => (
            <section className="card" key={v.appointmentId}>
              <h2 style={{ marginTop: 0 }}>
                {formatDateTime(v.appointmentAt)} · {v.procedure}{" "}
                <Link href={`/consultas/${encodeURIComponent(v.appointmentId)}`}>
                  Abrir consulta
                </Link>
              </h2>
              {v.threads.map(({ entry, addenda }) => (
                <div key={entry.id} style={{ marginTop: 12 }}>
                  <EntryText e={entry} />
                  {addenda.map((a) => (
                    <div
                      key={a.id}
                      style={{
                        marginTop: 8,
                        paddingLeft: 12,
                        borderLeft: "3px solid var(--border)",
                      }}
                    >
                      <strong>Adendo</strong>
                      <EntryText e={a} />
                    </div>
                  ))}
                  {canWrite ? (
                    <details style={{ marginTop: 8 }}>
                      <summary>Assinar um adendo</summary>
                      <ClinicalEntryForm
                        action={addAddendum.bind(null, p.id, entry.id)}
                        label="Assinar adendo"
                        performedLabel="O que corrigir ou acrescentar"
                      />
                    </details>
                  ) : null}
                </div>
              ))}
            </section>
          ))
        )}
      </main>
    </>
  );
}
