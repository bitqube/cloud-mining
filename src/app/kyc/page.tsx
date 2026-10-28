import { Alert, Button, ButtonLink, Card, Page } from "@/components/ui";
import { Flash } from "@/components/flash";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { diditConfig } from "@/lib/kyc/didit";
import { KYC_MESSAGE, refreshKyc, safeNext } from "@/lib/kyc/service";
import { startKycAction } from "./actions";

export const dynamic = "force-dynamic";

const TONE = { NONE: "info", PENDING: "warn", REVIEW: "info", APPROVED: "ok", DECLINED: "error" } as const;

// Where customers start identity verification, and where Didit sends them back.
export default async function KycPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; ok?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  let user = await requireUser();
  const c = diditConfig();

  // Back from Didit: ask for the result now rather than wait for the webhook.
  if (c && user.kycStatus === "PENDING") {
    try {
      if (await refreshKyc(db, c, user)) user = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    } catch (e) {
      console.error("kyc refresh failed", e);
    }
  }
  const status = user.kycStatus;

  return (
    <Page title="Identity verification">
      <Flash sp={sp} />
      <Card className="max-w-xl">
        <div className="space-y-4">
          <Alert tone={TONE[status]}>{KYC_MESSAGE[status]}</Alert>
          {status === "APPROVED" ? (
            <ButtonLink href={next}>Continue</ButtonLink>
          ) : status === "REVIEW" ? null : !c ? (
            <p className="text-sm text-muted">Identity verification is not available right now. Please try again later.</p>
          ) : (
            <form action={startKycAction} className="space-y-3">
              <input type="hidden" name="next" value={next} />
              <p className="text-sm text-muted">
                You&apos;ll need a passport, national ID card or driving licence, and a camera for a quick selfie. Our verification partner,
                Didit, checks the document and keeps it; we only receive the result.
              </p>
              <Button>{status === "PENDING" ? "Continue verification" : status === "DECLINED" ? "Try again" : "Verify my identity"}</Button>
            </form>
          )}
        </div>
      </Card>
    </Page>
  );
}
