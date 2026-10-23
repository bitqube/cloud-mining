import { describe, expect, it } from "vitest";
import { inlineAttachments, previewHtml } from "./images";
import { smtpConfig } from "./mailer";
import { orderEmail, passwordResetEmail, sampleEmails, welcomeEmail, type OrderForEmail } from "./templates";

const order = {
  id: "cmorder000000000abcd1234",
  coin: { id: "RVN", name: "Ravencoin", unit: "MH/s", unitMh: "1" },
  hashrateMh: "250",
  rigMh: "1000",
  slotMinutes: 360,
  days: 1,
  hours: 24,
  priceUsd: "6.90",
  payoutAddress: "RVaG8KbMDWkQ4NRHcBxxkfuAgPWsUdNjJh",
  poolHost: null,
} as unknown as OrderForEmail;
const slots = [{ startsAt: new Date("2026-10-20T12:00:00Z"), endsAt: new Date("2026-10-20T18:00:00Z") }];

describe("email templates", () => {
  it("renders order details and the slot in both text and html", () => {
    const e = orderEmail("order.scheduled", order, { slots });
    expect(e.subject).toBe("Order abcd1234: your mining slot is scheduled");
    for (const body of [e.text, e.html]) {
      expect(body).toContain("250 MH/s");
      expect(body).toContain("6h at 1,000 MH/s");
      expect(body).toContain("$6.90");
      expect(body).toContain(order.payoutAddress);
      expect(body).toContain("2026-10-20 12:00 UTC → 18:00 UTC");
      expect(body).toContain("/orders/cmorder000000000abcd1234");
    }
  });

  it("shows the customer's own pool instead of an address", () => {
    const own = { ...order, payoutAddress: "", poolHost: "my.pool.io", poolPort: 3333, poolUser: "me.rig" } as OrderForEmail;
    expect(orderEmail("order.paid", own).text).toContain("my.pool.io:3333 as me.rig");
  });

  it("explains a part payment in BTQ", () => {
    const e = orderEmail("order.placed", order, { btq: { amount: "100", address: "Baddr", until: slots[0].endsAt, usd: "2.07" } });
    expect(e.text).toContain("You're paying $2.07 of this order in BTQ");
    const full = orderEmail("order.placed", order, { btq: { amount: "345", address: "Baddr", until: slots[0].endsAt, usd: "6.90" } });
    expect(full.text).not.toContain("You're paying");
  });

  it("escapes user-supplied text in html", () => {
    const e = welcomeEmail({ name: `<script>alert("x")</script>` });
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&#60;script&#62;");
    expect(e.text).toContain("<script>"); // plain text needs no escaping
  });

  it("puts the reset link in the email", () => {
    const e = passwordResetEmail("https://cloud.example/reset?token=abc", 60);
    expect(e.text).toContain("https://cloud.example/reset?token=abc");
    expect(e.html).toContain('href="https://cloud.example/reset?token=abc"');
    expect(e.text).toContain("60 minutes");
  });
});

describe("inline images", () => {
  it("attaches exactly the images an email uses", () => {
    const withBanner = orderEmail("order.paid", order);
    expect(inlineAttachments(withBanner.html).map((a) => a.cid).sort()).toEqual(["logo@bitqube", "qube@bitqube"]);
    const noBanner = passwordResetEmail("https://x/reset?token=a", 60);
    expect(inlineAttachments(noBanner.html).map((a) => a.cid)).toEqual(["logo@bitqube"]);
  });
  it("points cid links at /email for the browser preview", () => {
    const html = previewHtml(welcomeEmail({ name: null }).html);
    expect(html).not.toContain("cid:");
    expect(html).toContain('src="/email/qube.gif"');
  });
  it("renders every sample template", () => {
    for (const { content } of sampleEmails()) {
      expect(content.subject).toBeTruthy();
      expect(content.text).not.toContain("undefined");
      expect(content.html).not.toContain("undefined");
    }
  });
});

describe("smtpConfig", () => {
  it("is null until a password is set", () => {
    expect(smtpConfig({ SMTP_SERVER: "smtp.gmail.com", SMTP_USERNAME: "u@x.io", SMTP_PASSWORD: "" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
  it("defaults port and From", () => {
    expect(smtpConfig({ SMTP_SERVER: "smtp.gmail.com", SMTP_USERNAME: "u@x.io", SMTP_PASSWORD: "p" } as unknown as NodeJS.ProcessEnv)).toEqual({
      host: "smtp.gmail.com",
      port: 587,
      user: "u@x.io",
      password: "p",
      from: "BitQube Cloud Mining <u@x.io>",
    });
  });
});
