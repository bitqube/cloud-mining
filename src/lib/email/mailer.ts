import nodemailer, { type Transporter } from "nodemailer";
import { inlineAttachments } from "./images";

// SMTP settings come from the environment (see .env.example). With Gmail / Google
// Workspace, SMTP_PASSWORD must be an App Password, not the account password, and the
// From address must be the account itself or one of its verified aliases.

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type SendFn = (msg: OutgoingEmail) => Promise<void>;

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

export function smtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.SMTP_SERVER?.trim();
  const user = env.SMTP_USERNAME?.trim();
  const password = env.SMTP_PASSWORD?.trim();
  if (!host || !user || !password) return null;
  return {
    host,
    port: Number(env.SMTP_PORT || 587),
    user,
    password,
    from: env.SMTP_FROM?.trim() || `BitQube Cloud Mining <${user}>`,
  };
}

// What the admin panel shows: everything except the password.
export function smtpSummary(env: NodeJS.ProcessEnv = process.env) {
  return {
    host: env.SMTP_SERVER || null,
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USERNAME || null,
    from: env.SMTP_FROM || (env.SMTP_USERNAME ? `BitQube Cloud Mining <${env.SMTP_USERNAME}>` : null),
    passwordSet: Boolean(env.SMTP_PASSWORD?.trim()),
  };
}

const g = globalThis as unknown as { bqTransport?: { key: string; t: Transporter } };

function transport(c: SmtpConfig): Transporter {
  const key = `${c.host}:${c.port}:${c.user}`;
  if (g.bqTransport?.key !== key) {
    g.bqTransport = {
      key,
      t: nodemailer.createTransport({
        host: c.host,
        port: c.port,
        secure: c.port === 465, // 587 upgrades with STARTTLS
        requireTLS: c.port !== 465,
        auth: { user: c.user, pass: c.password },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      }),
    };
  }
  return g.bqTransport.t;
}

// Returns a sender, or null when SMTP is not configured yet (emails then stay queued).
export function smtpSender(env: NodeJS.ProcessEnv = process.env): SendFn | null {
  const c = smtpConfig(env);
  if (!c) return null;
  return async (msg) => {
    await transport(c).sendMail({
      from: c.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: inlineAttachments(msg.html),
    });
  };
}
