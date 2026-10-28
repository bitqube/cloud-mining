import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../settings";
import { canonicalJson, kycStatusFrom, verifyWebhook } from "./didit";
import { kycBlockReason, safeNext } from "./service";

const SECRET = "whsec_test";
const sign = (data: string, secret = SECRET) => crypto.createHmac("sha256", secret).update(data, "utf8").digest("hex");
const NOW = 1_800_000_000;
const body = JSON.stringify({ webhook_type: "status.updated", session_id: "s1", status: "Approved", vendor_data: "u1", decision: { b: 2, a: "ü" } });
const headers = (h: Record<string, string>) => new Headers({ "x-timestamp": String(NOW), ...h });

describe("Didit webhooks", () => {
  it("builds Didit's canonical JSON: sorted keys at every level, compact, unicode kept", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: "é" }], 10: true, 2: null })).toBe('{"10":true,"2":null,"a":[{"c":"é","d":1}],"b":1}');
    expect(canonicalJson(JSON.parse('{"score": 95.0}'))).toBe('{"score":95}'); // whole floats as integers
  });

  it("accepts X-Signature-V2 over the canonical JSON, or X-Signature over the raw body", () => {
    const v2 = sign(canonicalJson(JSON.parse(body)));
    expect(verifyWebhook(body, headers({ "x-signature-v2": v2 }), SECRET, NOW)).toBe(true);
    expect(verifyWebhook(body, headers({ "x-signature": sign(body) }), SECRET, NOW)).toBe(true);
    // Re-serialized by a proxy: the raw signature breaks, V2 still holds.
    const reformatted = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyWebhook(reformatted, headers({ "x-signature": sign(body) }), SECRET, NOW)).toBe(false);
    expect(verifyWebhook(reformatted, headers({ "x-signature-v2": v2 }), SECRET, NOW)).toBe(true);
  });

  it("rejects a wrong secret, a tampered body, a missing signature and a stale or missing timestamp", () => {
    const v2 = sign(canonicalJson(JSON.parse(body)));
    expect(verifyWebhook(body, headers({ "x-signature-v2": sign(canonicalJson(JSON.parse(body)), "other") }), SECRET, NOW)).toBe(false);
    expect(verifyWebhook(body.replace("Approved", "Declined"), headers({ "x-signature-v2": v2 }), SECRET, NOW)).toBe(false);
    expect(verifyWebhook(body, headers({}), SECRET, NOW)).toBe(false);
    expect(verifyWebhook(body, headers({ "x-signature-v2": v2 }), SECRET, NOW + 301)).toBe(false);
    expect(verifyWebhook(body, new Headers({ "x-signature-v2": v2 }), SECRET, NOW)).toBe(false);
    expect(verifyWebhook("not json", headers({ "x-signature": sign("not json") }), SECRET, NOW)).toBe(false);
  });

  it("accepts the -Previous signature sent while Didit's secret is being rotated", () => {
    const old = sign(canonicalJson(JSON.parse(body)));
    expect(verifyWebhook(body, headers({ "x-signature-v2": sign("x", "new"), "x-signature-v2-previous": old }), SECRET, NOW)).toBe(true);
  });

  it("maps Didit's statuses to ours and ignores unknown ones", () => {
    expect(kycStatusFrom("Approved")).toBe("APPROVED");
    expect(kycStatusFrom("Declined")).toBe("DECLINED");
    expect(kycStatusFrom("In Review")).toBe("REVIEW");
    expect(kycStatusFrom("In Progress")).toBe("PENDING");
    expect(kycStatusFrom("Abandoned")).toBe("NONE");
    expect(kycStatusFrom("Kyc Expired")).toBe("NONE");
    expect(kycStatusFrom("approved")).toBeNull(); // case-sensitive
  });
});

describe("KYC rules", () => {
  it("blocks ordering only when required and not yet approved", () => {
    const on = { ...DEFAULTS, "kyc.required": true };
    expect(kycBlockReason(DEFAULTS, { kycStatus: "NONE" })).toBeNull();
    expect(kycBlockReason(on, { kycStatus: "APPROVED" })).toBeNull();
    expect(kycBlockReason(on, { kycStatus: "NONE" })).toMatch(/verify your identity/);
    expect(kycBlockReason(on, { kycStatus: "DECLINED" })).toMatch(/not approved/);
  });

  it("only returns to paths on this site", () => {
    expect(safeNext("/buy/quote/abc")).toBe("/buy/quote/abc");
    expect(safeNext("//evil.example")).toBe("/buy");
    expect(safeNext("https://evil.example")).toBe("/buy");
    expect(safeNext("/x\\@evil")).toBe("/buy");
    expect(safeNext(undefined)).toBe("/buy");
  });
});
