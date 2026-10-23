import { describe, expect, it } from "vitest";
import { encodeQuery, MrrClient, MrrError, normalizeEndpoint, signRequest } from "./client";

describe("signRequest", () => {
  it("matches the worked example in the MRR docs (computed with openssl)", () => {
    // echo -n "APIKEY12345/rig/14" | openssl dgst -sha1 -hmac APISECRET
    expect(signRequest("APIKEY", "APISECRET", "12345", "/rig/14")).toBe("229267a7136e017b74c1e136986f84abba40b7f3");
  });

  it("ignores trailing slashes and query strings", () => {
    const expected = signRequest("APIKEY", "APISECRET", "12345", "/rig/14");
    expect(signRequest("APIKEY", "APISECRET", "12345", "/rig/14/")).toBe(expected);
    expect(signRequest("APIKEY", "APISECRET", "12345", "/rig/14?fields=rpi")).toBe(expected);
  });
});

describe("normalizeEndpoint", () => {
  it("adds a leading slash and strips trailing ones", () => {
    expect(normalizeEndpoint("rig/14")).toBe("/rig/14");
    expect(normalizeEndpoint("/rig/26996;27004;")).toBe("/rig/26996;27004;");
    expect(normalizeEndpoint("/whoami//")).toBe("/whoami");
  });
});

describe("encodeQuery", () => {
  it("uses PHP bracket notation for nested filters", () => {
    const qs = encodeQuery({ type: "kawpow", rpi: { min: 50 }, hash: { min: 20, type: "mh" }, skip: undefined });
    expect(decodeURIComponent(qs)).toBe("type=kawpow&rpi[min]=50&hash[min]=20&hash[type]=mh");
  });
});

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift()!;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("MrrClient", () => {
  it("signs each call and sends GET params as a query string", async () => {
    const { impl, calls } = fakeFetch([{ body: { success: true, data: { authed: true } } }]);
    const c = new MrrClient({ apiKey: "K", apiSecret: "S", fetch: impl });
    await expect(c.get("/rig", { type: "kawpow" })).resolves.toEqual({ authed: true });

    const { url, init } = calls[0];
    expect(url).toBe("https://www.miningrigrentals.com/api/v2/rig?type=kawpow");
    const h = init.headers as Record<string, string>;
    expect(h["x-api-sign"]).toBe(signRequest("K", "S", h["x-api-nonce"], "/rig"));
    expect(init.body).toBeUndefined();
  });

  it("sends PUT params as JSON", async () => {
    const { impl, calls } = fakeFetch([{ body: { success: true, data: { pid: "1" } } }]);
    const c = new MrrClient({ apiKey: "K", apiSecret: "S", fetch: impl });
    await c.put("/account/profile", { name: "x", algo: "kawpow" });
    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ name: "x", algo: "kawpow" });
  });

  it("issues strictly increasing nonces even for concurrent calls", async () => {
    const ok = { body: { success: true, data: {} } };
    const { impl, calls } = fakeFetch([ok, ok, ok, ok, ok]);
    const c = new MrrClient({ apiKey: "K", apiSecret: "S", fetch: impl });
    await Promise.all([1, 2, 3, 4, 5].map(() => c.get("/whoami")));
    const nonces = calls.map((x) => BigInt((x.init.headers as Record<string, string>)["x-api-nonce"]));
    for (let i = 1; i < nonces.length; i++) expect(nonces[i] > nonces[i - 1]).toBe(true);
  });

  it("surfaces success:false messages as MrrError and keeps the queue alive", async () => {
    const { impl } = fakeFetch([
      { body: { success: false, data: { message: "Rig not found" } } },
      { body: { success: true, data: 1 } },
    ]);
    const c = new MrrClient({ apiKey: "K", apiSecret: "S", fetch: impl });
    await expect(c.get("/rig/1")).rejects.toThrow(MrrError);
    await expect(c.get("/rig/2")).resolves.toBe(1);
  });

  it("reports non-JSON bodies with the HTTP status", async () => {
    const { impl } = fakeFetch([{ status: 502, body: "<html>Bad gateway</html>" }]);
    const c = new MrrClient({ apiKey: "K", apiSecret: "S", fetch: impl });
    await expect(c.get("/whoami")).rejects.toMatchObject({ status: 502 });
  });
});
