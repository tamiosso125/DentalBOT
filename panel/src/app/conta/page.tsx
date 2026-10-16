import { currentUser } from "@/lib/current-user";
import { roleLabel } from "@/lib/staff";
import { Nav } from "../nav";
import { changePassword } from "./actions";

export const dynamic = "force-dynamic";

/** The signed-in person changes their own password. */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ aviso?: string }>;
}) {
  const { aviso } = await searchParams;
  const user = await currentUser();
  return (
    <>
      <Nav />
      <main style={{ maxWidth: 480 }}>
        <h1>Minha senha</h1>
        {user ? (
          <p className="muted">
            {user.name} · {roleLabel(user.role)}
          </p>
        ) : null}
        {aviso ? <p className="notice">{aviso}</p> : null}
        <form action={changePassword} className="card stack">
          <label>
            Senha atual
            <input type="password" name="current" required autoComplete="current-password" />
          </label>
          <label>
            Senha nova (pelo menos 10 caracteres)
            <input
              type="password"
              name="password"
              required
              minLength={10}
              autoComplete="new-password"
            />
          </label>
          <label>
            Repita a senha nova
            <input
              type="password"
              name="confirm"
              required
              minLength={10}
              autoComplete="new-password"
            />
          </label>
          <button type="submit">Trocar senha</button>
        </form>
      </main>
    </>
  );
}
