import { z } from "zod";
import { isoDateTime } from "./time";

/**
 * Verity authentication (passwordless email code). This is Verity's own
 * identity. Maypop's display identity is never part of these payloads.
 */
export const emailSchema = z
  .string()
  .trim()
  .max(254, { message: "Email is too long" })
  .transform((v) => v.toLowerCase())
  .pipe(z.email({ message: "Enter a valid email address" }));

/** POST /api/v1/auth/email/start */
export const authStartInputSchema = z.strictObject({ email: emailSchema });

/** POST /api/v1/auth/email/verify */
export const authVerifyInputSchema = z.strictObject({
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/, { message: "Enter the 6-digit code" }),
});

export const verityUserSchema = z.object({
  /** e.g. "j•••@example.com" — enough to recognize the account, minimal if a token leaks. */
  email_masked: z.string().max(254),
  created_at: isoDateTime,
});
export type VerityUser = z.infer<typeof verityUserSchema>;

/** Response of a successful verify: an opaque bearer token for Authorization headers. */
export const authSessionSchema = z.object({
  token: z.string().min(20).max(512),
  expires_at: isoDateTime,
  user: verityUserSchema,
});
export type AuthSession = z.infer<typeof authSessionSchema>;

/** GET /api/v1/me */
export const meResponseSchema = z.object({ user: verityUserSchema });

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!domain) return "•••";
  return `${local.slice(0, 1)}•••@${domain}`;
}
