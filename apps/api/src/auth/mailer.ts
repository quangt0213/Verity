import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nodemailer from "nodemailer";
import type { AppConfig } from "../config";

export interface SignInEmail {
  to: string;
  code: string;
}

export interface Mailer {
  sendSignInCode(message: SignInEmail): Promise<void>;
}

function render({ code }: SignInEmail) {
  const subject = `${code} is your Verity sign-in code`;
  const text = [
    `Your Verity sign-in code is ${code}.`,
    "",
    "It expires in 10 minutes. If you didn't try to sign in, you can ignore this email.",
    "",
    "Verity will never ask you for this code outside the app.",
  ].join("\n");
  return { subject, text };
}

/** Production: any SMTP provider (SMTP_URL), so Verity isn't tied to one vendor. */
export function smtpMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async sendSignInCode(message) {
      const { subject, text } = render(message);
      await transport.sendMail({ from, to: message.to, subject, text });
    },
  };
}

/** Resend's send-email endpoint (https://resend.com/docs/api-reference/emails/send-email, checked 2026-10-10). */
export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const RESEND_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_CHARS = 16 * 1024;

/**
 * A delivery failure whose message is safe to log: a short code, the HTTP
 * status and Resend's error type at most. Never the key, code or recipient.
 */
export class EmailDeliveryError extends Error {
  override name = "EmailDeliveryError";
}

const isTimeout = (error: unknown) => error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

/** Resend's error type (e.g. "validation_error"), only if it looks like one; its free-text message is never used. */
async function resendErrorType(response: Response): Promise<string | null> {
  try {
    const body: unknown = JSON.parse((await response.text()).slice(0, MAX_ERROR_BODY_CHARS));
    const name = body && typeof body === "object" && "name" in body ? (body as { name: unknown }).name : null;
    return typeof name === "string" && /^[a-z_]{1,64}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * Production: Resend's HTTPS API, for hosts that block outbound SMTP. The key
 * is sent only to RESEND_ENDPOINT (redirects are refused); one attempt per
 * code, bounded by a timeout. The caller logs failures; the user can ask for
 * a new code within the existing rate limits.
 */
export function resendMailer(options: { apiKey: string; from: string; fetch?: typeof fetch; timeoutMs?: number }): Mailer {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? RESEND_TIMEOUT_MS;
  return {
    async sendSignInCode(message) {
      const { subject, text } = render(message);
      const signal = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await doFetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ from: options.from, to: [message.to], subject, text }),
          signal,
          redirect: "error",
        });
      } catch (error) {
        throw new EmailDeliveryError(isTimeout(error) ? `resend_timeout after ${timeoutMs} ms` : "resend_network");
      }
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const type = await resendErrorType(response);
      throw new EmailDeliveryError(`resend_http_${response.status}${type ? ` ${type}` : ""}`);
    },
  };
}

/**
 * Development only: writes each email to a file in DEV_OUTBOX_DIR (git-ignored)
 * instead of sending it, so codes never appear in logs.
 */
export function devOutboxMailer(dir: string, from: string): Mailer {
  mkdirSync(dir, { recursive: true });
  let counter = 0;
  return {
    async sendSignInCode(message) {
      const { subject, text } = render(message);
      const safeTo = message.to.replace(/[^a-z0-9@._-]/gi, "_");
      const file = join(dir, `${Date.now()}-${++counter}-${safeTo}.txt`);
      writeFileSync(file, `From: ${from}\nTo: ${message.to}\nSubject: ${subject}\n\n${text}\n`, { mode: 0o600 });
    },
  };
}

/** Tests: keeps messages in memory. */
export function memoryMailer(): Mailer & { messages: SignInEmail[]; lastCodeFor(email: string): string | undefined } {
  const messages: SignInEmail[] = [];
  return {
    messages,
    async sendSignInCode(message) {
      messages.push(message);
    },
    lastCodeFor(email) {
      return [...messages].reverse().find((m) => m.to === email)?.code;
    },
  };
}

export function createMailer(config: AppConfig): Mailer {
  switch (config.email.transport) {
    case "smtp":
      return smtpMailer(config.email.smtpUrl!, config.email.from);
    case "resend":
      return resendMailer({ apiKey: config.email.resendApiKey!, from: config.email.from });
    case "dev-outbox":
      return devOutboxMailer(config.email.outboxDir, config.email.from);
    case "memory":
      return memoryMailer();
  }
}
