import { Alert } from "./ui";

// Shows ?ok= / ?error= messages set by admin actions after a redirect.
export function Flash({ sp }: { sp: { ok?: string; error?: string } }) {
  if (sp.error) return <div className="mb-6"><Alert tone="error">{sp.error}</Alert></div>;
  if (sp.ok) return <div className="mb-6"><Alert tone="ok">{sp.ok}</Alert></div>;
  return null;
}

export type FlashParams = Promise<{ ok?: string; error?: string }>;
