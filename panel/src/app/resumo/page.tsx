import Link from "next/link";
import { api } from "@/lib/api";
import { formatCents } from "@/lib/format";
import {
  delta,
  isMonth,
  METHOD_LABEL,
  monthLabel,
  noShowShare,
  share,
  shiftMonth,
} from "@/lib/report";
import { Nav } from "../nav";

export const dynamic = "force-dynamic";

/** Month at a glance for the dentist: visits, money received and quotes. */
export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string }>;
}) {
  const { mes } = await searchParams;
  const r = await api.report(isMonth(mes) ? mes : undefined);
  const n = r.numbers;
  const p = r.previous;
  const before = monthLabel(shiftMonth(r.month, -1)).split(" ")[0];
  const missed = noShowShare(n);
  const insuranceShare = share(n.attendedInsurance, n.attended);
  const acceptRate = share(n.quotesAccepted, n.quotesAccepted + n.quotesRejected);
  const methods = (Object.keys(METHOD_LABEL) as Array<keyof typeof METHOD_LABEL>).filter(
    (m) => n.receivedByMethod[m] > 0,
  );

  return (
    <>
      <Nav />
      <main>
        <p style={{ display: "flex", gap: 16 }}>
          <Link href={`/resumo?mes=${shiftMonth(r.month, -1)}`}>← {before}</Link>
          {r.current ? null : (
            <Link href={`/resumo?mes=${shiftMonth(r.month, 1)}`}>
              {monthLabel(shiftMonth(r.month, 1)).split(" ")[0]} →
            </Link>
          )}
        </p>
        <h1>Resumo de {monthLabel(r.month)}</h1>
        <p className="muted">
          {r.current ? "Mês em andamento: os números contam até agora. " : ""}
          Entre parênteses, a diferença para {before}.
        </p>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Consultas</h2>
          <p>
            <strong>{n.attended}</strong> atendidas ({delta(n.attended, p.attended)}) ·{" "}
            {n.attendedPrivate} particular · {n.attendedInsurance} convênio
            {insuranceShare === null ? "" : ` (${insuranceShare}%)`}
          </p>
          <p style={{ marginBottom: 0 }}>
            {n.noShow} faltas ({delta(n.noShow, p.noShow)})
            {missed === null ? "" : `, ${missed}% das consultas`} · {n.cancelled} canceladas
          </p>
          {r.topProcedures.length > 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              Mais feitos: {r.topProcedures.map((t) => `${t.name} (${t.count})`).join(", ")}
            </p>
          ) : null}
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Recebimentos</h2>
          <p>
            <strong>{formatCents(n.receivedCents)}</strong> recebidos{" "}
            <span className="muted">
              ({formatCents(p.receivedCents)} em {before})
            </span>
            {methods.length > 0 ? (
              <span className="muted">
                {" "}
                ·{" "}
                {methods
                  .map((m) => `${METHOD_LABEL[m]} ${formatCents(n.receivedByMethod[m])}`)
                  .join(" · ")}
              </span>
            ) : null}
          </p>
          <p style={{ marginBottom: 0 }}>
            {formatCents(n.dueOpenCents)} em parcelas que vencem no mês e ainda estão em aberto
            {n.lateCents > 0 ? (
              <>
                , das quais <strong>{formatCents(n.lateCents)}</strong> já venceram ·{" "}
                <Link href="/cobrancas?filtro=vencidas">ver vencidas</Link>
              </>
            ) : null}
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            {n.receivedAtClinicCents > 0
              ? `${formatCents(n.receivedAtClinicCents)} foram recebidos no balcão. `
              : ""}
            Conta as parcelas pagas pelo Asaas e o que a recepção registrou como pago na clínica (em{" "}
            <Link href="/cobrancas/clinica">Pagamentos na clínica</Link> ou na parcela). Repasses do
            convênio não aparecem aqui.
          </p>
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Orçamentos</h2>
          <p style={{ marginBottom: 0 }}>
            {n.quotesSent} enviados ({delta(n.quotesSent, p.quotesSent)}) · {n.quotesAccepted}{" "}
            aceitos, somando <strong>{formatCents(n.acceptedCents)}</strong> · {n.quotesRejected}{" "}
            recusados
            {acceptRate === null ? "" : ` · ${acceptRate}% de aceite entre os respondidos`}
          </p>
        </section>
        <p className="muted">
          Particular ou convênio: vale a resposta do convênio quando houve autorização; nos outros
          casos, o convênio atual do paciente cobrir o procedimento.
        </p>
      </main>
    </>
  );
}
