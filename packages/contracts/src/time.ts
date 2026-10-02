import { z } from "zod";

/** ISO-8601 timestamp with an explicit offset (e.g. "2026-10-01T14:04:00Z"). */
export const isoDateTime = z.iso.datetime({ offset: true });
