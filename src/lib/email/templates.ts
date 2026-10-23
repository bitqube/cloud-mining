import Decimal from "decimal.js";
import type { Coin, Order, User } from "@prisma/client";
import { coinHashrate, minutesLabel } from "../coin-format";
import { dateTime, usd } from "../format";
import { imgSrc } from "./images";
import type { OutgoingEmail } from "./mailer";

// Every email the platform sends. Each template is a list of blocks rendered twice, as
// plain text and as HTML, so the two never drift apart.
//
// The HTML is built for email clients, not browsers: table layout, inline styles (the
// <style> block only adds mobile tweaks and web fonts where supported), a dark design
// declared as dark so clients don't invert it, and bulletproof buttons.

export const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
const POOL_URL = "https://pool.bitqube.org";

type Content = Omit<OutgoingEmail, "to">;
type Tone = "accent" | "ok" | "warn" | "bad";
type Link = { label: string; url: string };

type Block =
  | string // paragraph
  | { rows: Array<[string, string]> } // label/value details
  | { stats: Array<[string, string]> } // up to three big figures
  | { steps: number; tone?: Tone } // order progress, 0 = placed … 4 = complete
  | { list: Array<[string, string]> } // numbered title/body list
  | { note: string } // small highlighted aside
  | { button: Link; secondary?: Link };

interface Mail {
  subject: string;
  preheader: string; // inbox preview line
  eyebrow: string; // status pill above the heading
  tone: Tone;
  heading: string;
  blocks: Block[];
  banner?: boolean; // the animated Qube; off for admin alerts
  footer?: string;
  admin?: boolean; // plain heading and admin links in the footer
}

const C = {
  page: "#05070b",
  card: "#0a0e15",
  panel: "#0f1520",
  line: "#1a2230",
  text: "#e8edf5",
  body: "#b8c2d3",
  muted: "#7d889b",
  accent: "#4fd1c5",
  blue: "#1a7dff",
  gold: "#f0c014",
};
const TONE: Record<Tone, string> = { accent: C.accent, ok: "#34d399", warn: "#fbbf24", bad: "#f87171" };
const SANS = "'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DISPLAY = `'Syne',${SANS}`;
const MONO = "'IBM Plex Mono',SFMono-Regular,Menlo,Consolas,monospace";
const STEPS = ["Placed", "Paid", "Scheduled", "Mining", "Complete"];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Hex colour with alpha, as rgba(): 8-digit hex isn't supported everywhere.
const a = (hex: string, alpha: number) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",")},${alpha})`;
const host = () => appUrl().replace(/^https?:\/\//, "");

// ---- Plain text ----

function blockText(b: Block): string {
  if (typeof b === "string") return b;
  if ("rows" in b) return b.rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  if ("stats" in b) return b.stats.map(([k, v]) => `${k}: ${v}`).join("\n");
  if ("steps" in b) return STEPS.map((s, i) => (i < b.steps ? `[x] ${s}` : i === b.steps ? `[>] ${s}` : `[ ] ${s}`)).join("  ");
  if ("list" in b) return b.list.map(([t, d], i) => `${i + 1}. ${t}: ${d}`).join("\n");
  if ("note" in b) return `Note: ${b.note}`;
  return [`${b.button.label}: ${b.button.url}`, b.secondary ? `${b.secondary.label}: ${b.secondary.url}` : ""].filter(Boolean).join("\n");
}

function toText(m: Mail): string {
  return [
    m.heading,
    "=".repeat(Math.min(m.heading.length, 60)),
    "",
    ...m.blocks.flatMap((b) => [blockText(b), ""]),
    "—",
    "BitQube Cloud Mining",
    appUrl(),
    m.footer ?? "",
  ]
    .join("\n")
    .trimEnd();
}

// ---- HTML ----

const P = (html: string, style = "") =>
  `<p style="margin:0 0 18px;font-family:${SANS};font-size:15px;line-height:1.65;color:${C.body};${style}">${html}</p>`;

function rowsHtml(rows: Array<[string, string]>): string {
  const tr = rows
    .map(
      ([k, v], i) =>
        `<tr><td style="padding:12px 0;${i ? `border-top:1px solid ${C.line};` : ""}font-family:${SANS};font-size:13px;color:${C.muted};width:38%;vertical-align:top">${esc(k)}</td>` +
        `<td style="padding:12px 0;${i ? `border-top:1px solid ${C.line};` : ""}font-family:${MONO};font-size:13px;color:${C.text};text-align:right;word-break:break-all">${esc(v)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;background:${C.panel};border:1px solid ${C.line};border-radius:14px"><tr><td style="padding:6px 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${tr}</table></td></tr></table>`;
}

function statsHtml(stats: Array<[string, string]>): string {
  const w = Math.floor(100 / stats.length);
  const cells = stats
    .map(
      ([k, v], i) =>
        `<td class="bq-stat" width="${w}%" style="padding:0 ${i < stats.length - 1 ? 6 : 0}px 0 ${i ? 6 : 0}px;vertical-align:top">` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.panel};border:1px solid ${C.line};border-radius:14px"><tr><td class="bq-statbox" style="padding:16px 16px 14px">` +
        `<div style="font-family:${SANS};font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:${C.muted}">${esc(k)}</div>` +
        `<div class="bq-statv" style="margin-top:6px;font-family:${DISPLAY};font-size:22px;font-weight:700;color:${C.text};white-space:nowrap">${esc(v)}</div>` +
        `</td></tr></table></td>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px"><tr>${cells}</tr></table>`;
}

