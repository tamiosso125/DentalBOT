import { api } from "@/lib/api";
import { noShowFollowUpLabel, noShowRate } from "@/lib/attendance";
import {
  APPOINTMENT_STATUS,
  dateKey,
  formatDate,
  formatDateTime,
  formatDayHeading,
  formatTime,
  groupByDay,
} from "@/lib/format";
import Link from "next/link";
import { answerRate, averageLabel, RATING_LABEL } from "@/lib/survey";
import { aftercareLine } from "@/lib/aftercare";
import { markAttendance } from "./consultas/actions";
import { Nav } from "./nav";

export const dynamic = "force-dynamic";

const DAYS = 7;

export default async function AgendaPage({
  searchParams,
}: {
  searchParams: Promise<{
    de?: string;
    marcada?: string;
    remarcada?: string;
    cancelada?: string;
    presenca?: string;
    aviso?: string;
  }>;
}) {
  const { de, marcada, remarcada, cancelada, presenca, aviso } = await searchParams;
  const done = marcada ?? remarcada;
  const notice = aviso
    ? aviso
    : presenca
      ? presenca === "faltou"
        ? "Falta registrada."
        : "Comparecimento registrado."
      : cancelada
        ? "Consulta cancelada. O horário ficou livre."
        : done
          ? `Consulta ${marcada ? "marcada" : "remarcada"}.${
              done === "avisado"
                ? " O paciente recebeu o aviso pelo WhatsApp, com os botões Confirmar e Remarcar."
                : ""
            }`
          : null;
  const from = de && /^\d{4}-\d{2}-\d{2}$/.test(de) ? de : dateKey(new Date());
  const [rows, handoffs, attendance, billing, surveys, authorizations, aftercare] =
    await Promise.all([
      api.agenda(from, DAYS),
      api.handoffs(),
      api.attendance(),
      api.billingSummary(),
      api.surveys(),
      api.authorizations(),
      api.aftercare(),
    ]);
  const aftercareMonth = aftercareLine(aftercare.month);
  const answered = answerRate(surveys.month);
  const back = de ? `/?de=${from}` : "/";
  const rate = noShowRate(attendance.month);
  const followUp = noShowFollowUpLabel(attendance.month);
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
        {notice ? <p className="notice">{notice}</p> : null}
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

        {authorizations.pending.length > 0 ? (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>
              Autorizações de convênio pendentes ({authorizations.pending.length})
            </h2>
            <p className="muted" style={{ marginBottom: 0 }}>
              A próxima é {formatDateTime(authorizations.pending[0]!.startsAt)}. Peça no portal do
              convênio e marque o resultado. <Link href="/autorizacoes">Ver autorizações</Link>
            </p>
          </section>
        ) : null}

        {billing.toCallCount > 0 ? (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>
              Parcelas para cobrar por telefone ({billing.toCallCount})
            </h2>
            <p className="muted" style={{ marginBottom: 0 }}>
              Vencidas há uma semana ou mais, mesmo depois do aviso do bot.{" "}
              <Link href="/cobrancas?filtro=ligar">Ver parcelas</Link>
            </p>
          </section>
        ) : null}

        {attendance.pending.length > 0 ? (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Consultas sem marcação ({attendance.pending.length})</h2>
            <p className="muted">
              Já passaram do horário. Marque se o paciente veio: falta não conta como visita para o
              retorno.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Paciente</th>
                    <th>Procedimento</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {attendance.pending.map((a) => (
                    <tr key={a.id}>
                      <td>{formatDateTime(a.startsAt)}</td>
                      <td>
                        {a.patientName}
                        <div className="muted">final {a.patientPhone.slice(-4)}</div>
                      </td>
                      <td>{a.procedureName}</td>
                      <td>
                        <div style={{ display: "flex", gap: 8 }}>
                          <form action={markAttendance.bind(null, a.id, true, back)}>
                            <button type="submit">Compareceu</button>
                          </form>
                          <form action={markAttendance.bind(null, a.id, false, back)}>
                            <button type="submit" className="secondary">
                              Faltou
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Comparecimento neste mês</h2>
          <p style={{ marginBottom: 0 }}>
            {attendance.month.attended} atendidas · {attendance.month.noShow} faltas · taxa de falta{" "}
            {rate === null ? "-" : `${rate}%`}
            {followUp ? <span className="muted"> · {followUp}</span> : null}
          </p>
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Satisfação neste mês</h2>
          <p style={{ marginBottom: surveys.low.length > 0 ? undefined : 0 }}>
            Nota média {averageLabel(surveys.month.average)} · {surveys.month.answers} de{" "}
            {surveys.month.sent} responderam{answered === null ? "" : ` (${answered}%)`}
            {surveys.month.answers > 0 ? (
              <span className="muted">
                {" "}
                · {[5, 4, 3, 2, 1].map((n) => `${n}: ${surveys.month.byRating[n - 1]}`).join(" · ")}
              </span>
            ) : null}
          </p>
          {surveys.low.length > 0 ? (
            <>
              <p className="muted">
                Notas baixas dos últimos 30 dias. O bot já chamou a recepção: ligue para entender o
                que aconteceu.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Paciente</th>
                      <th>Consulta</th>
                      <th>Nota</th>
                      <th>Respondeu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {surveys.low.map((l) => (
                      <tr key={l.surveyId}>
                        <td>
                          {l.patientName}
                          <div className="muted">final {l.patientPhone.slice(-4)}</div>
                        </td>
                        <td>{formatDateTime(l.appointmentAt)}</td>
                        <td>
                          <span className="badge danger">{RATING_LABEL[l.rating] ?? l.rating}</span>
                        </td>
                        <td>{formatDateTime(l.answeredAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>

        {aftercareMonth || aftercare.help.length > 0 ? (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Pós-procedimento neste mês</h2>
            <p style={{ marginBottom: aftercare.help.length > 0 ? undefined : 0 }}>
              {aftercareMonth ?? "Nenhum cuidado enviado neste mês."}
            </p>
            {aftercare.help.length > 0 ? (
              <>
                <p className="muted">
                  Tocaram &quot;Preciso de ajuda&quot; nos últimos 14 dias. O bot já chamou a
                  recepção e orientou procurar o pronto-socorro em caso de sinal de alarme: fale com
                  o paciente e, se preciso, com a dentista.
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Paciente</th>
                        <th>Procedimento</th>
                        <th>Consulta</th>
                        <th>Pediu ajuda</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aftercare.help.map((h) => (
                        <tr key={h.followUpId}>
                          <td>
                            {h.patientName}
                            <div className="muted">final {h.patientPhone.slice(-4)}</div>
                          </td>
                          <td>{h.procedureName}</td>
                          <td>{formatDateTime(h.appointmentAt)}</td>
                          <td>
                            <span className="badge danger">{formatDateTime(h.answeredAt)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
          </section>
        ) : null}

        <div className="row" style={{ alignItems: "center", marginBottom: 8 }}>
          <h1 style={{ margin: 0 }}>Agenda a partir de {formatDate(from)}</h1>
          <div style={{ flex: "0 0 auto", display: "flex", gap: 8 }}>
            <Link className="button" href="/consultas/nova">
              Marcar consulta
            </Link>
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
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((a) => (
                      <tr key={a.id} className={a.status === "CANCELLED" ? "muted" : undefined}>
                        <td>
                          {formatTime(a.startsAt)}–{formatTime(a.endsAt)}
                        </td>
                        <td>
                          <Link href={`/pacientes/${encodeURIComponent(a.patientId)}`}>
                            {a.patientName}
                          </Link>
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
                        <td>
                          {a.status === "CANCELLED" ? null : (
                            <Link href={`/consultas/${encodeURIComponent(a.id)}`}>
                              {a.status === "PENDING_CONFIRMATION" || a.status === "CONFIRMED"
                                ? "Alterar"
                                : "Abrir"}
                            </Link>
                          )}
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
