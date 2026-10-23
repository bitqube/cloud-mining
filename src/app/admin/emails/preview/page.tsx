import Link from "next/link";
import { Card, Page, cx } from "@/components/ui";
import { requireAdmin } from "@/lib/auth";
import { previewHtml } from "@/lib/email/images";
import { sampleEmails } from "@/lib/email/templates";

export const dynamic = "force-dynamic";

export default async function EmailPreview({ searchParams }: { searchParams: Promise<{ t?: string; view?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const all = sampleEmails();
  const current = all.find((e) => e.key === sp.t) ?? all[0];
  const text = sp.view === "text";
  const href = (t: string, view?: string) => `/admin/emails/preview?t=${t}${view ? `&view=${view}` : ""}`;

  return (
    <Page title="Email templates">
      <p className="mb-4 text-sm text-muted">
        Every email the platform sends, filled with sample data.{" "}
        <Link href="/admin/emails" className="text-accent">
          Back to the email log
        </Link>
      </p>
      <div className="no-scrollbar mb-4 flex gap-2 overflow-x-auto text-sm">
        {all.map((e) => (
          <Link
            key={e.key}
            href={href(e.key, text ? "text" : undefined)}
            className={cx(
              "shrink-0 whitespace-nowrap rounded-full px-3 py-1.5",
              e.key === current.key ? "bg-accent/15 text-accent" : "text-muted hover:text-text",
            )}
          >
            {e.key}
          </Link>
        ))}
      </div>
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-muted">Subject</div>
            <div className="font-medium break-words">{current.content.subject}</div>
          </div>
          <div className="flex gap-1 rounded-full border border-line p-1 text-sm">
            <Link href={href(current.key)} className={cx("rounded-full px-3 py-1", !text ? "bg-panel-2 text-text" : "text-muted")}>
              HTML
            </Link>
            <Link href={href(current.key, "text")} className={cx("rounded-full px-3 py-1", text ? "bg-panel-2 text-text" : "text-muted")}>
              Plain text
            </Link>
          </div>
        </div>
        {text ? (
          <pre className="overflow-x-auto rounded-xl bg-panel-2 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {current.content.text}
          </pre>
        ) : (
          <iframe
            title={current.key}
            srcDoc={previewHtml(current.content.html)}
            className="h-[1250px] w-full rounded-xl border border-line bg-[#05070b]"
          />
        )}
      </Card>
    </Page>
  );
}