function stepsHtml(at: number, tone: Tone = "accent"): string {
  const col = TONE[tone];
  const cells = STEPS.map((s, i) => {
    const reached = i <= at;
    const current = i === at;
    const bar = reached ? `background:${col};background-image:linear-gradient(90deg,${C.accent},${col})` : `background:${C.line}`;
    const mark = i < at || (current && at === STEPS.length - 1) ? "&#10003;" : current ? "&#9679;" : String(i + 1);
    return (
      `<td width="25%" style="padding:0 ${i < 3 ? 4 : 0}px 0 0;vertical-align:top">` +
      `<div style="height:4px;line-height:4px;font-size:0;border-radius:4px;${bar}">&nbsp;</div>` +
      `<div style="padding-top:10px;font-family:${SANS};font-size:12px;letter-spacing:.3px;color:${reached ? (current ? col : C.text) : C.muted};font-weight:${current ? 700 : 500}">` +
      `<span style="font-family:${MONO};color:${reached ? col : C.muted}">${mark}</span>&nbsp; ${s}</div></td>`
    );
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 26px"><tr>${cells}</tr></table>`;
}

function listHtml(items: Array<[string, string]>): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px">` +
    items
      .map(
        ([t, d], i) =>
          `<tr><td width="44" style="padding:0 0 16px;vertical-align:top">` +
          `<div style="width:32px;height:32px;line-height:32px;text-align:center;border-radius:10px;border:1px solid ${a(C.accent, 0.33)};background:${a(C.accent, 0.08)};font-family:${MONO};font-size:13px;font-weight:600;color:${C.accent}">0${i + 1}</div></td>` +
          `<td style="padding:0 0 16px;vertical-align:top"><div style="font-family:${SANS};font-size:15px;font-weight:600;color:${C.text}">${esc(t)}</div>` +
          `<div style="margin-top:3px;font-family:${SANS};font-size:14px;line-height:1.55;color:${C.body}">${esc(d)}</div></td></tr>`,
      )
      .join("") +
    `</table>`
  );
}

