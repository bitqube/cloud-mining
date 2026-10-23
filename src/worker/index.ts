// Background worker: npm run worker. Runs alongside the web app (one or more processes).
// Uses its own MRR key (MRR_WORKER_API_KEY); see mrrClientFromEnv for why.
process.env.BQ_PROCESS = "worker";
import { watchBtqPayments } from "../lib/btq/payments";
import { btqWalletFromEnv } from "../lib/btq/wallet";
import { db } from "../lib/db";
import { smtpSender } from "../lib/email/mailer";
import { deliverPendingEmails } from "../lib/email/outbox";
import { buildMrrProvider } from "../lib/providers";
import { ProviderRouter } from "../lib/providers/router";
import {
  bookPaidOrders,
  cancelUnpaidOrders,
  completeFinishedOrders,
  finishRigDays,
  flagStuckRenting,
  pollActiveRentals,
  rentRigDays,
  switchSlots,
  type WorkerDeps,
} from "./jobs";

// Slots switch on tick boundaries, so a slot starts at most one tick late.
const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 30_000);
const POLL_EVERY_TICKS = Number(process.env.WORKER_POLL_EVERY ?? 4); // ~2 min at the default tick

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

async function main() {
  const provider = buildMrrProvider();
  const deps: WorkerDeps = { db, router: new ProviderRouter([provider]), provider, log };

  let stopping = false;
  const stop = () => {
    stopping = true;
    log("stopping after the current tick");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const send = smtpSender();
  const wallet = btqWalletFromEnv();
  log(
    `worker started (tick ${TICK_MS} ms)${send ? "" : "; SMTP not configured, emails stay queued"}${wallet ? "" : "; BTQ_RPC_* not set, BTQ payments off"}`,
  );
  for (let tick = 0; !stopping; tick++) {
    const jobs: Array<[string, () => Promise<number>]> = [];
    // First, so an order paid in BTQ this tick is booked this tick.
    if (wallet) jobs.push(["btq", () => watchBtqPayments(db, wallet, log)]);
    if (tick % POLL_EVERY_TICKS === 0) jobs.push(["poll", () => pollActiveRentals(deps)]);
    jobs.push(
      ["book", () => bookPaidOrders(deps)],
      ["rent", () => rentRigDays(deps)],
      ["switch", () => switchSlots(deps)],
      ["finish", () => finishRigDays(deps)],
      ["complete", () => completeFinishedOrders(deps)],
      ["stuck", () => flagStuckRenting(deps)],
      ["unpaid", () => cancelUnpaidOrders(deps)],
    );
    // Last, so emails queued by this tick's jobs go out straight away.
    jobs.push(["email", () => deliverPendingEmails(db, send, log)]);
    for (const [name, job] of jobs) {
      try {
        const n = await job();
        if (n > 0) log(`${name}: ${n}`);
      } catch (e) {
        log(`${name} failed: ${(e as Error).stack ?? e}`);
      }
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
  await db.$disconnect();
}

main();
