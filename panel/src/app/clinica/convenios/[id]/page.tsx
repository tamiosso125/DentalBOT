import Link from "next/link";
import { notFound } from "next/navigation";
import { api } from "@/lib/api";
import { coverField, describePrice } from "@/lib/clinic-form";
import { Nav } from "../../../nav";
import { saveCoverage, updatePlan } from "../../actions";
import { SetupForm } from "../../setup-form";

export const dynamic = "force-dynamic";

export default async function PlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ aviso?: string }>;
}) {
  const [{ id }, { aviso }] = await Promise.all([params, searchParams]);
  const view = await api.setup();
  const plan = view.insurancePlans.find((p) => p.id === id);
  if (!plan) notFound();
  const coverage = new Map(plan.coverage.map((c) => [c.procedureId, c]));

  return (
    <>
      <Nav />
      <main id="conteudo">
        {aviso ? <p className="notice">{aviso}</p> : null}
        <p>
          <Link href="/clinica">← Cadastro da clínica</Link>
        </p>
        <h1>{plan.name}</h1>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Procedimentos cobertos</h2>
          <p className="muted">
            O bot só diz que um procedimento é coberto se ele estiver marcado aqui, e avisa quando
            pede autorização prévia. Para os outros, diz que não consta como coberto e que a
            recepção confirma. Carteirinha e elegibilidade continuam sendo conferidas pela recepção
            no portal do convênio.
          </p>
          {view.procedures.length ? (
            <SetupForm action={saveCoverage.bind(null, plan.id)} submit="Salvar cobertura">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Procedimento</th>
                      <th className="num">Particular</th>
                      <th>Cobre</th>
                      <th>Autorização prévia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.procedures.map((p) => (
                      <tr key={p.id}>
                        <td>
                          {p.name} {p.active ? null : <span className="badge">Inativo</span>}
                        </td>
                        <td className="num">{describePrice(p.priceCents)}</td>
                        <td>
                          <input
                            type="checkbox"
                            name={coverField(p.id, "cover")}
                            aria-label={`${plan.name} cobre ${p.name}`}
                            defaultChecked={coverage.has(p.id)}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            name={coverField(p.id, "auth")}
                            aria-label={`${p.name} pede autorização prévia`}
                            defaultChecked={coverage.get(p.id)?.requiresAuthorization ?? false}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ margin: 0 }}>
                Marcar autorização prévia já conta o procedimento como coberto.
              </p>
            </SetupForm>
          ) : (
            <p className="muted">Cadastre os procedimentos primeiro.</p>
          )}
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Nome do convênio</h2>
          <SetupForm action={updatePlan.bind(null, plan.id)} submit="Salvar">
            <label>
              Nome
              <input name="name" defaultValue={plan.name} required maxLength={60} />
            </label>
          </SetupForm>
        </section>
      </main>
    </>
  );
}
