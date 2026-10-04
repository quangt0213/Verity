import type { TimePrecision } from "@verity/contracts";

/**
 * Evidence time with its real precision. Every time Verity reasons about is
 * an INTERVAL of possible moments, never a guess:
 *
 *   instant  a moment with an explicit timezone      [at, at]
 *   day      a calendar date only ("2026-10-03")      [start of that day in the
 *            easternmost zone, end of it in the westernmost zone]
 *
 * A day value is stored as 00:00 UTC of the stated calendar date. That is a
 * LABEL for the date, not a moment: consumers must use `timeBounds`, never
 * `at` directly. A clock time without a timezone is only a date (the zone is
 * unknown), so it becomes day precision too.
 *
 * Pure: no I/O, no model. Used by every normalizer (Search, Extract, Agent).
 */

export type { TimePrecision };

export interface EvidenceTime {
  at: Date;
  precision: TimePrecision;
}

/** Inclusive bounds in epoch milliseconds. */
export interface TimeBounds {
  earliest: number;
  latest: number;
}

/** Calendar days begin up to UTC+14 and end up to UTC−12. */
export interface DayZoneSlack {
  aheadHours: number;
  behindHours: number;
}
export const WORLD_ZONE_SLACK: DayZoneSlack = { aheadHours: 14, behindHours: 12 };

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const EARLIEST_ACCEPTED = Date.UTC(2000, 0, 1);
/** Clock skew tolerated for an instant that appears to be in the future. */
const FUTURE_TOLERANCE = HOUR;
const MAX_RAW = 64;

export function timeBounds(t: EvidenceTime, slack: DayZoneSlack = WORLD_ZONE_SLACK): TimeBounds {
  const at = t.at.getTime();
  if (t.precision === "instant") return { earliest: at, latest: at };
  return { earliest: at - slack.aheadHours * HOUR, latest: at + DAY + slack.behindHours * HOUR - 1 };
}

/** The label of a calendar date: 00:00 UTC of that date, or null for an impossible date (2026-02-30). */
export function dayLabel(year: number, month: number, day: number): Date | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day ? at : null;
}

/** A value is plausible only if it could already have happened (allowing small clock skew) and is not absurdly old. */
function plausible(t: EvidenceTime, now: Date, slack: DayZoneSlack): EvidenceTime | null {
  const b = timeBounds(t, slack);
  if (b.latest < EARLIEST_ACCEPTED) return null;
  if (b.earliest > now.getTime() + (t.precision === "instant" ? FUTURE_TOLERANCE : 0)) return null;
  return t;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/i;
// RFC 2822 / HTTP dates: "Sat, 03 Oct 2026 09:00:00 GMT", "3 Oct 2026 09:00 -0700".
const RFC_2822 = /^(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(GMT|UTC|UT|Z|[ECMP][SD]T|[+-]\d{4})$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** North American zone abbreviations RFC 2822 defines, plus UTC. Nothing else is guessed. */
const ZONE_OFFSET_MINUTES: Record<string, number> = { GMT: 0, UTC: 0, UT: 0, Z: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420 };

function offsetMinutes(zone: string): number | null {
  const upper = zone.toUpperCase();
  if (upper in ZONE_OFFSET_MINUTES) return ZONE_OFFSET_MINUTES[upper]!;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (!m) return null;
  const hours = Number(m[2]);
  const minutes = Number(m[3]);
  if (hours > 14 || minutes > 59) return null;
  return (m[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

function instantFrom(year: number, month: number, day: number, hour: number, minute: number, second: number, zone: string): Date | null {
  const date = dayLabel(year, month, day);
  const offset = offsetMinutes(zone);
  if (!date || offset === null || hour > 23 || minute > 59 || second > 59) return null;
  return new Date(date.getTime() + ((hour * 60 + minute - offset) * 60 + second) * 1000);
}

/**
 * Parse ONE machine-readable date value (provider metadata, page metadata).
 * Accepted: ISO dates, ISO date-times (with a zone: instant; without: day)
 * and RFC 2822 dates with a zone. Anything else (relative phrases like "2 hours
 * ago", bare years, locale formats) is rejected: null, never a guess.
 */
export function parseDateValue(raw: unknown, now: Date, slack: DayZoneSlack = WORLD_ZONE_SLACK): EvidenceTime | null {
  if (typeof raw !== "string" || raw.length > MAX_RAW) return null;
  const value = raw.trim();

  let m = ISO_DATE.exec(value);
  if (m) {
    const at = dayLabel(Number(m[1]), Number(m[2]), Number(m[3]));
    return at ? plausible({ at, precision: "day" }, now, slack) : null;
  }
  m = ISO_DATE_TIME.exec(value);
  if (m) {
    const [y, mo, d, h, mi, se, zone] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), m[8]];
    const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
    if (!zone) {
      // A wall-clock time in an unknown zone: only the date is known.
      if (h > 23 || mi > 59 || se > 59) return null;
      const at = dayLabel(y, mo, d);
      return at ? plausible({ at, precision: "day" }, now, slack) : null;
    }
    const at = instantFrom(y, mo, d, h, mi, se, zone);
    return at ? plausible({ at: new Date(at.getTime() + ms), precision: "instant" }, now, slack) : null;
  }
  m = RFC_2822.exec(value);
  if (m) {
    const month = MONTHS.indexOf(m[2]!.toLowerCase()) + 1;
    if (month === 0) return null;
    const at = instantFrom(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), m[7]!);
    return at ? plausible({ at, precision: "instant" }, now, slack) : null;
  }
  return null;
}

/** Two times are consistent when their intervals overlap, within a tolerance for small clock differences. */
export function timesConsistent(a: EvidenceTime, b: EvidenceTime, toleranceMinutes: number, slack: DayZoneSlack = WORLD_ZONE_SLACK): boolean {
  const x = timeBounds(a, slack);
  const y = timeBounds(b, slack);
  const gap = Math.max(x.earliest, y.earliest) - Math.min(x.latest, y.latest);
  return gap <= toleranceMinutes * 60_000;
}

/**
 * Combine two independent statements of the same time (e.g. Search metadata
 * and the page's own metadata). Consistent: keep the more precise one
 * (`preferred` on a tie). Materially conflicting: null, because neither can
 * be trusted over the other.
 */
export function reconcileTimes(
  preferred: EvidenceTime | null,
  other: EvidenceTime | null,
  toleranceMinutes: number,
  slack: DayZoneSlack = WORLD_ZONE_SLACK,
): { time: EvidenceTime | null; conflict: boolean } {
  if (!preferred || !other) return { time: preferred ?? other, conflict: false };
  if (!timesConsistent(preferred, other, toleranceMinutes, slack)) return { time: null, conflict: true };
  if (preferred.precision === "day" && other.precision === "instant") return { time: other, conflict: false };
  return { time: preferred, conflict: false };
}

export function toEvidenceTime(at: Date | null, precision: TimePrecision | null): EvidenceTime | null {
  return at ? { at, precision: precision ?? "instant" } : null;
}
