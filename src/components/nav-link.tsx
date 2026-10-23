"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

// Pill nav link that lights up on the current section.
export function NavLink({ href, children, exact = false }: { href: string; children: React.ReactNode; exact?: boolean }) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={cx(
        "shrink-0 rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap transition",
        active ? "bg-panel-2 text-text shadow-[0_0_0_1px_var(--line-strong)]" : "text-muted hover:text-text",
      )}
    >
      {children}
    </Link>
  );
}
