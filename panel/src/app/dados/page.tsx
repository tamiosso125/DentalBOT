import Link from "next/link";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { Nav } from "../nav";
import { resolveRequest } from "./actions";

export const dynamic = "force-dynamic";

export default async function DataRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; aviso?: string }>;
}) {
  const { q, aviso } = await searchParams;
  const query = q?.trim() ?? "";
  const [requests, results] = await Promise.all([
    api.dataRequests(),
    query.length >= 2 ? api.patients(query) : Promise.resolve([]),
  ]);

  return (
    <>
      <Nav />
      <main>
        {aviso ? <p className="notice">{aviso}</p> : null}
        <h1>Dados dos pacientes (LGPD)</h1>
        <p className="muted">
          O paciente tem direito a uma cópia dos dados e a pedir a exclusão. Pelo WhatsApp ele pede
          escrevendo MEUS DADOS. Responda em até 15 dias.
        </p>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Pedidos em aberto ({requests.length})</h2>
          {requests.length === 0 ? (
            <p className="muted">Nenhum pedido esperando resposta.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Pedido em</th>
                    <th>Paciente</th>
                    <th>Celular</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      <td>{formatDateTime(r.createdAt)}</td>
                      <td>{r.patientName ?? <span className="muted">Sem cadastro</span>}</td>
                      <td>final {r.contact.slice(-4)}</td>
                      <td style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <Link href={`/dados/pedido/${encodeURIComponent(r.id)}`}>Atender</Link>
                        <form action={resolveRequest.bind(null, r.id)}>
                          <button type="submit" className="secondary">
                            Marcar como respondido
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Pedido por outro canal</h2>
          <form className="row" method="get">
            <label>
              Paciente (nome ou celular com DDD)
              <input name="q" defaultValue={query} minLength={2} required />
            </label>
            <div style={{ flex: "0 0 auto" }}>
              <button type="submit">Buscar</button>
            </div>
          </form>
          {query.length >= 2 ? (
            results.length === 0 ? (
              <p className="muted">Nenhum paciente encontrado.</p>
            ) : (
              <ul>
                {results.map((p) => (
                  <li key={p.id}>
                    <Link href={`/dados/paciente/${encodeURIComponent(p.id)}`}>{p.name}</Link>{" "}
                    <span className="muted">final {p.phone.slice(-4)}</span>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </section>
      </main>
    </>
  );
}
