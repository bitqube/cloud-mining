import { createHmac } from "node:crypto";

// Client for the MiningRigRentals API v2 (https://www.miningrigrentals.com/apidocv2).
//
// Auth: every call carries x-api-key, x-api-nonce and x-api-sign, where the sign is
// HMAC-SHA1(secret, key + nonce + endpoint). The endpoint is the path after /api/v2,
// without query string or trailing slash. Nonces must strictly increase per key, so
// all requests from one client go through a single queue.

export const MRR_BASE_URL = "https://www.miningrigrentals.com/api/v2";

export type MrrCurrency = "BTC" | "LTC" | "ETH" | "DOGE" | "BCH";
export type HashUnit = "hash" | "kh" | "mh" | "gh" | "th" | "ph" | "eh";
type Method = "GET" | "PUT" | "POST" | "DELETE";
type Params = Record<string, unknown>;

export class MrrError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    readonly body?: unknown,
  ) {
    super(`MRR ${endpoint}: ${message}`);
    this.name = "MrrError";
  }
}

export function signRequest(key: string, secret: string, nonce: string, endpoint: string): string {
  return createHmac("sha1", secret).update(key + nonce + normalizeEndpoint(endpoint)).digest("hex");
}

export function normalizeEndpoint(endpoint: string): string {
  const path = endpoint.split("?")[0];
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

// PHP-style bracket encoding (rpi[min]=50), which is how the MRR backend parses nested
// filters such as those on GET /rig.
export function encodeQuery(params: Params, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) {
      const nested = encodeQuery(v as Params, key);
      if (nested) parts.push(nested);
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join("&");
}

export interface MrrClientOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class MrrClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private lastNonce = 0n;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: MrrClientOptions) {
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.baseUrl = (opts.baseUrl ?? MRR_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  // Microsecond-ish timestamp, bumped by one if the clock has not advanced, so it is
  // strictly increasing within this process.
  nextNonce(): string {
    const now = BigInt(Date.now()) * 1000n;
    this.lastNonce = now > this.lastNonce ? now : this.lastNonce + 1n;
    return this.lastNonce.toString();
  }

  get<T>(endpoint: string, params?: Params) {
    return this.request<T>("GET", endpoint, params);
  }
  put<T>(endpoint: string, params?: Params) {
    return this.request<T>("PUT", endpoint, params);
  }
  post<T>(endpoint: string, params?: Params) {
    return this.request<T>("POST", endpoint, params);
  }
  delete<T>(endpoint: string, params?: Params) {
    return this.request<T>("DELETE", endpoint, params);
  }

  request<T>(method: Method, endpoint: string, params?: Params): Promise<T> {
    const run = () => this.send<T>(method, endpoint, params);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async send<T>(method: Method, endpoint: string, params?: Params): Promise<T> {
    const path = normalizeEndpoint(endpoint);
    const nonce = this.nextNonce();
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      "x-api-nonce": nonce,
      "x-api-sign": signRequest(this.apiKey, this.apiSecret, nonce, path),
      Accept: "application/json",
    };

    let url = this.baseUrl + path;
    let body: string | undefined;
    if (method === "GET") {
      const qs = params ? encodeQuery(params) : "";
      if (qs) url += `?${qs}`;
    } else if (params && Object.keys(params).length > 0) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params);
    }

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: { success?: boolean; data?: unknown; message?: string } | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MrrError(`non-JSON response (HTTP ${res.status})`, res.status, path, text.slice(0, 500));
    }
    if (!res.ok || !json || json.success !== true) {
      const data = json?.data as { message?: string } | undefined;
      const message = data?.message ?? json?.message ?? `HTTP ${res.status}`;
      throw new MrrError(message, res.status, path, json);
    }
    return json.data as T;
  }
}

// MRR requires each key's nonce to increase across ALL callers, so two processes must
// not share a key: the web app uses MRR_API_KEY, the worker MRR_WORKER_API_KEY.
export function mrrClientFromEnv(prefix: "MRR_" | "MRR_WORKER_" = "MRR_"): MrrClient {
  const apiKey = process.env[`${prefix}API_KEY`];
  const apiSecret = process.env[`${prefix}API_SECRET`];
  if (!apiKey || !apiSecret) throw new Error(`${prefix}API_KEY and ${prefix}API_SECRET must be set`);
  return new MrrClient({ apiKey, apiSecret, baseUrl: process.env.MRR_BASE_URL });
}
