import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { actionLabel, targetHref, type AccessLogPage } from "@/lib/access-log";
import { formatDate, formatDateTime } from "@/lib/format";
import { Nav } from "../nav";

export const dynamic = "force-dynamic";

/** Who touched patient data in the panel, for LGPD questions. Never shows content. */
export default async function AccessLogPage({
  searchParams,
}: {
  searchParams: Promise<{ paciente?: string; de?: string; ate?: string }>;
}) {
  const { paciente, de, ate } = await searchParams;
  let page: AccessLogPage | null = null;
  let error: string | null = null;
  try {
    page = await api.accessLog({ patientId: paciente, from: de, to: ate });
  } catch (err) {
    if (!(err instanceof ApiError && (err.status === 400 || err.status === 403))) throw err;
    error = err.detail;
  }
  const name = page?.entries.find((e) => e.patientId === paciente)?.patientName;

  return (
    <>
      <Nav />
      <main id="conteudo">
        <h1>Acessos aos dados dos pacientes</h1>
        <p className="muted">
          O painel registra quando alguém da equipe abre, exporta ou muda dados de um paciente: o
          que foi feito, quando e com qual paciente, nunca o conteúdo. Como cada pessoa entra com
          login próprio, o registro mostra quem foi (registros de antes dos logins individuais ficam
          sem nome). Os registros antigos são apagados sozinhos.
        </p>
        <form className="row" method="get">
          {paciente ? <input type="hidden" name="paciente" value={paciente} /> : null}
          <label>
            De
            <input type="date" name="de" defaultValue={page?.from ?? de} />
          </label>
          <label>
            Até
            <input type="date" name="ate" defaultValue={page?.to ?? ate} />
          </label>
          <button type="submit" className="secondary">
            Filtrar
          </button>
        </form>
        {paciente ? (
          <p>
            Só de {name ?? "um paciente"}. <Link href="/acessos">Ver de todos</Link>
          </p>
        ) : null}
        {error ? <p className="notice">{error}</p> : null}
        {page ? (
          <section className="card">
            <p className="muted" style={{ marginTop: 0 }}>
              {formatDate(page.from)} a {formatDate(page.to)}: {page.entries.length}{" "}
              {page.entries.length === 1 ? "registro" : "registros"}
              {page.truncated ? " (mostrando os mais recentes; escolha um período menor)" : ""}
            </p>
            {page.entries.length === 0 ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                Nenhum acesso no período.
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Quando</th>
                      <th>Quem</th>
                      <th>O que</th>
                      <th>Paciente</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.entries.map((e) => {
                      const href = targetHref(e);
                      return (
                        <tr key={e.id}>
                          <td>{formatDateTime(e.at)}</td>
                          <td>{e.staffName ?? <span className="muted">-</span>}</td>
                          <td>
                            {href ? (
                              <Link href={href}>{actionLabel(e.action)}</Link>
                            ) : (
                              actionLabel(e.action)
                            )}
                          </td>
                          <td>
                            {e.patientId && e.patientName ? (
                              <Link href={`/pacientes/${encodeURIComponent(e.patientId)}`}>
                                {e.patientName}
                              </Link>
                            ) : (
                              <span className="muted">-</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}
      </main>
    </>
  );
}
