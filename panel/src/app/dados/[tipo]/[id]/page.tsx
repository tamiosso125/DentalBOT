import Link from "next/link";
import { notFound } from "next/navigation";
import { api, ApiError, type PatientSummary } from "@/lib/api";
import { parseSubject } from "@/lib/data-subject";
import { dateKey, formatDate } from "@/lib/format";
import { Nav } from "../../../nav";
import { anonymize } from "../../actions";
import { AnonymizeForm } from "../../anonymize-form";

export const dynamic = "force-dynamic";

export default async function DataSubjectPage({
  params,
}: {
  params: Promise<{ tipo: string; id: string }>;
}) {
  const { tipo, id } = await params;
  const subject = parseSubject(tipo, id);
  if (!subject) notFound();

  let patient: PatientSummary | null = null;
  let title = "Pedido de dados";
  if (subject.kind === "patients") {
    try {
      patient = await api.patientSummary(id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) notFound();
      throw err;
    }
    title = patient.name;
  } else {
    const request = (await api.dataRequests()).find((r) => r.id === id);
    if (!request) notFound();
    title = request.patientName ?? `Contato final ${request.contact.slice(-4)}`;
  }
  const base = `/dados/${tipo}/${encodeURIComponent(id)}`;

  return (
    <>
      <Nav />
      <main id="conteudo">
        <p>
          <Link href="/dados">← Voltar</Link>
        </p>
        <h1>{title}</h1>
        {patient ? (
          <p className="muted">
            Final {patient.phone.slice(-4)} · {patient.appointments} consulta(s) · {patient.quotes}{" "}
            orçamento(s)
            {patient.openInstallments ? ` · ${patient.openInstallments} parcela(s) em aberto` : ""}
          </p>
        ) : null}

        {patient?.anonymizedAt ? (
          <p className="card">Dados anonimizados em {formatDate(dateKey(patient.anonymizedAt))}.</p>
        ) : (
          <>
            <section className="card stack">
              <h2 style={{ margin: 0 }}>Cópia dos dados</h2>
              <p className="muted" style={{ margin: 0 }}>
                Arquivo com cadastro, consentimentos, consultas, orçamentos, pagamentos e conversas.
                Contém CPF e celular completos: envie só ao próprio paciente e apague a cópia
                depois.
              </p>
              <div>
                <a className="button" href={`${base}/exportar`}>
                  Baixar dados (JSON)
                </a>
              </div>
            </section>
            <AnonymizeForm action={anonymize.bind(null, tipo, id)} />
          </>
        )}
      </main>
    </>
  );
}
