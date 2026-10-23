import { buildRouter } from "./providers";
import type { ProviderRouter } from "./providers/router";

// One router (and MRR client, whose nonce queue must be shared) per server process.
const g = globalThis as unknown as { bqRouter?: ProviderRouter };
export function getRouter(): ProviderRouter {
  return (g.bqRouter ??= buildRouter());
}
