import Link from "next/link";
import { api } from "@/lib/api";
import { dateKey, formatDate, formatDateTime } from "@/lib/format";
import { defaultUntil, lastOfferText, untilDay, waitlistStatus } from "@/lib/waitlist";
import { Nav } from "../nav";
import { addToWaitlist, removeFromWaitlist } from "./actions";

export const dynamic = "force-dynamic";

/** Waiting list: who waits for an earlier slot, and adding or removing a patient. */
export default async function WaitlistPage({
  searchParams,
}: {
  searchParams: Promise<{ aviso?: string; q?: string; paciente?: string; nome?: string }>;
}) {
  const { aviso, q, paciente, nome } = await searchParams;
  const query = q?.trim() ?? "";
  const [list, catalog, results] = await Promise.all([
    api.waitlist(),
    api.catalog(),
    query.length >= 2 && !paciente ? api.patients(query) : Promise.resolve([]),
  ]);
  const today = dateKey(new Date());
  const waiting = list.rows.filter((r) => r.status === "WAITING").length;

  return (
    <>
      <Nav />
      <main id="conteudo">
        {aviso ? <p className="notice">{aviso}</p> : null}
        <h1>Lista de espera</h1>
        <p className="muted">
          Quando abre um horário antes da data que o paciente pediu (por cancelamento ou
          remarcação), o bot oferece a vaga pelo WhatsApp aos três primeiros da fila daquele
          procedimento ({list.schedule}). Quem tocar &quot;Quero esse horário&quot; primeiro fica
          com ela; se o paciente já tinha uma consulta mais tarde, ela é antecipada. Os pacientes
          também entram na lista pela conversa com o bot.
        </p>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Colocar na lista</h2>
          {paciente ? (
            <form className="row" action={addToWaitlist.bind(null, paciente, nome ?? "Paciente")}>
              <p style={{ flexBasis: "100%", margin: 0 }}>
                Paciente: <strong>{nome}</strong> · <Link href="/espera">trocar</Link>
              </p>
              <label>
                Procedimento
                <select name="procedureId" required defaultValue="">
                  <option value="" disabled>
                    Escolha
                  </option>
                  {catalog.procedures.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Avisar vagas até
                <input
                  type="date"
                  name="until"
                  required
                  min={today}
                  defaultValue={defaultUntil(today)}
                />
              </label>
              <div style={{ flex: "0 0 auto" }}>
                <button type="submit">Colocar na lista</button>
              </div>
            </form>
          ) : (
            <>
              <form className="row" method="get">
                <label>
                  Paciente (nome ou celular com DDD)
                  <input name="q" defaultValue={query} minLength={2} required />
                </label>
                <div style={{ flex: "0 0 auto" }}>
                  <button type="submit" className="secondary">
                    Buscar
                  </button>
                </div>
              </form>
              {query.length >= 2 ? (
                results.length === 0 ? (
                  <p className="muted">Nenhum paciente encontrado.</p>
                ) : (
                  <ul>
                    {results.map((p) => (
                      <li key={p.id}>
                        <Link
                          href={`?paciente=${encodeURIComponent(p.id)}&nome=${encodeURIComponent(p.name)}`}
                        >
                          {p.name}
                        </Link>{" "}
                        <span className="muted">final {p.phone.slice(-4)}</span>
                      </li>
                    ))}
                  </ul>
                )
              ) : null}
            </>
          )}
        </section>

        <p className="muted">
          {waiting} esperando vaga · mostra também quem saiu da lista nos últimos 30 dias
        </p>
        <div className="card">
          {list.rows.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Ninguém na lista de espera.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Paciente</th>
                    <th>Procedimento</th>
                    <th>Até</th>
                    <th>Situação</th>
                    <th>Última vaga oferecida</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => {
                    const status = waitlistStatus(r);
                    return (
                      <tr key={r.id} className={r.status === "WAITING" ? undefined : "muted"}>
                        <td>
                          {r.patientName}
                          <div className="muted">final {r.patientPhone.slice(-4)}</div>
                        </td>
                        <td>{r.procedureName}</td>
                        <td>{untilDay(r)}</td>
                        <td>
                          <span className={`badge ${status.tone}`}>{status.label}</span>
                          <div className="muted">
                            {r.closedAt
                              ? `em ${formatDateTime(r.closedAt)}`
                              : `desde ${formatDate(dateKey(r.createdAt))}`}
                          </div>
                        </td>
                        <td>{lastOfferText(r) ?? <span className="muted">Nenhuma ainda</span>}</td>
                        <td>
                          {r.status === "WAITING" ? (
                            <form action={removeFromWaitlist.bind(null, r.id)}>
                              <button type="submit" className="secondary">
                                Tirar da lista
                              </button>
                            </form>
                          ) : null}
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
