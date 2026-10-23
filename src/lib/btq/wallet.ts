import Decimal from "decimal.js";

// The BitQube node's wallet, over JSON-RPC. The node holds the keys: each BTQ order gets
// a fresh address from it, and an admin sweeps the funds out by hand (scripts/btq-sweep.sh).
// The app only ever asks for new addresses and reads what they received; it never sends.
//
// Run the wallet encrypted with a large keypool: getnewaddress keeps working while it is
// locked until the pre-generated keys run out, so the passphrase never lives on the server.

export interface Received {
  amount: Decimal; // total received, unconfirmed included
  confirmations: number; // of the newest transaction to the address
  txids: string[];
}

export interface BtqWallet {
  newAddress(label: string): Promise<string>;
  // Every wallet address that has received anything, keyed by address.
  listReceived(): Promise<Map<string, Received>>;
  // Total received by one address in transactions with at least minConf confirmations.
  receivedBy(address: string, minConf: number): Promise<Decimal>;
}

// What the admin BTQ page shows about the node.
export interface NodeStatus {
  blocks: number;
  headers: number;
  synced: boolean;
  encrypted: boolean;
  unlocked: boolean;
  keypool: number; // addresses left before the wallet must be unlocked to refill
  balance: Decimal; // confirmed, waiting for the weekly sweep
  unconfirmed: Decimal;
}

export type RpcWallet = BtqWallet & { status(): Promise<NodeStatus> };

export class BtqRpcError extends Error {}

interface RpcConfig {
  url: string;
  user: string;
  password: string;
}

export function btqRpcConfig(env: NodeJS.ProcessEnv = process.env): RpcConfig | null {
  const url = env.BTQ_RPC_URL?.trim();
  const user = env.BTQ_RPC_USER?.trim();
  const password = env.BTQ_RPC_PASSWORD?.trim();
  return url && user && password ? { url, user, password } : null;
}

export function rpcWallet(c: RpcConfig): RpcWallet {
  const auth = `Basic ${Buffer.from(`${c.user}:${c.password}`).toString("base64")}`;
  let id = 0;

  async function call<T>(method: string, params: unknown[] = []): Promise<T> {
    let res: Response;
    try {
      res = await fetch(c.url, {
        method: "POST",
        headers: { "content-type": "text/plain", authorization: auth },
        body: JSON.stringify({ jsonrpc: "1.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
    } catch (e) {
      throw new BtqRpcError(`node unreachable: ${(e as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) throw new BtqRpcError(`node refused the RPC login (HTTP ${res.status})`);
    // The node answers RPC errors with HTTP 500 and a JSON body.
    const body = (await res.json().catch(() => null)) as { result: T; error: { code: number; message: string } | null } | null;
    if (!body) throw new BtqRpcError(`${method}: HTTP ${res.status} without a JSON body`);
    if (body.error) throw new BtqRpcError(`${method}: ${body.error.message} (${body.error.code})`);
    return body.result;
  }

  return {
    newAddress: (label) => call<string>("getnewaddress", [label]),
    async listReceived() {
      const rows = await call<Array<{ address: string; amount: number; confirmations: number; txids: string[] }>>("listreceivedbyaddress", [
        0,
        false,
      ]);
      // Amounts come back as JSON numbers; going through toFixed(8) keeps them exact.
      return new Map(
        rows.map((r) => [r.address, { amount: new Decimal(r.amount.toFixed(8)), confirmations: r.confirmations, txids: r.txids }]),
      );
    },
    async receivedBy(address, minConf) {
      const n = await call<number>("getreceivedbyaddress", [address, minConf]);
      return new Decimal(n.toFixed(8));
    },
    async status() {
      const [chain, w] = await Promise.all([
        call<{ blocks: number; headers: number }>("getblockchaininfo"),
        call<{ balance: number; unconfirmed_balance: number; keypoolsize: number; unlocked_until?: number }>("getwalletinfo"),
      ]);
      return {
        blocks: chain.blocks,
        headers: chain.headers,
        synced: chain.headers - chain.blocks <= 2,
        // unlocked_until is only reported for encrypted wallets; 0 = locked.
        encrypted: w.unlocked_until !== undefined,
        unlocked: (w.unlocked_until ?? 0) > 0,
        keypool: w.keypoolsize,
        balance: new Decimal(w.balance.toFixed(8)),
        unconfirmed: new Decimal(w.unconfirmed_balance.toFixed(8)),
      };
    },
  };
}

// null when BTQ_RPC_* is not set: BTQ is then not offered at checkout.
export function btqWalletFromEnv(env: NodeJS.ProcessEnv = process.env): RpcWallet | null {
  const c = btqRpcConfig(env);
  return c ? rpcWallet(c) : null;
}
