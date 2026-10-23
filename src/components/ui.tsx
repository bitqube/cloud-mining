import Link from "next/link";
import type { OrderStatus } from "@prisma/client";
import { Children, cloneElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";

export function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(" ");
}

export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-7 sm:px-6 sm:py-10">
      <div className="rise mb-8 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-3xl font-semibold sm:text-4xl">{title}</h1>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("glass edge-glow min-w-0 rounded-3xl p-5 sm:p-6", className)}>
      {title && <h2 className="mb-5 font-sans text-xs font-medium uppercase tracking-[0.18em] text-muted">{title}</h2>}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="glass edge-glow min-w-0 rounded-3xl p-4 sm:p-5">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted sm:text-[11px] sm:tracking-[0.18em]">{label}</div>
      <div className="num mt-2 truncate text-xl sm:text-2xl">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

const button = {
  primary: "btn-primary",
  secondary: "glass text-text hover:border-line-strong",
  danger: "border border-bad/50 bg-bad/10 text-bad hover:bg-bad/20",
};

export function Button({ variant = "primary", className, ...props }: ComponentProps<"button"> & { variant?: keyof typeof button }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold whitespace-nowrap transition duration-300 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
        button[variant],
        className,
      )}
    />
  );
}

export function ButtonLink({ variant = "primary", className, ...props }: ComponentProps<typeof Link> & { variant?: keyof typeof button }) {
  return (
    <Link
      {...props}
      className={cx("inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition duration-300 active:scale-[0.98]", button[variant], className)}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.14em] text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      {...props}
      className={cx(
        "w-full rounded-xl border border-line bg-bg/60 px-3.5 py-2.5 text-sm text-text transition placeholder:text-muted/60 focus:border-accent focus:shadow-[0_0_0_4px_color-mix(in_oklab,var(--accent)_18%,transparent)] focus:outline-none",
        className,
      )}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      {...props}
      className={cx("w-full rounded-xl border border-line bg-bg/60 px-3.5 py-2.5 text-sm text-text transition focus:border-accent focus:shadow-[0_0_0_4px_color-mix(in_oklab,var(--accent)_18%,transparent)] focus:outline-none", className)}
    />
  );
}

export function Alert({ tone = "info", children }: { tone?: "info" | "error" | "ok" | "warn"; children: ReactNode }) {
  const tones = {
    info: "border-accent/30 bg-accent/10",
    error: "border-bad/40 bg-bad/10 text-bad",
    ok: "border-ok/40 bg-ok/10 text-ok",
    warn: "border-warn/40 bg-warn/10 text-warn",
  };
  return <div className={cx("rounded-2xl border px-4 py-3 text-sm backdrop-blur", tones[tone])}>{children}</div>;
}

const STATUS_TONE: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "bg-warn/15 text-warn",
  PAID: "bg-blue/15 text-blue",
  QUEUED: "bg-accent/15 text-accent",
  PROVISIONING: "bg-accent/15 text-accent",
  ACTIVE: "bg-ok/15 text-ok",
  COMPLETED: "bg-ok/15 text-ok",
  PARTIAL: "bg-warn/15 text-warn",
  FAILED: "bg-bad/15 text-bad",
  REFUNDED: "bg-panel-2 text-muted",
  CANCELLED: "bg-panel-2 text-muted",
};

const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "Awaiting payment",
  PAID: "Paid",
  QUEUED: "Scheduled",
  PROVISIONING: "Starting",
  ACTIVE: "Mining",
  COMPLETED: "Completed",
  PARTIAL: "Partly delivered",
  FAILED: "Failed",
  REFUNDED: "Refunded",
  CANCELLED: "Cancelled",
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", STATUS_TONE[status])}>
      {status === "ACTIVE" && <span className="live-dot !h-1.5 !w-1.5" />}
      {STATUS_LABEL[status]}
    </span>;
}

// On phones each row turns into a card whose cells are labelled with the column heading
// (see .stack in globals.css), so nothing has to scroll sideways.
function labelCells(row: ReactNode, head: ReactNode[]): ReactNode {
  if (!isValidElement(row) || row.type !== "tr") return row;
  const tr = row as ReactElement<{ children?: ReactNode }>;
  const cells = Children.toArray(tr.props.children).map((cell, i) =>
    isValidElement(cell) ? cloneElement(cell as ReactElement<{ label?: string }>, { label: typeof head[i] === "string" ? head[i] : "" }) : cell,
  );
  return cloneElement(tr, {}, ...cells);
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: string }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className="glass overflow-x-auto rounded-3xl">
      <table className="stack w-full text-left text-sm">
        <thead className="border-b border-line text-[11px] uppercase tracking-[0.16em] text-muted">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="px-4 py-3 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line [&>tr]:transition-colors [&>tr:hover]:bg-accent/[0.04]">
          {hasRows ? (
            Children.map(children, (row) => labelCells(row, head))
          ) : (
            <tr>
              <td colSpan={head.length} className="px-4 py-8 text-center text-muted">
                {empty ?? "Nothing here yet."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Td({ children, className, label }: { children?: ReactNode; className?: string; label?: string }) {
  return (
    <td data-label={label ?? ""} className={cx("px-4 py-3 align-middle", className)}>
      {children}
    </td>
  );
}
