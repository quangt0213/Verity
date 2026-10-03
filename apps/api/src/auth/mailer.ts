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
    case "dev-outbox":
      return devOutboxMailer(config.email.outboxDir, config.email.from);
    case "memory":
      return memoryMailer();
  }
}
