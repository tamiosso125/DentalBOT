import Link from "next/link";
import { api } from "@/lib/api";
import { cardGroups, decisionLabel, noticeLabel } from "@/lib/authorizations";
import { formatDateTime } from "@/lib/format";
import { Nav } from "../nav";
import { decideAuthorization } from "./actions";

export const dynamic = "force-dynamic";

/** Prior authorization: the front desk asks the insurer's portal and records the answer. */
export default async function AuthorizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ aviso?: string }>;
}) {
  const { aviso } = await searchParams;
  const list = await api.authorizations();

  return (
    <>
      <Nav />
      <main>
        {aviso ? <p className="notice">{aviso}</p> : null}
        <h1>Autorizações de convênio</h1>
        <p className="muted">
          Consultas de pacientes de convênio cujo procedimento pede autorização prévia (veja em{" "}
          <Link href="/clinica/convenios">Clínica › Convênios</Link>). Peça a autorização no portal
          do convênio com o número da carteirinha e marque o resultado: o bot avisa o paciente pelo
          WhatsApp. Se for negada, o paciente pode seguir como particular ou falar com a recepção.
        </p>

        <h2>Pendentes ({list.pending.length})</h2>
        <div className="card">
          {list.pending.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nenhuma autorização pendente.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Consulta</th>
                    <th>Paciente</th>
                    <th>Procedimento</th>
                    <th>Convênio e carteirinha</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.pending.map((r) => (
                    <tr key={r.appointmentId}>
                      <td>
                        <Link href={`/consultas/${encodeURIComponent(r.appointmentId)}`}>
                          {formatDateTime(r.startsAt)}
                        </Link>
                      </td>
                      <td>
                        {r.patientName}
                        <div className="muted">final {r.patientPhone.slice(-4)}</div>
                      </td>
                      <td>{r.procedureName}</td>
                      <td>
                        {r.planName}
                        <div>
                          {r.card ? (
                            <code title={r.card}>{cardGroups(r.card)}</code>
                          ) : (
                            <Link href={`/consultas/${encodeURIComponent(r.appointmentId)}`}>
                              Sem carteirinha: cadastrar
                            </Link>
                          )}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 8 }}>
                          <form action={decideAuthorization.bind(null, r.appointmentId, true)}>
                            <button type="submit">Autorizado</button>
                          </form>
                          <form action={decideAuthorization.bind(null, r.appointmentId, false)}>
                            <button type="submit" className="secondary">
                              Negado
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <h2>Registradas</h2>
        <p className="muted">Consultas dos últimos 30 dias em diante.</p>
        <div className="card">
          {list.decided.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nenhuma autorização registrada ainda.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Consulta</th>
                    <th>Paciente</th>
                    <th>Procedimento</th>
                    <th>Convênio</th>
                    <th>Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {list.decided.map((r) => {
                    const status = decisionLabel(r);
                    return (
                      <tr key={r.appointmentId}>
                        <td>
                          <Link href={`/consultas/${encodeURIComponent(r.appointmentId)}`}>
                            {formatDateTime(r.startsAt)}
                          </Link>
                        </td>
                        <td>
                          {r.patientName}
                          <div className="muted">final {r.patientPhone.slice(-4)}</div>
                        </td>
                        <td>{r.procedureName}</td>
                        <td>{r.planName}</td>
                        <td>
                          <span className={`badge ${status.tone}`}>{status.label}</span>
                          <div className="muted">
                            {r.decidedAt ? `em ${formatDateTime(r.decidedAt)} · ` : ""}
                            {noticeLabel(r)}
                          </div>
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
