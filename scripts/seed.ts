// Creates (or promotes) an admin and adds starter packages if none exist.
//   npm run db:seed -- --admin you@example.com [--password '...']
// Without --password a random one is generated and printed once.
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth";

const db = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const PACKAGES = [
  { name: "Starter", sharePct: 10, sortOrder: 1 },
  { name: "Standard", sharePct: 25, sortOrder: 2 },
  { name: "Plus", sharePct: 50, sortOrder: 3 },
];

async function main() {
  const email = arg("admin")?.toLowerCase();
  if (email) {
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      await db.user.update({ where: { email }, data: { role: "ADMIN", suspended: false } });
      console.log(`${email} is now an admin (password unchanged).`);
    } else {
      const password = arg("password") ?? randomBytes(12).toString("base64url");
      await db.user.create({ data: { email, role: "ADMIN", passwordHash: await hashPassword(password) } });
      console.log(`Created admin ${email}${arg("password") ? "" : ` with password: ${password}`}`);
    }
  }
  if ((await db.plan.count()) === 0) {
    for (const p of PACKAGES) await db.plan.create({ data: p });
    console.log(`Added ${PACKAGES.length} starter packages.`);
  }
}

main().finally(() => db.$disconnect());
