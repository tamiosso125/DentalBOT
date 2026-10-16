import Link from "next/link";
import { api } from "@/lib/api";
import { CLINIC_METHODS, methodLabel } from "@/lib/billing";
import { dateKey, formatCents, formatDate } from "@/lib/format";
import { Nav } from "../../nav";
import { createClinicPayment, voidClinicPayment } from "../actions";

export const dynamic = "force-dynamic";

/** Payments received at the front desk outside any quote: record, list and undo. */
export default async function ClinicPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ aviso?: string; q?: string; paciente?: string; nome?: string }>;
}) {
  const { aviso, q, paciente, nome } = await searchParams;
  const query = q?.trim() ?? "";
  const [rows, catalog, results] = await Promise.all([
    api.clinicPayments(),
    paciente ? api.catalog() : Promise.resolve(null),
    query.length >= 2 && !paciente ? api.patients(query) : Promise.resolve([]),
  ]);
  const today = dateKey(new Date());
  const total = rows.reduce((sum, r) => sum + r.amountCents, 0);

  return (
    <>
      <Nav />
      <main>
        <p>
          <Link href="/cobrancas">← Cobranças</Link>
        </p>
        {aviso ? <p className="notice">{aviso}</p> : null}
        <h1>Pagamentos na clínica</h1>
        <p className="muted">
          Registre aqui o que o paciente pagou no balcão sem passar por um orçamento: uma consulta
          em dinheiro, no cartão da maquininha ou por Pix direto para a clínica. Esses valores
          entram no resumo do mês. Para uma parcela de orçamento paga no balcão, use &quot;Pago na
          clínica&quot; na linha da parcela em <Link href="/cobrancas">Cobranças</Link>.
        </p>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Registrar pagamento</h2>
          {paciente && catalog ? (
            <form
              className="row"
              action={createClinicPayment.bind(null, paciente, nome ?? "Paciente")}
            >
              <p style={{ flexBasis: "100%", margin: 0 }}>
                Paciente: <strong>{nome}</strong> · <Link href="/cobrancas/clinica">trocar</Link>
              </p>
              <label>
                Valor (R$)
                <input name="amount" required inputMode="decimal" placeholder="150,00" />
              </label>
              <label>
                Forma
                <select name="method" required defaultValue="">
                  <option value="" disabled>
                    Escolha
                  </option>
                  {Object.entries(CLINIC_METHODS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Dia
                <input type="date" name="date" required max={today} defaultValue={today} />
              </label>
              <label>
                Procedimento (opcional)
                <select name="procedureId" defaultValue="">
                  <option value="">Nenhum</option>
                  {catalog.procedures.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ flex: "0 0 auto" }}>
                <button type="submit">Registrar</button>
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
          Últimos 60 dias · {rows.length} pagamento(s) · {formatCents(total)}
        </p>
        <div className="card">
          {rows.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nenhum pagamento registrado na clínica.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Dia</th>
                    <th>Paciente</th>
                    <th>Procedimento</th>
                    <th>Forma</th>
                    <th className="num">Valor</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{formatDate(r.paidOn)}</td>
                      <td>
                        {r.patientName}
                        <div className="muted">final {r.patientPhone.slice(-4)}</div>
                      </td>
                      <td>{r.procedureName ?? <span className="muted">-</span>}</td>
                      <td>{methodLabel(r.method)}</td>
                      <td className="num">{formatCents(r.amountCents)}</td>
                      <td>
                        <form action={voidClinicPayment.bind(null, r.id)}>
                          <button type="submit" className="secondary">
                            Desfazer
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
