import nodemailer from "nodemailer";
import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { renderDigest } from "@/lib/shared/digest-email";
import { loadDigestPayload } from "./digest-email.read";

/**
 * Lean Core L2.11: delivers the morning digest by SMTP (`nodemailer`).
 *
 * Not a domain mutation, so no audit row: the retry guard is `digest_emails`,
 * one row per recipient per digest day, written after the server accepted that
 * recipient's message. A recipient with a row is skipped, so a retry, a second
 * cron call or a manual re-run never mails anyone twice. A crash between "sent"
 * and the row is the one window for a duplicate (at-least-once, on purpose: a
 * missing digest is worse than a repeated one).
 *
 * Recipients: active, non-client users with a MANAGEMENT or PRODUCTION_HEAD role
 * and an email address (D23 default: MD, CEO, SJ). One message each, so nobody
 * sees the others' addresses.
 */

export const DIGEST_RECIPIENT_ROLES = ["MANAGEMENT", "PRODUCTION_HEAD"] as const;

export interface DigestMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}
export interface DigestMailer {
  from: string;
  send(msg: DigestMessage): Promise<unknown>;
}

export interface DigestEmailResult {
  /** SMTP is not configured: nothing was read or sent. */
  disabled?: boolean;
  recipients: number;
  sent: number;
  /** Already mailed for this digest day. */
  skipped: number;
  failed: number;
}

/** SMTP_HOST and SMTP_FROM are required; SMTP_PORT defaults to 587 (465 = implicit TLS); SMTP_USER / SMTP_PASS are optional (an internal relay may take none). */
export function mailerFromEnv(env: Record<string, string | undefined> = process.env): DigestMailer | null {
  const host = env.SMTP_HOST?.trim();
  const from = env.SMTP_FROM?.trim();
  if (!host || !from) return null;
  const port = Number(env.SMTP_PORT) || 587;
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } } : {}),
  });
  return { from, send: (msg) => transport.sendMail(msg) };
}

export async function sendMorningDigest(opts: {
  actor: Actor;
  /** IST day the digest goes out, "YYYY-MM-DD". */
  date: string;
  /** IST day the "yesterday" sections cover. */
  workDay: string;
  mailer?: DigestMailer | null;
  appUrl?: string | null;
  now?: Date;
}): Promise<DigestEmailResult> {
  const mailer = opts.mailer === undefined ? mailerFromEnv() : opts.mailer;
  if (!mailer) return { disabled: true, recipients: 0, sent: 0, skipped: 0, failed: 0 };

  const { tenantId } = opts.actor;
  const digestDate = new Date(`${opts.date}T00:00:00Z`);

  const { recipients, done } = await withTenant(tenantId, async (tx) => {
    const users = await tx.user.findMany({
      where: {
        tenantId,
        active: true,
        clientId: null,
        email: { not: "" },
        roles: { some: { role: { code: { in: [...DIGEST_RECIPIENT_ROLES] } } } },
      },
      orderBy: { id: "asc" },
      select: { id: true, email: true },
    });
    const sent = await tx.digestEmail.findMany({ where: { tenantId, digestDate }, select: { recipientId: true } });
    return { recipients: users, done: new Set(sent.map((s) => s.recipientId)) };
  });

  const todo = recipients.filter((r) => !done.has(r.id));
  const result: DigestEmailResult = { recipients: recipients.length, sent: 0, skipped: recipients.length - todo.length, failed: 0 };
  if (!todo.length) return result;

  const payload = await loadDigestPayload(opts.actor, {
    date: opts.date,
    workDay: opts.workDay,
    appUrl: opts.appUrl === undefined ? (process.env.APP_URL?.trim().replace(/\/+$/, "") || null) : opts.appUrl,
    now: opts.now,
  });
  const { subject, text, html } = renderDigest(payload);

  for (const r of todo) {
    try {
      await mailer.send({ from: mailer.from, to: r.email, subject, text, html });
    } catch (e) {
      console.error("[digest] email failed", { tenantId, recipientId: r.id, error: e instanceof Error ? e.message : String(e) });
      result.failed++;
      continue;
    }
    result.sent++;
    try {
      await withTenant(tenantId, (tx) =>
        tx.digestEmail.createMany({ data: [{ tenantId, digestDate, recipientId: r.id }], skipDuplicates: true }),
      );
    } catch (e) {
      // Sent but not recorded: a re-run would mail this person again. Say so loudly.
      console.error("[digest] sent but not recorded", { tenantId, recipientId: r.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
