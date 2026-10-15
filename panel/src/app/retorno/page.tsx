import { api } from "@/lib/api";
import { dateKey, formatDate } from "@/lib/format";
import { consentAction, consentOrigin, recallCounts, recallStatus } from "@/lib/recall";
import { Nav } from "../nav";
import { setConsent } from "./actions";

export const dynamic = "force-dynamic";

const day = (iso: string) => formatDate(dateKey(iso));

/** Recall: patients due for a return visit and their consent to be invited by WhatsApp. */
export default async function RecallPage({
  searchParams,
}: {
  searchParams: Promise<{ aviso?: string }>;
}) {
  const { aviso } = await searchParams;
  const list = await api.recall();
  const counts = recallCounts(list.rows);

  return (
    <>
      <Nav />
      <main>
        {aviso ? <p className="notice">{aviso}</p> : null}
        <h1>Retorno</h1>
        <p className="muted">
          Pacientes com a última consulta há mais de {list.afterMonths} meses e nada marcado. O bot
          manda um convite para agendar ({list.schedule}), uma vez por última consulta, só a quem
          aceitou receber. Quem responde PARAR ou toca &quot;Não quero receber&quot; sai da lista de
          convites. O bot também pergunta ao paciente, uma vez, quando ele confirma uma consulta.
        </p>
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Texto do consentimento</h2>
          <p style={{ margin: 0 }}>&ldquo;{list.consentText}&rdquo;</p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Leia para o paciente (ou mostre) e registre só se ele aceitar.
          </p>
        </section>
        <p className="muted">
          {counts.due} para convidar · {counts.invited} convidados · {counts.no_consent} sem
          consentimento · {counts.opted_out} pediram para parar
        </p>
        <div className="card">
          {list.rows.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nenhum paciente com retorno pendente.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Paciente</th>
                    <th>Última consulta</th>
                    <th>Situação</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => {
                    const status = recallStatus(r);
                    const action = consentAction(r);
                    return (
                      <tr key={r.patientId}>
                        <td>
                          {r.patientName}
                          <br />
                          <span className="muted">{r.patientPhone}</span>
                        </td>
                        <td>
                          {day(r.lastVisitAt)}
                          <br />
                          <span className="muted">{r.lastProcedure}</span>
                        </td>
                        <td>
                          <span className={`badge ${status.tone}`}>{status.label}</span>
                          {r.status === "invited" && r.invitedAt ? (
                            <span className="muted"> em {day(r.invitedAt)}</span>
                          ) : null}
                          {r.status === "opted_out" && r.optedOutAt ? (
                            <span className="muted"> em {day(r.optedOutAt)}</span>
                          ) : null}
                          {consentOrigin(r) && r.consentAt ? (
                            <>
                              <br />
                              <span className="muted">
                                {consentOrigin(r)} em {day(r.consentAt)}
                              </span>
                            </>
                          ) : null}
                        </td>
                        <td>
                          <form action={setConsent.bind(null, r.patientId, action.granted)}>
                            {action.granted ? (
                              <label style={{ display: "block", marginBottom: 4 }}>
                                <input type="checkbox" name="confirm" required /> Paciente aceitou
                                {r.status === "opted_out" ? " de novo" : ""}
                              </label>
                            ) : null}
                            <button type="submit" className="secondary">
                              {action.label}
                            </button>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
