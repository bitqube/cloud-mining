import Decimal from "decimal.js";
import { Button, Card, Input, Page, Table, Td } from "@/components/ui";
import { Flash } from "@/components/flash";
import { db } from "@/lib/db";
import { dateTime, multiplier, usd } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { diditConfig } from "@/lib/kyc/didit";
import { setKycStatusAction, setSettingAction, setSuspendedAction, setUserMultiplierAction, setUserRoleAction } from "../actions";

export const dynamic = "force-dynamic";

const KYC_LABEL = { NONE: "Not verified", PENDING: "In progress", REVIEW: "In review", APPROVED: "Verified", DECLINED: "Declined" } as const;

export default async function AdminUsers({ searchParams }: { searchParams: Promise<{ q?: string; ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const q = sp.q?.trim().toLowerCase();
  const [settings, users] = await Promise.all([
    getSettings(db),
    db.user.findMany({
      where: q ? { OR: [{ email: { contains: q } }, { name: { contains: q, mode: "insensitive" } }] } : {},
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { orders: { where: { status: { in: ["PAID", "PROVISIONING", "ACTIVE", "COMPLETED", "PARTIAL"] } }, select: { priceUsd: true } } },
    }),
  ]);
  const global = settings["pricing.globalMultiplier"];
  const kycOn = settings["kyc.required"];
  const kycReady = diditConfig() !== null;

  return (
    <Page title="Users">
      <Flash sp={sp} />
      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold">
              Identity verification is <span className={kycOn ? "text-ok" : "text-warn"}>{kycOn ? "REQUIRED" : "OFF"}</span>
            </div>
            <p className="text-sm text-muted">
              {kycOn
                ? "Every customer must pass a Didit check before placing an order."
                : kycReady
                  ? "Customers can order without verifying."
                  : "Set DIDIT_API_KEY, DIDIT_WORKFLOW_ID and DIDIT_WEBHOOK_SECRET on the server before turning this on."}
            </p>
          </div>
          {(kycOn || kycReady) && (
            <form action={setSettingAction}>
              <input type="hidden" name="back" value="/admin/users" />
              <input type="hidden" name="key" value="kyc.required" />
              <input type="hidden" name="value" value={String(!kycOn)} />
              <Button variant={kycOn ? "danger" : "primary"}>{kycOn ? "Stop requiring" : "Require verification"}</Button>
            </form>
          )}
        </div>
      </Card>
      <form className="mb-4 max-w-sm">
        <Input name="q" defaultValue={sp.q} placeholder="Search email or name" />
      </form>
      <Table head={["Customer", "Joined", "Identity", "Orders", "Spent", "Markup", "Role", ""]} empty="No users.">
        {users.map((u) => {
          const spent = u.orders.reduce((s, o) => s.add(o.priceUsd.toString()), new Decimal(0));
          return (
            <tr key={u.id} className={u.suspended ? "opacity-50" : undefined}>
              <Td>
                <div>{u.email}</div>
                <div className="text-xs text-muted">{u.name ?? ""}</div>
              </Td>
              <Td className="text-xs text-muted">{dateTime(u.createdAt)}</Td>
              <Td>
                <div className={u.kycStatus === "APPROVED" ? "text-ok" : u.kycStatus === "DECLINED" ? "text-bad" : "text-muted"}>
                  {KYC_LABEL[u.kycStatus]}
                </div>
                <form action={setKycStatusAction}>
                  <input type="hidden" name="userId" value={u.id} />
                  <input type="hidden" name="status" value={u.kycStatus === "APPROVED" ? "NONE" : "APPROVED"} />
                  <button className="text-xs text-muted hover:text-text" title={u.kycSessionId ? `Didit session ${u.kycSessionId}` : undefined}>
                    {u.kycStatus === "APPROVED" ? "Reset" : "Mark verified"}
                  </button>
                </form>
              </Td>
              <Td className="num">{u.orders.length}</Td>
              <Td className="num">{usd(spent)}</Td>
              <Td>
                <div className="text-left">
                  <form action={setUserMultiplierAction} className="flex items-center gap-2">
                    <input type="hidden" name="userId" value={u.id} />
                    <Input
                      name="multiplier"
                      type="number"
                      step="0.05"
                      min="1"
                      max="20"
                      defaultValue={u.priceMultiplier?.toString() ?? ""}
                      placeholder={`${global} (global)`}
                      className="w-28"
                    />
                    <Button variant="secondary" className="px-3 py-1.5">
                      Set
                    </Button>
                  </form>
                  <div className="mt-1 text-xs text-muted">
                    {u.priceMultiplier ? `Custom ${multiplier(u.priceMultiplier)}. Clear the box to use global` : `Uses global ${multiplier(global)}`}
                  </div>
                </div>
              </Td>
              <Td>
                <form action={setUserRoleAction}>
                  <input type="hidden" name="userId" value={u.id} />
                  <input type="hidden" name="role" value={u.role === "ADMIN" ? "CUSTOMER" : "ADMIN"} />
                  <button className={u.role === "ADMIN" ? "text-accent" : "text-muted hover:text-text"} title="Toggle admin">
                    {u.role === "ADMIN" ? "Admin" : "Customer"}
                  </button>
                </form>
              </Td>
              <Td>
                <form action={setSuspendedAction}>
                  <input type="hidden" name="userId" value={u.id} />
                  <input type="hidden" name="suspended" value={String(!u.suspended)} />
                  <button className={u.suspended ? "text-ok" : "text-bad"}>{u.suspended ? "Reactivate" : "Suspend"}</button>
                </form>
              </Td>
            </tr>
          );
        })}
      </Table>
    </Page>
  );
}
