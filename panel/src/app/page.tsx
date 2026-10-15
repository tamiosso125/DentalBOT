import { api } from "@/lib/api";
import {
  APPOINTMENT_STATUS,
  dateKey,
  formatDate,
  formatDateTime,
  formatDayHeading,
  formatTime,
  groupByDay,
} from "@/lib/format";
import { Nav } from "./nav";

export const dynamic = "force-dynamic";

const DAYS = 7;

export default async function AgendaPage({
  searchParams,
}: {
  searchParams: Promise<{ de?: string }>;
}) {
  const { de } = await searchParams;
  const from = de && /^\d{4}-\d{2}-\d{2}$/.test(de) ? de : dateKey(new Date());
  const [rows, handoffs] = await Promise.all([api.agenda(from, DAYS), api.handoffs()]);
  const days = groupByDay(rows);
  const shift = (n: number) => {
    const d = new Date(`${from}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  return (
    <>
      <Nav />
      <main>
        {handoffs.length > 0 ? (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Esperando a recepção ({handoffs.length})</h2>
            <p className="muted">
              O bot está pausado nestas conversas. Responda pelo app WhatsApp Business.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Paciente</th>
                    <th>Celular</th>
                    <th>Última mensagem</th>
                    <th>Bot volta</th>
                  </tr>
                </thead>
                <tbody>
                  {handoffs.map((h) => (
                    <tr key={h.conversationId}>
                      <td>{h.patientName ?? <span className="muted">Sem cadastro</span>}</td>
                      <td>final {h.contact.slice(-4)}</td>
                      <td>{h.lastInboundAt ? formatDateTime(h.lastInboundAt) : "-"}</td>
                      <td>{formatDateTime(h.pausedUntil)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <div className="row" style={{ alignItems: "center", marginBottom: 8 }}>
          <h1 style={{ margin: 0 }}>Agenda a partir de {formatDate(from)}</h1>
          <div style={{ flex: "0 0 auto", display: "flex", gap: 8 }}>
            <a className="button secondary" href={`/?de=${shift(-DAYS)}`}>
              Semana anterior
            </a>
            <a className="button secondary" href={`/?de=${shift(DAYS)}`}>
              Próxima semana
            </a>
          </div>
        </div>

        {days.length === 0 ? (
          <p className="card muted">Nenhuma consulta nos próximos {DAYS} dias.</p>
        ) : (
          days.map(({ day, items }) => (
            <section key={day} className="card">
              <h2 style={{ marginTop: 0 }}>{formatDayHeading(items[0]!.startsAt)}</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Horário</th>
                      <th>Paciente</th>
                      <th>Procedimento</th>
                      <th>Dentista</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((a) => (
                      <tr key={a.id} className={a.status === "CANCELLED" ? "muted" : undefined}>
                        <td>
                          {formatTime(a.startsAt)}–{formatTime(a.endsAt)}
                        </td>
                        <td>
                          {a.patientName}
                          <div className="muted">final {a.patientPhone.slice(-4)}</div>
                        </td>
                        <td>{a.procedureName}</td>
                        <td>{a.dentistName}</td>
                        <td>
                          <span
                            className={`badge ${
                              a.status === "CONFIRMED"
                                ? "ok"
                                : a.status === "CANCELLED" || a.status === "NO_SHOW"
                                  ? "danger"
                                  : "warn"
                            }`}
                          >
                            {APPOINTMENT_STATUS[a.status] ?? a.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        )}
      </main>
    </>
  );
}
