import Link from "next/link";
import { notFound } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { formatCents, formatDate, formatDateTime, QUOTE_STATUS } from "@/lib/format";
import { InstallmentsTable } from "../../cobrancas/installments-table";
import { Nav } from "../../nav";
import { sendQuote } from "../actions";

export const dynamic = "force-dynamic";

export default async function QuotePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ criado?: string; enviado?: string }>;
}) {
  const { id } = await params;
  const { criado, enviado } = await searchParams;
  const q = await api.quote(id).catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  });
  const canSend = q.status === "DRAFT" || q.status === "SENT";
  const installments = q.status === "ACCEPTED" ? await api.installments("todas", q.id) : [];

  return (
    <>
      <Nav />
      <main>
        <p>
          <Link href="/orcamentos">← Orçamentos</Link>
        </p>
        {criado ? <p className="notice">Orçamento criado. Confira e envie ao paciente.</p> : null}
        {enviado ? (
          <p className="notice">
            {enviado === "session"
              ? "Enviado pelo WhatsApp com o PDF e os botões Aprovar e Não aprovar."
              : "O paciente não escreveu nas últimas 24 h: foi o aviso aprovado pela Meta, e o PDF vai quando ele tocar em Ver orçamento."}
          </p>
        ) : null}
        <h1>Orçamento de {q.patientName}</h1>
        <section className="card">
          <p>
            Status: <strong>{QUOTE_STATUS[q.status] ?? q.status}</strong>
            {q.sentAt ? <> · enviado em {formatDateTime(q.sentAt)}</> : null}
            {q.respondedAt ? <> · respondido em {formatDateTime(q.respondedAt)}</> : null}
          </p>
          <p className="muted">
            Dentista: {q.dentistName}
            {q.validUntil ? <> · válido até {formatDate(q.validUntil)}</> : null}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Procedimento</th>
                  <th className="num">Qtd</th>
                  <th className="num">Valor unit.</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {q.items.map((i, n) => (
                  <tr key={n}>
                    <td>{i.description}</td>
                    <td className="num">{i.quantity}</td>
                    <td className="num">
                      {i.coverage === "INSURANCE" ? "convênio" : formatCents(i.unitPriceCents)}
                    </td>
                    <td className="num">
                      {i.coverage === "INSURANCE"
                        ? "coberto"
                        : formatCents(i.unitPriceCents * i.quantity)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="num" style={{ textAlign: "right" }}>
            <strong>Total particular: {formatCents(q.totalCents)}</strong>
            {q.installmentCount > 1 ? ` em ${q.installmentCount}x` : " à vista"}
          </p>
          {q.notes ? <p className="muted">Observações: {q.notes}</p> : null}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <div style={{ flex: "0 0 auto" }}>
              <a className="button secondary" href={`/orcamentos/${q.id}/pdf`} target="_blank">
                Ver PDF
              </a>
            </div>
            {canSend ? (
              <form action={sendQuote.bind(null, q.id)} style={{ flex: "0 0 auto" }}>
                <button type="submit">
                  {q.status === "SENT" ? "Reenviar pelo WhatsApp" : "Enviar pelo WhatsApp"}
                </button>
              </form>
            ) : null}
          </div>
        </section>
        {installments.length ? (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Parcelas</h2>
            <InstallmentsTable rows={installments} />
          </section>
        ) : null}
      </main>
    </>
  );
}
