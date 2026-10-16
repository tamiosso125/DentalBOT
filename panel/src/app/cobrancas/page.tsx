import Link from "next/link";
import { api } from "@/lib/api";
import { FILTERS, parseFilter, type Filter } from "@/lib/billing";
import { formatCents } from "@/lib/format";
import { Nav } from "../nav";
import { InstallmentsTable } from "./installments-table";

export const dynamic = "force-dynamic";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: string; aviso?: string }>;
}) {
  const sp = await searchParams;
  const filtro = parseFilter(sp.filtro);
  const [rows, summary] = await Promise.all([api.installments(filtro), api.billingSummary()]);

  return (
    <>
      <Nav />
      <main>
        {sp.aviso ? <p className="notice">{sp.aviso}</p> : null}
        <h1>Cobranças</h1>
        <div className="row" style={{ marginBottom: 16 }}>
          <div className="card" style={{ margin: 0 }}>
            <div className="muted">Em aberto</div>
            <strong>{formatCents(summary.openCents)}</strong>
          </div>
          <div className="card" style={{ margin: 0 }}>
            <div className="muted">Vencido ({summary.lateCount})</div>
            <strong style={summary.lateCents ? { color: "var(--danger)" } : undefined}>
              {formatCents(summary.lateCents)}
            </strong>
          </div>
          <div className="card" style={{ margin: 0 }}>
            <div className="muted">Para ligar</div>
            <strong style={summary.toCallCount ? { color: "var(--danger)" } : undefined}>
              {summary.toCallCount} parcela(s)
            </strong>
          </div>
          <div className="card" style={{ margin: 0 }}>
            <div className="muted">Recebido no mês</div>
            <strong>{formatCents(summary.paidThisMonthCents)}</strong>
          </div>
        </div>
        <p className="muted">
          A cobrança sai sozinha quando o paciente aprova o orçamento, e o lembrete de cada parcela
          vai pelo WhatsApp alguns dias antes do vencimento. Um dia depois do vencimento, o bot
          manda um aviso com o link de pagamento. O pagamento cai aqui quando o Asaas confirma. Se a
          parcela continuar em aberto uma semana depois do vencimento, ela aparece em &quot;Para
          ligar&quot;: ligue para o paciente.
        </p>
        <p>
          {(Object.entries(FILTERS) as Array<[Filter, string]>).map(([key, label], i) => (
            <span key={key}>
              {i > 0 ? " · " : null}
              {key === filtro ? (
                <strong>{label}</strong>
              ) : (
                <Link href={`?filtro=${key}`}>{label}</Link>
              )}
            </span>
          ))}
        </p>
        <div className="card">
          {rows.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nenhuma parcela {filtro === "todas" ? "" : FILTERS[filtro].toLowerCase()}.
            </p>
          ) : (
            <InstallmentsTable rows={rows} showPatient />
          )}
        </div>
      </main>
    </>
  );
}
