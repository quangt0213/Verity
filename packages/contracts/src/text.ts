import { z } from "zod";

// C0 controls except tab/newline/carriage return, plus DEL. Built from code
// points so the source file itself contains no invisible characters.
const chr = String.fromCharCode;
const CONTROL_CHARS = new RegExp(`[${chr(0x00)}-${chr(0x08)}${chr(0x0b)}${chr(0x0c)}${chr(0x0e)}-${chr(0x1f)}${chr(0x7f)}]`, "g");
// Zero-width characters and bidirectional overrides, which can disguise text.
const INVISIBLE_FORMATTING = new RegExp(
  `[${chr(0x200b)}-${chr(0x200f)}${chr(0x202a)}-${chr(0x202e)}${chr(0x2060)}-${chr(0x2069)}${chr(0xfeff)}]`,
  "g",
);

/** Collapse a user-supplied string to one clean line. Output is still plain text, never HTML. */
export function normalizeSingleLine(value: string): string {
  return value
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_FORMATTING, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalize multi-line plain text: unify newlines, strip controls, cap blank runs. */
export function normalizeMultiline(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_FORMATTING, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A single-line text field. The raw input is capped before normalization so an
 * oversized payload is rejected without doing work on it.
 */
export function singleLineText(min: number, max: number) {
  return z
    .string()
    .max(max * 2, { message: `Must be at most ${max} characters` })
    .transform(normalizeSingleLine)
    .pipe(
      z
        .string()
        .min(min, { message: min <= 1 ? "Required" : `Must be at least ${min} characters` })
        .max(max, { message: `Must be at most ${max} characters` }),
    );
}

export function multilineText(max: number) {
  return z
    .string()
    .max(max * 2, { message: `Must be at most ${max} characters` })
    .transform(normalizeMultiline)
    .pipe(z.string().max(max, { message: `Must be at most ${max} characters` }));
}
