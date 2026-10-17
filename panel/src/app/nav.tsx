import Link from "next/link";
import { currentUser } from "@/lib/current-user";
import { navGroups } from "@/lib/nav-groups";
import { roleLabel } from "@/lib/staff";
import { logout } from "./actions";
import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";

export async function Nav() {
  const user = await currentUser();
  return (
    <header className="top">
      <strong className="brand">DentalBOT</strong>
      <nav aria-label="Principal">
        <NavLinks groups={navGroups(user?.role)} />
      </nav>
      <div className="nav-foot">
        {user ? (
          <Link href="/conta" title="Minha senha">
            {user.name} ({roleLabel(user.role)})
          </Link>
        ) : null}
        <ThemeToggle />
        <form action={logout}>
          <button type="submit" className="secondary">
            Sair
          </button>
        </form>
      </div>
    </header>
  );
}
