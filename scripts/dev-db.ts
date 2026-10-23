// Local development Postgres (no system install needed): npm run db:dev
// Data lives in .data/pg (gitignored). Production uses a regular Postgres server.
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(".data/pg");
const port = Number(process.env.DEV_DB_PORT ?? 54329);

async function main() {
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "bitqube", password: "bitqube", port, persistent: true });
  if (!existsSync(path.join(dir, "PG_VERSION"))) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase("bitqube_cloud");
  } catch {
    // already exists
  }
  console.log(`dev postgres on postgresql://bitqube:bitqube@localhost:${port}/bitqube_cloud (Ctrl-C to stop)`);
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
