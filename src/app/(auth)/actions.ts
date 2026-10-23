"use server";

import { redirect } from "next/navigation";
import {
  createPasswordReset,
  createSession,
  destroySession,
  hashPassword,
  RESET_VALID_MINUTES,
  ResetError,
  resetPassword,
  validatePassword,
  verifyPassword,
} from "@/lib/auth";
import { db } from "@/lib/db";
import { smtpSender } from "@/lib/email/mailer";
import { queueEmail, sendQueuedNow } from "@/lib/email/outbox";
import { appUrl, passwordResetEmail, welcomeEmail } from "@/lib/email/templates";

export type FormState = { error?: string; ok?: string } | undefined;

// Simple in-process throttle against password guessing: 10 failures per email per 15 min.
const failures = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60_000;

function throttled(email: string): boolean {
  const f = failures.get(email);
  return Boolean(f && f.until > Date.now() && f.count >= 10);
}
function recordFailure(email: string) {
  const f = failures.get(email);
  if (!f || f.until <= Date.now()) failures.set(email, { count: 1, until: Date.now() + WINDOW_MS });
  else f.count++;
}

const normEmail = (v: FormDataEntryValue | null) => String(v ?? "").trim().toLowerCase();

export async function signupAction(_: FormState, form: FormData): Promise<FormState> {
  const email = normEmail(form.get("email"));
  const password = String(form.get("password") ?? "");
  const name = String(form.get("name") ?? "").trim() || null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email address." };
  const pwError = validatePassword(password);
  if (pwError) return { error: pwError };
  if (await db.user.findUnique({ where: { email } })) return { error: "An account with that email already exists." };

  const user = await db.user.create({ data: { email, name, passwordHash: await hashPassword(password) } });
  await queueEmail(db, { to: email, kind: "welcome", ...welcomeEmail(user) });
  await createSession(user.id);
  redirect("/buy");
}

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const email = normEmail(form.get("email"));
  const password = String(form.get("password") ?? "");
  if (throttled(email)) return { error: "Too many attempts. Try again in 15 minutes." };

  const user = await db.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    recordFailure(email);
    return { error: "Wrong email or password." };
  }
  if (user.suspended) return { error: "This account is suspended. Contact support." };
  failures.delete(email);
  await createSession(user.id);
  redirect(user.role === "ADMIN" ? "/admin" : "/orders");
}

export async function logoutAction() {
  await destroySession();
  redirect("/");
}

// Always answers the same way, so the form can't be used to find out who has an account.
export async function forgotPasswordAction(_: FormState, form: FormData): Promise<FormState> {
  const email = normEmail(form.get("email"));
  const done = { ok: "If an account exists for that email, a reset link is on its way. Check your inbox (and spam)." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email address." };

  const user = await db.user.findUnique({ where: { email } });
  if (!user || user.suspended) return done;
  const token = await createPasswordReset(user.id);
  if (!token) return done;
  const link = `${appUrl()}/reset?token=${token}`;
  const queued = await queueEmail(db, { to: email, kind: "password.reset", ...passwordResetEmail(link, RESET_VALID_MINUTES) });
  try {
    await sendQueuedNow(db, smtpSender(), queued.id); // otherwise the worker sends it
  } catch (e) {
    console.error("password reset email:", (e as Error).message);
  }
  return done;
}

export async function resetPasswordAction(_: FormState, form: FormData): Promise<FormState> {
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) return { error: "The two passwords don't match." };
  let userId: string;
  try {
    userId = await resetPassword(token, password);
  } catch (e) {
    if (e instanceof ResetError) return { error: e.message };
    throw e;
  }
  await createSession(userId);
  redirect("/orders");
}
