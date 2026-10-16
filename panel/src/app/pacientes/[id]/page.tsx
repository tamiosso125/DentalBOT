import Link from "next/link";
import { notFound } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { methodLabel } from "@/lib/billing";
import {
  APPOINTMENT_STATUS,
  dateKey,
  formatCents,
  formatDate,
  formatDateTime,
  QUOTE_STATUS,
} from "@/lib/format";
import { afterVisitLabel, birthLabel, countsLabel, recallLabel } from "@/lib/patient-record";
import { Nav } from "../../nav";

export const dynamic = "force-dynamic";

const day = (iso: string) => formatDate(dateKey(iso));

/** Everything the clinic has about one patient, read only, with links to act. */
export default async function PatientRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api.patientRecord(id).catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  });
  const p = r.patient;
  const now = new Date().toISOString();
  const pick = `paciente=${encodeURIComponent(p.id)}&nome=${encodeURIComponent(p.name)}`;

  return (
    <>
      <Nav />
      <main>
        <p>
          <Link href="/pacientes">← Pacientes</Link>
        </p>
        <h1>{p.name}</h1>
        {p.anonymizedAt ? (
          <p className="notice">
            Dados anonimizados em {day(p.anonymizedAt)} a pedido do paciente (LGPD). Ficam só os
            registros financeiros.
          </p>
        ) : null}
        {r.botPausedUntil ? (
          <p className="notice">
            A recepção está na conversa do WhatsApp: o bot volta às{" "}
            {formatDateTime(r.botPausedUntil)}.
          </p>
        ) : null}

        <section className="card">
          <div className="row">
            <div>
              <div className="muted">Celular</div>
              {p.phone ? `final ${p.phone.slice(-4)}` : "-"}
            </div>
            <div>
              <div className="muted">Nascimento</div>
              {p.birthDate ? birthLabel(p.birthDate, dateKey(now)) : "-"}
            </div>
            <div>
              <div className="muted">CPF</div>
              {p.hasCpf ? "Cadastrado" : "Não cadastrado"}
            </div>
            <div>
              <div className="muted">Convênio</div>
              {r.insurance
                ? `${r.insurance.plan}${r.insurance.cardEnd ? ` · carteirinha final ${r.insurance.cardEnd}` : " · sem carteirinha"}`
                : "Particular"}
            </div>
            <div>
              <div className="muted">Convites de retorno</div>
              {recallLabel(r)} <Link href="/retorno">Mudar</Link>
            </div>
            <div>
              <div className="muted">Cadastro</div>
              {day(p.createdAt)}
            </div>
          </div>
          {p.anonymizedAt ? null : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <Link className="button" href={`/consultas/nova?${pick}`}>
                Marcar consulta
              </Link>
              <Link className="button secondary" href={`/orcamentos/novo?${pick}`}>
                Criar orçamento
              </Link>
              <Link className="button secondary" href={`/espera?${pick}`}>
                Lista de espera
              </Link>
              <Link
                className="button secondary"
                href={`/dados/paciente/${encodeURIComponent(p.id)}`}
              >
                Dados (LGPD)
              </Link>
            </div>
          )}
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Consultas</h2>
          <p className="muted">{countsLabel(r.counts)}</p>
          {r.appointments.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              Nenhuma consulta.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Procedimento</th>
                    <th>Situação</th>
                    <th>Depois</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {r.appointments.map((a) => {
                    const after = afterVisitLabel(a);
                    return (
                      <tr key={a.id}>
                        <td>{formatDateTime(a.startsAt)}</td>
                        <td>
                          {a.procedure}
                          <div className="muted">{a.dentist}</div>
                        </td>
                        <td>
                          <span
                            className={`badge${a.status === "NO_SHOW" ? " danger" : a.status === "COMPLETED" ? " ok" : ""}`}
                          >
                            {APPOINTMENT_STATUS[a.status] ?? a.status}
                          </span>
                        </td>
                        <td>
                          {after ? (
                            <span className={a.aftercareAnswer === "HELP" ? "badge danger" : ""}>
                              {after}
                            </span>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                        <td>
                          <Link href={`/consultas/${encodeURIComponent(a.id)}`}>Abrir</Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {r.waitlist.length > 0 ? (
            <p style={{ marginBottom: 0 }}>
              Na lista de espera:{" "}
              {r.waitlist.map((w) => `${w.procedure} (até ${day(w.until)})`).join(", ")}
            </p>
          ) : null}
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Orçamentos e pagamentos</h2>
          <p>
            Em aberto: <strong>{formatCents(r.balance.openCents)}</strong>
            {r.balance.overdueCents > 0 ? (
              <>
                {" "}
                ·{" "}
                <span className="badge danger">vencido {formatCents(r.balance.overdueCents)}</span>
              </>
            ) : null}
          </p>
          {r.quotes.length === 0 ? (
            <p className="muted">Nenhum orçamento.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Criado</th>
                    <th>Situação</th>
                    <th className="num">Total</th>
                    <th className="num">Pago</th>
                    <th className="num">Em aberto</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {r.quotes.map((q) => (
                    <tr key={q.id}>
                      <td>{day(q.createdAt)}</td>
                      <td>
                        {QUOTE_STATUS[q.status] ?? q.status}
                        {q.installments > 1 ? (
                          <div className="muted">{q.installments} parcelas</div>
                        ) : null}
                      </td>
                      <td className="num">{formatCents(q.totalCents)}</td>
                      <td className="num">{q.installments ? formatCents(q.paidCents) : "-"}</td>
                      <td className="num">
                        {q.installments ? formatCents(q.openCents) : "-"}
                        {q.overdue > 0 ? (
                          <div>
                            <span className="badge danger">
                              {q.overdue} vencida{q.overdue > 1 ? "s" : ""}
                            </span>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <Link href={`/orcamentos/${encodeURIComponent(q.id)}`}>Abrir</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {r.clinicPayments.length > 0 ? (
            <>
              <h3>Pagos no balcão, fora de orçamento</h3>
              <ul style={{ marginBottom: 0 }}>
                {r.clinicPayments.map((c) => (
                  <li key={c.id}>
                    {day(c.paidAt)}: {formatCents(c.amountCents)} em {methodLabel(c.method)}
                    {c.procedure ? ` · ${c.procedure}` : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      </main>
    </>
  );
}
