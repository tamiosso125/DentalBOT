import Link from "next/link";
import { api } from "@/lib/api";
import { Nav } from "../../nav";
import { QuoteForm } from "./quote-form";

export const dynamic = "force-dynamic";

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; paciente?: string; nome?: string }>;
}) {
  const { q, paciente, nome } = await searchParams;
  const query = q?.trim() ?? "";
  const [catalog, results] = await Promise.all([
    api.catalog(),
    query.length >= 2 && !paciente ? api.patients(query) : Promise.resolve([]),
  ]);

  return (
    <>
      <Nav />
      <main>
        <h1>Novo orçamento</h1>
        {!paciente ? (
          <section className="card">
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
                <p className="muted">
                  Nenhum paciente encontrado. O cadastro acontece quando o paciente agenda pelo
                  WhatsApp ou quando a recepção marca uma consulta em Agenda.
                </p>
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
          </section>
        ) : (
          <QuoteForm
            patientId={paciente}
            patientName={nome ?? "Paciente"}
            dentists={catalog.dentists}
            procedures={catalog.procedures}
          />
        )}
      </main>
    </>
  );
}
