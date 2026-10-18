import Link from "next/link";
import { api } from "@/lib/api";
import { formatCents, formatDate, formatDateTime, QUOTE_STATUS } from "@/lib/format";
import { acceptanceRate, waitingLabel } from "@/lib/quote-follow-up";
import { Nav } from "../nav";

export const dynamic = "force-dynamic";

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const filter = status && status in QUOTE_STATUS ? status : undefined;
  const [quotes, followUp] = await Promise.all([api.quotes(filter), api.quoteFollowUp()]);
  const rate = acceptanceRate(followUp.month);
  return (
    <>
      <Nav />
      <main id="conteudo">
        <div className="row" style={{ alignItems: "center", marginBottom: 12 }}>
          <h1 style={{ margin: 0 }}>Orçamentos</h1>
          <div style={{ flex: "0 0 auto" }}>
            <Link className="button" href="/orcamentos/novo">
              Novo orçamento
            </Link>
          </div>
        </div>
        <div className="card">
          <h2>Neste mês</h2>
          <p>
            {followUp.month.accepted} aprovado(s), {followUp.month.rejected} não aprovado(s) e{" "}
            {followUp.month.expired} vencido(s).{" "}
            {rate === null ? (
              <span className="muted">Nenhum orçamento respondido ainda.</span>
            ) : (
              <strong>Taxa de aceite: {rate}%</strong>
            )}
          </p>
        </div>
        <div className="card table-wrap">
          <h2>Aguardando resposta do paciente</h2>
          <p className="muted">
            O bot manda um lembrete 3 dias depois do envio. Quando a validade acaba, o orçamento
            vence sozinho.
          </p>
          {followUp.waiting.length === 0 ? (
            <p className="muted">Nenhum orçamento esperando resposta.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Paciente</th>
                  <th className="num">Total particular</th>
                  <th>Enviado</th>
                  <th>Lembrete</th>
                  <th>Validade</th>
                </tr>
              </thead>
              <tbody>
                {followUp.waiting.map((q) => (
                  <tr key={q.id}>
                    <td>
                      <Link href={`/orcamentos/${q.id}`}>{q.patientName}</Link>
                    </td>
                    <td className="num">{formatCents(q.totalCents)}</td>
                    <td>{waitingLabel(q.sentAt)}</td>
                    <td>{q.reminderSentAt ? formatDateTime(q.reminderSentAt) : "Ainda não"}</td>
                    <td>{q.validUntil ? formatDate(q.validUntil) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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
