import { NavLink } from "@/components/nav-link";
import { requireAdmin } from "@/lib/auth";

const NAV = [
  ["/admin", "Dashboard"],
  ["/admin/orders", "Orders"],
  ["/admin/users", "Users"],
  ["/admin/pricing", "Pricing"],
  ["/admin/packages", "Packages"],
  ["/admin/coins", "Coins"],
  ["/admin/rigs", "Rigs"],
  ["/admin/btq", "BTQ"],
  ["/admin/emails", "Emails"],
  ["/admin/settings", "Settings"],
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-0 md:flex-row">
      <aside className="border-b border-line px-4 py-3 md:sticky md:py-6 md:top-[61px] md:h-[calc(100vh-61px)] md:w-56 md:border-r md:border-b-0">
        <div className="mb-3 hidden px-3 text-[11px] font-medium uppercase tracking-[0.2em] text-accent md:block">Control room</div>
        <nav className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 [mask-image:linear-gradient(90deg,#000_80%,transparent)] md:mx-0 md:[mask-image:none] md:flex-col md:overflow-visible md:px-0">
          {NAV.map(([href, label]) => (
            <NavLink key={href} href={href} exact={href === "/admin"}>
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
