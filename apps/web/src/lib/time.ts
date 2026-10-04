const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface FormatOptions {
  locale?: string;
  timeZone?: string;
}

/** "just now", "4 min ago", "2 h ago", "yesterday", "in 25 min". */
export function relativeTime(iso: string, now: number, opts: FormatOptions = {}): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown time";
  const diff = now - then;
  const future = diff < 0;
  const abs = Math.abs(diff);

  if (abs < 45_000) return future ? "in a moment" : "just now";
  if (abs < HOUR) {
    const m = Math.max(1, Math.round(abs / MINUTE));
    return future ? `in ${m} min` : `${m} min ago`;
  }
  if (abs < DAY) {
    const h = Math.round(abs / HOUR);
    return future ? `in ${h} h` : `${h} h ago`;
  }
  if (!future && abs < 2 * DAY) return "yesterday";
  if (abs < 7 * DAY) {
    const d = Math.round(abs / DAY);
    return future ? `in ${d} days` : `${d} days ago`;
  }
  return new Intl.DateTimeFormat(opts.locale, { month: "short", day: "numeric", timeZone: opts.timeZone }).format(then);
}

/**
 * A date known only to the day ("Oct 3", or "Oct 3, 2025" in another year).
 * The value is 00:00 UTC of the stated calendar date, so it is formatted in
 * UTC: converting it to local time would shift the day and invent a clock time.
 */
export function calendarDate(iso: string, now: number, opts: Pick<FormatOptions, "locale"> = {}): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown date";
  const sameYear = new Date(then).getUTCFullYear() === new Date(now).getUTCFullYear();
  return new Intl.DateTimeFormat(opts.locale, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric", timeZone: "UTC" }).format(then);
}

function sameDay(a: number, b: number, timeZone?: string): boolean {
  const fmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone });
  return fmt.format(a) === fmt.format(b);
}

/** "2:04 PM", or "Sep 30, 2:04 PM" when not today. */
export function clockTime(iso: string, now: number, opts: FormatOptions = {}): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const time = new Intl.DateTimeFormat(opts.locale, { hour: "numeric", minute: "2-digit", timeZone: opts.timeZone });
  if (sameDay(t, now, opts.timeZone)) return time.format(t);
  const date = new Intl.DateTimeFormat(opts.locale, { month: "short", day: "numeric", timeZone: opts.timeZone });
  return `${date.format(t)}, ${time.format(t)}`;
}

/** Describe a scheduled window relative to now: "Starts in 25 min · until 10:25 PM". */
export function scheduleText(
  start: string | null,
  end: string | null,
  now: number,
  opts: FormatOptions = {},
): string | null {
  if (!start && !end) return null;
  const s = start ? Date.parse(start) : null;
  const e = end ? Date.parse(end) : null;
  if (s !== null && s > now) {
    return `Starts ${relativeTime(start!, now, opts)}${end ? ` · until ${clockTime(end, now, opts)}` : ""}`;
  }
  if (e !== null && e < now) return `Ended ${relativeTime(end!, now, opts)}`;
  if (end) return `Happening now · until ${clockTime(end, now, opts)}`;
  return `Started ${relativeTime(start!, now, opts)}`;
}

export function windowText(minutes: number): string {
  if (minutes <= 60) return minutes === 60 ? "in the last hour" : `in the last ${minutes} min`;
  if (minutes % 60 === 0) return `in the last ${minutes / 60} hours`;
  return `in the last ${minutes} min`;
}
