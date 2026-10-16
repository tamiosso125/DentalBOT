import Link from "next/link";
import { api } from "@/lib/api";
import { Nav } from "../nav";

export const dynamic = "force-dynamic";

/** Patient search: by name (accents ignored), birth date, or the full mobile number. */
export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  const results = query.length >= 2 ? await api.patients(query) : [];

  return (
    <>
      <Nav />
      <main>
        <h1>Pacientes</h1>
        <section className="card">
          <form className="row" method="get">
            <label>
              Nome, nascimento (dd/mm/aaaa) ou celular com DDD
              <input name="q" defaultValue={query} minLength={2} required autoFocus />
            </label>
            <div style={{ flex: "0 0 auto" }}>
              <button type="submit">Buscar</button>
            </div>
          </form>
          {query.length >= 2 ? (
            results.length === 0 ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                Nenhum paciente encontrado. O celular precisa estar completo, com DDD, e o
                nascimento no formato dd/mm/aaaa.
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Paciente</th>
                      <th>Celular</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Link href={`/pacientes/${encodeURIComponent(p.id)}`}>{p.name}</Link>
                        </td>
                        <td>final {p.phone.slice(-4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : null}
        </section>
      </main>
    </>
  );
}
