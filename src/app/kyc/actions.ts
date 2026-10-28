"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/email/templates";
import { diditConfig, DiditError } from "@/lib/kyc/didit";
import { KycRequiredError, safeNext, startKyc } from "@/lib/kyc/service";

export async function startKycAction(form: FormData) {
  const user = await requireUser();
  const next = safeNext(form.get("next"));
  const c = diditConfig();
  if (!c) redirect(`/kyc?error=${encodeURIComponent("Identity verification is not available right now.")}`);

  let url: string;
  try {
    url = await startKyc(db, c, user, `${appUrl()}/kyc?next=${encodeURIComponent(next)}`);
  } catch (e) {
    if (!(e instanceof DiditError || e instanceof KycRequiredError)) throw e;
    console.error("kyc start failed", e);
    const msg = e instanceof KycRequiredError ? e.message : "We could not reach the verification service. Please try again in a minute.";
    redirect(`/kyc?next=${encodeURIComponent(next)}&error=${encodeURIComponent(msg)}`);
  }
  redirect(url);
}
