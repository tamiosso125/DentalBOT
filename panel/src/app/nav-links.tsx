"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActive, type NavGroup } from "@/lib/nav-groups";

export function NavLinks({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  return (
    <>
      {groups.map((group) => (
        <div key={group.title} className="nav-group">
          <p className="nav-title">{group.title}</p>
          {group.links.map((link) => {
            const active = isActive(pathname, link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={active ? "on" : undefined}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      ))}
    </>
  );
}
