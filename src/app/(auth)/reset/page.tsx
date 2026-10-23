import { findValidReset } from "@/lib/auth";
import { ResetForm } from "../reset-forms";

export const dynamic = "force-dynamic";

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const valid = token ? Boolean(await findValidReset(token)) : false;
  return <ResetForm token={token} valid={valid} />;
}
