import path from "node:path";

// Images in emails are attached inline (cid:) rather than linked, so they show without a
// "load images" prompt and work before the site is on a public domain. The files live in
// public/email; the admin preview serves the same files over HTTP instead.

const IMAGES = {
  logo: "logo.png",
  qube: "qube.gif", // animated banner, rendered by scripts/email-banner.html
} as const;

export type EmailImage = keyof typeof IMAGES;

export const imgSrc = (name: EmailImage) => `cid:${name}@bitqube`;

const CID = /cid:([a-z]+)@bitqube/g;

// nodemailer attachments for every image an email's HTML refers to.
export function inlineAttachments(html: string) {
  const names = new Set([...html.matchAll(CID)].map((m) => m[1]).filter((n): n is EmailImage => n in IMAGES));
  return [...names].map((n) => ({
    filename: IMAGES[n],
    path: path.join(process.cwd(), "public", "email", IMAGES[n]),
    cid: `${n}@bitqube`,
    contentDisposition: "inline" as const,
  }));
}

// The same HTML with cid: links pointed at /email/* for viewing in a browser.
export const previewHtml = (html: string) => html.replace(CID, (m, n: string) => (n in IMAGES ? `/email/${IMAGES[n as EmailImage]}` : m));
