export type NavLinkItem = { href: string; label: string };
export type NavGroup = { title: string; links: NavLinkItem[] };

/** Sidebar sections by task; the dentist-only pages are left out for everyone else. */
export function navGroups(role: string | undefined): NavGroup[] {
  const dentist = role === "DENTIST";
  const groups: NavGroup[] = [
    {
      title: "Hoje",
      links: [
        { href: "/", label: "Agenda" },
        { href: "/pendencias", label: "Pendências" },
        { href: "/autorizacoes", label: "Autorizações" },
      ],
    },
    {
      title: "Pacientes",
      links: [
        { href: "/pacientes", label: "Pacientes" },
        { href: "/orcamentos", label: "Orçamentos" },
        { href: "/espera", label: "Lista de espera" },
        { href: "/retorno", label: "Retorno" },
      ],
    },
    {
      title: "Financeiro",
      links: [
        { href: "/cobrancas", label: "Cobranças" },
        ...(dentist ? [{ href: "/resumo", label: "Resumo do mês" }] : []),
      ],
    },
    {
      title: "Clínica",
      links: [
        { href: "/clinica", label: "Cadastro da clínica" },
        ...(dentist ? [{ href: "/equipe", label: "Equipe" }] : []),
        { href: "/dados", label: "Dados (LGPD)" },
        ...(dentist ? [{ href: "/acessos", label: "Registro de acessos" }] : []),
      ],
    },
  ];
  return groups;
}

/** A link is active on its own path or any sub-path; "/" matches only itself. */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
