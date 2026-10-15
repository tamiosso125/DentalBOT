import Link from "next/link";
import { api } from "@/lib/api";
import { formatCents, formatDate, formatDateTime, QUOTE_STATUS } from "@/lib/format";
import { Nav } from "../nav";

export const dynamic = "force-dynamic";

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const filter = status && status in QUOTE_STATUS ? status : undefined;
  const quotes = await api.quotes(filter);
  return (
    <>
      <Nav />
      <main>
        <div className="row" style={{ alignItems: "center", marginBottom: 12 }}>
          <h1 style={{ margin: 0 }}>Orçamentos</h1>
          <div style={{ flex: "0 0 auto" }}>
            <Link className="button" href="/orcamentos/novo">
              Novo orçamento
            </Link>
          </div>
        </div>
        <p>
          <Link href="/orcamentos">Todos</Link>
          {Object.entries(QUOTE_STATUS).map(([key, label]) => (
            <span key={key}>
              {" · "}
              {filter === key ? (
                <strong>{label}</strong>
              ) : (
                <Link href={`?status=${key}`}>{label}</Link>
              )}
            </span>
          ))}
        </p>
        <div className="card table-wrap">
          {quotes.length === 0 ? (
            <p className="muted">Nenhum orçamento.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Paciente</th>
                  <th className="num">Total particular</th>
                  <th>Status</th>
                  <th>Criado</th>
                  <th>Validade</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((q) => (
                  <tr key={q.id}>
                    <td>
                      <Link href={`/orcamentos/${q.id}`}>{q.patientName}</Link>
                    </td>
                    <td className="num">
                      {formatCents(q.totalCents)}
                      {q.installmentCount > 1 ? (
                        <div className="muted">em {q.installmentCount}x</div>
                      ) : null}
                    </td>
                    <td>{QUOTE_STATUS[q.status] ?? q.status}</td>
                    <td>{formatDateTime(q.createdAt)}</td>
                    <td>{q.validUntil ? formatDate(q.validUntil) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}
