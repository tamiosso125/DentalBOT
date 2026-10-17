import Link from "next/link";
import { api } from "@/lib/api";
import { pendingHref, pendingLabel, pendingSummary } from "@/lib/pending";
import { Nav } from "../nav";

export const dynamic = "force-dynamic";

/** Patients the front desk should contact or fix today, one row each. */
export default async function PendingPage() {
  const rows = await api.pending();
  return (
    <>
      <Nav />
      <main id="conteudo">
        <h1>Pendências</h1>
        <p className="muted">
          {pendingSummary(rows)} Parcelas vencidas, consultas dos próximos 7 dias sem confirmação e
          consultas dos últimos 30 dias sem marcação de compareceu ou faltou.
        </p>
        {rows.map((r) => (
          <section className="card" key={r.patientId}>
            <h2 style={{ marginTop: 0 }}>
              <Link href={`/pacientes/${encodeURIComponent(r.patientId)}`}>{r.patientName}</Link>
            </h2>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {r.items.map((i, n) => (
                <li key={`${i.kind}-${i.appointmentId ?? n}`}>
                  <Link href={pendingHref(r, i)}>{pendingLabel(i)}</Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
    </>
  );
}