const noteHtml = (n: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px"><tr>` +
  `<td style="padding:14px 18px;background:${a(C.accent, 0.06)};border:1px solid ${a(C.accent, 0.2)};border-left:3px solid ${C.accent};border-radius:12px;font-family:${SANS};font-size:13px;line-height:1.6;color:${C.body}">${esc(n)}</td></tr></table>`;

function buttonHtml(b: Link, secondary?: Link): string {
  const btn =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 ${secondary ? 14 : 24}px"><tr>` +
    `<td align="center" bgcolor="${C.accent}" style="border-radius:12px;background:${C.accent};background-image:linear-gradient(135deg,#7af0e3 0%,${C.accent} 45%,#22b8cf 100%);box-shadow:0 8px 28px ${a(C.accent, 0.25)}">` +
    `<a href="${esc(b.url)}" target="_blank" style="display:inline-block;padding:15px 30px;font-family:${SANS};font-size:15px;font-weight:700;color:#03110f;text-decoration:none;border-radius:12px">${esc(b.label)}&nbsp;&nbsp;&rarr;</a>` +
    `</td></tr></table>`;
  const sec = secondary
    ? `<p style="margin:0 0 24px;font-family:${SANS};font-size:13px;color:${C.muted}"><a href="${esc(secondary.url)}" target="_blank" style="color:${C.accent};text-decoration:none;font-weight:600">${esc(secondary.label)} &rsaquo;</a></p>`
    : "";
  return btn + sec;
}

function blockHtml(b: Block): string {
  if (typeof b === "string") return P(esc(b));
  if ("rows" in b) return rowsHtml(b.rows);
  if ("stats" in b) return statsHtml(b.stats);
  if ("steps" in b) return stepsHtml(b.steps, b.tone);
  if ("list" in b) return listHtml(b.list);
  if ("note" in b) return noteHtml(b.note);
  return buttonHtml(b.button, b.secondary);
}

function toHtml(m: Mail): string {
  const tone = TONE[m.tone];
  const url = appUrl();
  const banner = m.banner !== false;
  const hairline = `<div style="height:2px;line-height:2px;font-size:0;background:${C.accent};background-image:linear-gradient(90deg,${C.gold} 0%,${C.accent} 50%,${C.blue} 100%)">&nbsp;</div>`;
  const footerLinks = (
    m.admin
      ? [
          ["Admin", `${url}/admin`],
          ["Orders", `${url}/admin/orders`],
          ["Emails", `${url}/admin/emails`],
        ]
      : [
          ["My orders", `${url}/orders`],
          ["Buy hashrate", `${url}/buy`],
          ["Pool", POOL_URL],
        ]
  )
    .map(([l, h]) => `<a href="${esc(h)}" target="_blank" style="color:${C.body};text-decoration:none">${l}</a>`)
    .join(`<span style="color:${C.line}">&nbsp;&nbsp;/&nbsp;&nbsp;</span>`);

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(m.subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=Syne:wght@700;800&display=swap" rel="stylesheet">
<style>
:root{color-scheme:dark;supported-color-schemes:dark}
body{margin:0!important;padding:0!important;background:${C.page}}
a{color:${C.accent}}
@media (max-width:620px){
.bq-wrap{padding:16px 10px!important}
.bq-pad{padding-left:22px!important;padding-right:22px!important}
.bq-h1{font-size:25px!important}
.bq-stat{padding:0 3px!important}
.bq-statbox{padding:12px 10px 10px!important}
.bq-statv{font-size:16px!important}
}
</style>
</head>
<body style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page}">${esc(m.preheader)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page};background-image:radial-gradient(ellipse at top,#0f2a2c 0%,${C.page} 55%)">
<tr><td class="bq-wrap" align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">

<tr><td style="padding:0 6px 18px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle"><a href="${esc(url)}" target="_blank" style="text-decoration:none">
<img src="${imgSrc("logo")}" width="34" height="34" alt="" style="display:inline-block;vertical-align:middle;border:0">
<span style="vertical-align:middle;margin-left:8px;font-family:${DISPLAY};font-size:18px;font-weight:800;letter-spacing:.2px;color:${C.text}">BitQube</span>
</a></td>
<td align="right" style="vertical-align:middle;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${C.accent}">Cloud&nbsp;Mining</td>
</tr></table>
</td></tr>

<tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:22px;overflow:hidden">
${hairline}
${
  banner
    ? `<a href="${esc(url)}" target="_blank" style="display:block;text-decoration:none"><img src="${imgSrc("qube")}" width="598" alt="BitQube" style="display:block;width:100%;max-width:598px;height:auto;border:0;background:${C.card};color:${C.card}"></a>`
    : ""
}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="bq-pad" style="padding:${banner ? 6 : 34}px 40px 16px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr>
<td style="padding:6px 12px;border:1px solid ${a(tone, 0.33)};background:${a(tone, 0.1)};border-radius:999px;font-family:${MONO};font-size:11px;font-weight:600;letter-spacing:1.6px;text-transform:uppercase;color:${tone}">&#9679;&nbsp; ${esc(m.eyebrow)}</td>
</tr></table>
<h1 class="bq-h1" style="margin:0 0 18px;font-family:${m.admin ? SANS : DISPLAY};font-size:${m.admin ? 24 : 30}px;line-height:1.2;font-weight:800;letter-spacing:-.4px;color:${C.text}">${esc(m.heading)}</h1>
${m.blocks.map(blockHtml).join("\n")}
</td></tr></table>
</td></tr>

<tr><td align="center" style="padding:26px 20px 8px;font-family:${SANS};font-size:13px;color:${C.body}">${footerLinks}</td></tr>
<tr><td align="center" style="padding:8px 30px 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${C.muted}">
${m.footer ? `${esc(m.footer)}<br>` : ""}BitQube will never ask for your password or your wallet's recovery phrase.<br>
<a href="${esc(url)}" target="_blank" style="color:${C.muted};text-decoration:none">BitQube Cloud Mining &middot; ${esc(host())}</a>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function render(m: Mail): Content {
  return { subject: m.subject, text: toText(m), html: toHtml(m) };
}

const CUSTOMER_FOOTER =
  "You're receiving this because you have a BitQube Cloud Mining account. These are service emails about your account and orders.";

// ---- Templates ----

export function welcomeEmail(user: Pick<User, "name">): Content {
  return render({
    subject: "Welcome to BitQube Cloud Mining",
    preheader: "Your account is ready. Rent mining hashrate and mine straight to your own wallet.",
    eyebrow: "Account ready",
    tone: "accent",
    heading: `Welcome aboard${user.name ? `, ${user.name}` : ""}.`,
    blocks: [
      "Your account is ready. BitQube Cloud Mining rents real mining rigs for BitQube and other top coins and points them at a pool with your address, so what you mine lands straight in your own wallet. No hardware, no setup.",
      {
        list: [
          ["Pick a coin and a plan", "Choose how much hashrate and for how many days. You see the exact price before you pay."],
          ["Pay", "Your quote is locked for 15 minutes while you check out."],
          ["Mine to your wallet", "A full-power rig mines for you during your slot; the pool pays your address directly."],
        ],
      },
      { button: { label: "Buy hashrate", url: `${appUrl()}/buy` } },
    ],
    footer: CUSTOMER_FOOTER,
  });
}

export function passwordResetEmail(link: string, validMinutes: number): Content {
  return render({
    subject: "Reset your BitQube Cloud Mining password",
    preheader: `Your password reset link. It works once and expires in ${validMinutes} minutes.`,
    eyebrow: "Security",
    tone: "accent",
    heading: "Reset your password",
    blocks: [
      "Someone (hopefully you) asked to reset the password for this account. Use the button below to choose a new one.",
      { button: { label: "Choose a new password", url: link } },
      {
        note: `The link works once and expires in ${validMinutes} minutes. If you didn't ask for this, ignore this email; your password stays the same.`,
      },
    ],
    banner: false,
    footer: CUSTOMER_FOOTER,
  });
}

export type OrderEmailKind =
  | "order.placed"
  | "order.paid"
  | "order.scheduled"
  | "order.active"
  | "order.failed"
  | "order.completed"
  | "order.partial"
  | "order.cancelled"
  | "order.refunded";

export interface OrderEmailExtra {
  reason?: string; // order.cancelled
  deliveredPct?: string; // order.partial
  // order.placed with a BTQ part: what to send where. usd is the BTQ part's dollar value.
  btq?: { amount: string; address: string; until: Date; usd?: string };
  slots?: Array<{ startsAt: Date; endsAt: Date }>; // order.scheduled / order.active
}

export type OrderForEmail = Order & { coin: Pick<Coin, "id" | "name" | "unit" | "unitMh"> };

const slotRows = (slots: Array<{ startsAt: Date; endsAt: Date }>): Array<[string, string]> =>
  slots.map((x, i) => [slots.length > 1 ? `Slot ${i + 1}` : "Your slot", `${dateTime(x.startsAt)} → ${dateTime(x.endsAt).slice(11)}`]);

export function orderEmail(kind: OrderEmailKind, order: OrderForEmail, extra: OrderEmailExtra = {}): Content {
  const ref = order.id.slice(-8);
  const url = `${appUrl()}/orders/${order.id}`;
  const view = { label: "View order", url };
  const unit = { unit: order.coin.unit, unitMh: Number(order.coin.unitMh) };
  const coin = order.coin.name;
  const rate = coinHashrate(order.hashrateMh, unit);
  const days = `${order.days} day${order.days === 1 ? "" : "s"}`;
  const rigTime = `${minutesLabel(order.slotMinutes)} at ${coinHashrate(order.rigMh, unit)}`;
  const stats: Array<[string, string]> = [
    ["Hashrate", rate],
    ["Duration", days],
    ["Price", usd(order.priceUsd)],
  ];
  const rows: Array<[string, string]> = [
    ["Order", ref],
    ["Coin", coin],
    ["Rig time", rigTime],
    order.poolHost ? ["Your pool", `${order.poolHost}:${order.poolPort} as ${order.poolUser}`] : ["Payout address", order.payoutAddress],
  ];
  const isBtq = order.coin.id === "BTQ";
  const watch = isBtq
    ? { label: "Watch it on pool.bitqube.org", url: POOL_URL }
    : undefined;
  const base = { footer: CUSTOMER_FOOTER };

  switch (kind) {
    case "order.placed":
      if (extra.btq) {
        const part = extra.btq.usd && extra.btq.usd !== new Decimal(order.priceUsd.toString()).toFixed(2);
        return render({
          ...base,
          subject: `Order ${ref}: send ${extra.btq.amount} BTQ to confirm it`,
          preheader: `Send ${extra.btq.amount} BTQ before ${dateTime(extra.btq.until)}. Your slot is booked once payment confirms.`,
          eyebrow: "Awaiting BTQ payment",
          tone: "accent",
          heading: part ? "Send the BTQ part of your payment" : "One step left: send your BTQ",
          blocks: [
            { steps: 0 },
            part
              ? `You're paying $${extra.btq.usd} of this order in BTQ. Send the exact amount below from your BitQube wallet to this order's own payment address; the rest is paid the way you chose at checkout. Your slot is booked once both parts are confirmed.`
              : "Your order is reserved. Send the exact amount below from your BitQube wallet to this order's own payment address. Your slot is booked as soon as the payment has confirmed on the BitQube network, usually within about ten minutes of sending.",
            { stats: [["Send exactly", `${extra.btq.amount} BTQ`]] },
            {
              rows: [
                ["To address", extra.btq.address],
                ["Pay before", dateTime(extra.btq.until)],
                ...rows.slice(0, 3),
                ["Hashrate", `${rate} for ${days}`],
                ["Price", usd(order.priceUsd)],
              ],
            },
            {
              note: "This address is for this order only. Payments sent after the deadline, or short of the amount, are not accepted automatically; our team will contact you.",
            },
            { button: { label: "Open payment page", url } },
          ],
        });
      }
      return render({
        ...base,
        subject: `Order ${ref} received`,
        preheader: `${rate} of ${coin} for ${days}. Your slot is booked as soon as payment is confirmed.`,
        eyebrow: "Order received",
        tone: "accent",
        heading: "We've got your order",
        blocks: [
          { steps: 0 },
          "Thanks for choosing BitQube Cloud Mining. Your order is in, and your mining time is booked the moment your payment is confirmed. We'll email you at every step.",
          { stats },
          { rows },
          { button: view },
        ],
      });
    case "order.paid":
      return render({
        ...base,
        subject: `Payment confirmed for order ${ref}`,
        preheader: `Payment received. Your ${minutesLabel(order.slotMinutes)} of rig time is booked on a shared ${coin} rig.`,
        eyebrow: "Payment confirmed",
        tone: "accent",
        heading: "Payment received. Your time is booked.",
        blocks: [
          { steps: 1 },
          `Your payment is confirmed and your rig time is booked. You share a full-power ${coin} rig with other customers: it is rented for 24 hours and mines for each customer in turn. ${rate} for ${days} is the same total work as ${rigTime}, and that is your slot.`,
          "We'll email your slot times as soon as the rig is rented.",
          { stats },
          { rows },
          { button: view },
        ],
      });
    case "order.scheduled":
      return render({
        ...base,
        subject: `Order ${ref}: your mining slot is scheduled`,
        preheader: extra.slots?.[0] ? `Your rig time starts ${dateTime(extra.slots[0].startsAt)}.` : "Your rig time is scheduled.",
        eyebrow: "Scheduled",
        tone: "accent",
        heading: "Your slot is scheduled",
        blocks: [
          { steps: 2 },
          `The shared ${coin} rig is rented. During your slot it mines with your ${order.poolHost ? "pool login" : "address as the worker"}, so the pool pays you directly. Times are in UTC.`,
          { stats },
          { rows: [...slotRows(extra.slots ?? []), ...rows] },
          { button: view },
        ],
      });
    case "order.active":
      return render({
        ...base,
        subject: `Order ${ref} is mining`,
        preheader: `Your slot is live: a full ${coinHashrate(order.rigMh, unit)} rig is mining ${coin} for you.`,
        eyebrow: "Live",
        tone: "ok",
        heading: "Your slot is live",
        blocks: [
          { steps: 3, tone: "ok" },
          `The rig is mining ${coin} for you right now. The pool pays your ${order.poolHost ? "account" : "address"} directly, so there's nothing to claim.`,
          { rows: [...slotRows(extra.slots ?? []), ...rows] },
          {
            note: "Rigs take a minute or two to reach full speed after switching, and the hashrate a pool shows goes up and down with share luck. Look up your address on the pool to follow your worker and payouts.",
          },
          watch ? { button: view, secondary: watch } : { button: view },
        ],
      });
    case "order.failed":
      return render({
        ...base,
        subject: `Order ${ref}: mining could not start`,
        preheader: "We couldn't rent the hashrate right now. Our team is on it; you don't need to do anything.",
        eyebrow: "We're on it",
        tone: "warn",
        heading: "We couldn't start your order yet",
        blocks: [
          "We weren't able to rent the hashrate for this order right now. Our team has been notified and will either retry it shortly or refund you in full. You don't need to do anything.",
          { stats },
          { rows },
          { button: view },
        ],
      });
    case "order.completed":
      return render({
        ...base,
        subject: `Order ${ref} completed`,
        preheader: "Your mining time has finished. Thanks for mining with BitQube.",
        eyebrow: "Complete",
        tone: "ok",
        heading: "Contract complete",
        blocks: [
          { steps: 4, tone: "ok" },
          `Your mining time has finished. Any ${coin} the pool still owes you is paid out on its normal schedule. Thanks for mining with BitQube.`,
          { stats },
          { rows },
          { button: { label: "Buy more hashrate", url: `${appUrl()}/buy` }, secondary: { label: "View this order", url } },
        ],
      });
    case "order.partial":
      return render({
        ...base,
        subject: `Order ${ref} finished below the ordered hashrate`,
        preheader: "Your contract finished with a shortfall. We'll contact you about a partial refund.",
        eyebrow: "Finished with a shortfall",
        tone: "warn",
        heading: "Your order finished, with a shortfall",
        blocks: [
          { steps: 4, tone: "warn" },
          `Your contract has finished, but the rented rig delivered ${extra.deliveredPct ?? "less than 90"}% of the hashrate-hours you paid for. Our team will contact you about a partial refund for the difference.`,
          { stats },
          { rows: [...rows, ["Delivered", `${extra.deliveredPct ?? "< 90"}%`]] },
          { button: view },
        ],
      });
    case "order.cancelled":
      return render({
        ...base,
        subject: `Order ${ref} cancelled`,
        preheader: extra.reason ?? "This order has been cancelled.",
        eyebrow: "Cancelled",
        tone: "bad",
        heading: "Order cancelled",
        blocks: [extra.reason ?? "This order has been cancelled.", { stats }, { rows }, { button: view }],
        banner: false,
      });
    case "order.refunded":
      return render({
        ...base,
        subject: `Order ${ref} refunded`,
        preheader: "Your refund is on its way.",
        eyebrow: "Refunded",
        tone: "accent",
        heading: "Your refund is on its way",
        blocks: [
          "This order has been refunded. Depending on the payment method it can take a few days to show up.",
          { stats },
          { rows },
          { button: view },
        ],
        banner: false,
      });
  }
}

export function adminAlertEmail(subject: string, message: string, orderId?: string): Content {
  return render({
    subject: `[BitQube admin] ${subject}`,
    preheader: message,
    eyebrow: "Admin alert",
    tone: "warn",
    heading: subject,
    blocks: [
      message,
      {
        button: orderId
          ? { label: "Open in admin", url: `${appUrl()}/admin/orders/${orderId}` }
          : { label: "Open admin", url: `${appUrl()}/admin` },
      },
    ],
    banner: false,
    admin: true,
    footer: "Sent to BitQube Cloud Mining admins.",
  });
}

export function testEmail(): Content {
  return render({
    subject: "BitQube Cloud Mining test email",
    preheader: "If you can read this, customer emails will be delivered.",
    eyebrow: "SMTP check",
    tone: "ok",
    heading: "Email delivery works",
    blocks: [
      `This is a test email from the admin panel, sent ${dateTime(new Date())}. If you can read it, customer emails will be delivered.`,
      { button: { label: "Open admin", url: `${appUrl()}/admin/emails` } },
    ],
    footer: "Sent from the BitQube Cloud Mining admin panel.",
  });
}

// Every template with sample data, for the admin preview page.
export function sampleEmails(): Array<{ key: string; content: Content }> {
  const now = Date.now();
  const order = {
    id: "cmsample0000000000b7e4a91c",
    coin: { id: "BTQ", name: "BitQube", unit: "MH/s", unitMh: "1" },
    hashrateMh: "100",
    rigMh: "1000",
    slotMinutes: 144,
    days: 1,
    hours: 24,
    priceUsd: "2.75",
    payoutAddress: "BC2MHYXdTCtNSHhbxoPfra9hi2t2Vng5jY",
    poolHost: null,
    endsAt: new Date(now + 24 * 3600_000),
  } as unknown as OrderForEmail;
  const slots = [{ startsAt: new Date(now + 3600_000), endsAt: new Date(now + 3600_000 + 144 * 60_000) }];
  return [
    { key: "welcome", content: welcomeEmail({ name: "Asha" }) },
    { key: "password.reset", content: passwordResetEmail(`${appUrl()}/reset?token=sample`, 60) },
    { key: "order.placed", content: orderEmail("order.placed", order) },
    {
      key: "order.placed.btq",
      content: orderEmail("order.placed", order, {
        btq: { amount: "550.00", address: "BLq8TfJ6Wq2iWz9PDVxS3Q2v5gYk4hJ8rN", until: new Date(now + 3600_000), usd: "2.75" },
      }),
    },
    {
      key: "order.placed.btq-part",
      content: orderEmail("order.placed", order, {
        btq: { amount: "165.00", address: "BLq8TfJ6Wq2iWz9PDVxS3Q2v5gYk4hJ8rN", until: new Date(now + 3600_000), usd: "0.83" },
      }),
    },
    { key: "order.paid", content: orderEmail("order.paid", order) },
    { key: "order.scheduled", content: orderEmail("order.scheduled", order, { slots }) },
    { key: "order.active", content: orderEmail("order.active", order, { slots }) },
    { key: "order.completed", content: orderEmail("order.completed", order) },
    { key: "order.partial", content: orderEmail("order.partial", order, { deliveredPct: "82.4" }) },
    { key: "order.failed", content: orderEmail("order.failed", order) },
    {
      key: "order.cancelled",
      content: orderEmail("order.cancelled", order, {
        reason:
          "We didn't receive payment in time, so this order was cancelled and you have not been charged. Place a new order any time for a fresh price.",
      }),
    },
    { key: "order.refunded", content: orderEmail("order.refunded", order) },
    {
      key: "admin.alert",
      content: adminAlertEmail(
        "BitQube rig day can't be rented",
        "A shared BitQube rig with 7h 12m booked has failed to rent 3 times. Last reason: only 640 of 1000 MH/s available. The worker keeps retrying every 10 minutes; see Admin → Rigs.",
        order.id,
      ),
    },
    { key: "test", content: testEmail() },
  ];
}
