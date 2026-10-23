"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { forgotPasswordAction, resetPasswordAction } from "./actions";

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="w-full max-w-sm">
      <h1 className="rise mb-6 text-3xl font-semibold">{title}</h1>
      {children}
      <p className="mt-4 text-center text-sm text-muted">
        <Link href="/login" className="text-accent">Back to log in</Link>
      </p>
    </div>
  );
}

export function ForgotForm() {
  const [state, formAction, pending] = useActionState(forgotPasswordAction, undefined);
  return (
    <Shell title="Reset your password">
      <form action={formAction} className="glass edge-glow rise space-y-5 rounded-3xl p-7" style={{ "--d": "80ms" } as React.CSSProperties}>
        {state?.error && <Alert tone="error">{state.error}</Alert>}
        {state?.ok ? (
          <Alert tone="ok">{state.ok}</Alert>
        ) : (
          <>
            <p className="text-sm text-muted">Enter your account email and we&apos;ll send you a link to choose a new password.</p>
            <Field label="Email">
              <Input name="email" type="email" required autoComplete="email" />
            </Field>
            <Button className="w-full" disabled={pending}>
              {pending ? "Sending…" : "Send reset link"}
            </Button>
          </>
        )}
      </form>
    </Shell>
  );
}

export function ResetForm({ token, valid }: { token: string; valid: boolean }) {
  const [state, formAction, pending] = useActionState(resetPasswordAction, undefined);
  if (!valid) {
    return (
      <Shell title="Link expired">
        <Alert tone="error">
          This reset link is invalid, already used or expired. <Link href="/forgot" className="underline">Request a new one</Link>.
        </Alert>
      </Shell>
    );
  }
  return (
    <Shell title="Choose a new password">
      <form action={formAction} className="glass edge-glow rise space-y-5 rounded-3xl p-7" style={{ "--d": "80ms" } as React.CSSProperties}>
        {state?.error && <Alert tone="error">{state.error}</Alert>}
        <input type="hidden" name="token" value={token} />
        <Field label="New password" hint="At least 10 characters. You'll be logged out everywhere else.">
          <Input name="password" type="password" required minLength={10} autoComplete="new-password" />
        </Field>
        <Field label="Repeat new password">
          <Input name="confirm" type="password" required minLength={10} autoComplete="new-password" />
        </Field>
        <Button className="w-full" disabled={pending}>
          {pending ? "Saving…" : "Set password and log in"}
        </Button>
      </form>
    </Shell>
  );
}
