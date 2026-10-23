import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@prisma/client";
import { db } from "./db";

// Email + password auth with database sessions. Passwords use scrypt (built into Node,
// no native dependency); the session cookie carries a random token whose SHA-256 is
// the only thing stored.

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const SESSION_COOKIE = "bq_session";
const SESSION_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

export function validatePassword(password: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters.";
  if (password.length > 200) return "Password is too long.";
  return null;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt } });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  jar.delete(SESSION_COOKIE);
}

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await db.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!session || session.expiresAt <= new Date() || session.user.suspended) return null;
  return session.user;
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "ADMIN") redirect("/");
  return user;
}

// ---- Password reset ----

export const RESET_VALID_MINUTES = 60;
// One reset email per account per this many ms, so the form can't be used to spam.
const RESET_COOLDOWN_MS = 2 * 60_000;

export class ResetError extends Error {}

// Returns a raw token for the email link, or null if a reset was requested too recently.
export async function createPasswordReset(userId: string): Promise<string | null> {
  const recent = await db.passwordReset.findFirst({
    where: { userId, createdAt: { gt: new Date(Date.now() - RESET_COOLDOWN_MS) } },
  });
  if (recent) return null;
  const token = randomBytes(32).toString("base64url");
  await db.passwordReset.create({
    data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_VALID_MINUTES * 60_000) },
  });
  return token;
}

export async function findValidReset(token: string) {
  const reset = await db.passwordReset.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!reset || reset.usedAt || reset.expiresAt <= new Date() || reset.user.suspended) return null;
  return reset;
}

// Sets the new password, burns every outstanding reset link and logs out all sessions.
export async function resetPassword(token: string, password: string): Promise<string> {
  const pwError = validatePassword(password);
  if (pwError) throw new ResetError(pwError);
  const reset = await findValidReset(token);
  if (!reset) throw new ResetError("This reset link is invalid or has expired. Request a new one.");
  const passwordHash = await hashPassword(password);
  await db.$transaction([
    db.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
    db.passwordReset.updateMany({ where: { userId: reset.userId, usedAt: null }, data: { usedAt: new Date() } }),
    db.session.deleteMany({ where: { userId: reset.userId } }),
  ]);
  return reset.userId;
}
