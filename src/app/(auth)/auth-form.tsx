"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import type { FormState } from "./actions";

export function AuthForm({ mode, action }: { mode: "login" | "signup"; action: (s: FormState, f: FormData) => Promise<FormState> }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const signup = mode === "signup";
  return (
    <div className="w-full max-w-sm">
      <h1 className="rise mb-6 text-3xl font-semibold">{signup ? "Create your account" : "Log in"}</h1>
      <form action={formAction} className="glass edge-glow rise space-y-5 rounded-3xl p-7" style={{ "--d": "80ms" } as React.CSSProperties}>
        {state?.error && <Alert tone="error">{state.error}</Alert>}
        {signup && (
          <Field label="Name">
            <Input name="name" autoComplete="name" />
          </Field>
        )}
        <Field label="Email">
          <Input name="email" type="email" required autoComplete="email" />
        </Field>
        <Field
          label="Password"
          hint={signup ? "At least 10 characters." : <Link href="/forgot" className="text-accent">Forgot your password?</Link>}
        >
          <Input name="password" type="password" required autoComplete={signup ? "new-password" : "current-password"} />
        </Field>
        <Button className="w-full" disabled={pending}>
          {pending ? "Please wait…" : signup ? "Create account" : "Log in"}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-muted">
        {signup ? (
          <>
            Already have an account? <Link href="/login" className="text-accent">Log in</Link>
          </>
        ) : (
          <>
            New here? <Link href="/signup" className="text-accent">Create an account</Link>
          </>
        )}
      </p>
    </div>
  );
}
