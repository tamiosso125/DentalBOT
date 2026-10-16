import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { roleLabel, type StaffRow } from "@/lib/staff";
import { Nav } from "../nav";
import { createStaff, resetPassword, setActive } from "./actions";

export const dynamic = "force-dynamic";

/** The dentist registers the staff's logins, deactivates whoever leaves and resets passwords. */
export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ aviso?: string }>;
}) {
  const { aviso } = await searchParams;
  let rows: StaffRow[] | null = null;
  try {
    rows = await api.staff();
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 403)) throw err;
  }

  return (
    <>
      <Nav />
      <main>
        <h1>Equipe</h1>
        {aviso ? <p className="notice">{aviso}</p> : null}
        {rows === null ? (
          <p className="muted">Só a dentista cuida dos logins da equipe.</p>
        ) : (
          <>
            <p className="muted">
              Cada pessoa entra com o próprio e-mail e senha. Quem sair da clínica é desativado (o
              login para de funcionar na hora, e o histórico de acessos continua com o nome).
            </p>
            <section className="card">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Nome</th>
                      <th>Função</th>
                      <th>Último acesso</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((u) => (
                      <tr key={u.id}>
                        <td>
                          {u.name}
                          <div className="muted">{u.email}</div>
                        </td>
                        <td>
                          {roleLabel(u.role)}
                          {u.active ? null : (
                            <div>
                              <span className="badge danger">Desativado</span>
                            </div>
                          )}
                        </td>
                        <td>{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "-"}</td>
                        <td>
                          <form action={setActive.bind(null, u.id, u.name, !u.active)}>
                            <button type="submit" className="secondary">
                              {u.active ? "Desativar" : "Reativar"}
                            </button>
                          </form>
                          <form
                            action={resetPassword.bind(null, u.id, u.name)}
                            style={{ display: "flex", gap: 8, marginTop: 8 }}
                          >
                            <input
                              type="password"
                              name="password"
                              placeholder="Senha nova"
                              minLength={10}
                              required
                              autoComplete="new-password"
                              aria-label={`Senha nova de ${u.name}`}
                            />
                            <button type="submit" className="secondary">
                              Trocar
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card">
              <h2 style={{ marginTop: 0 }}>Novo login</h2>
              <form action={createStaff} className="stack">
                <label>
                  Nome
                  <input name="name" required maxLength={80} />
                </label>
                <label>
                  E-mail
                  <input type="email" name="email" required autoComplete="off" />
                </label>
                <label>
                  Função
                  <select name="role" defaultValue="RECEPTION">
                    <option value="RECEPTION">Recepção</option>
                    <option value="DENTIST">Dentista</option>
                  </select>
                </label>
                <label>
                  Senha inicial (pelo menos 10 caracteres)
                  <input
                    type="password"
                    name="password"
                    required
                    minLength={10}
                    autoComplete="new-password"
                  />
                </label>
                <label>
                  Repita a senha
                  <input
                    type="password"
                    name="confirm"
                    required
                    minLength={10}
                    autoComplete="new-password"
                  />
                </label>
                <button type="submit">Criar login</button>
              </form>
            </section>
          </>
        )}
      </main>
    </>
  );
}
