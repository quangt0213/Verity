import {
  EVENT_CATEGORIES,
  EVENT_ORIGINS,
  EVENT_STATUSES,
  EVIDENCE_STANCES,
  FRESHNESS_STATES,
  LOCATION_MATCHES,
  SIGNAL_GROUPS,
  SIGNAL_TYPES,
  SOURCE_CLASSES,
  SOURCE_TYPES,
  TIME_MATCHES,
  TIMELINE_KINDS,
  VERIFICATION_STATES,
} from "@verity/contracts";
import { sql, type SQL } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Canonical Verity state. Database constraints back up application validation:
 * enums, ranges, lengths and uniqueness are enforced here too, and triggers
 * (see the custom migration) make history append-only and route every status
 * change through the transition service.
 */

/** `column IN ('a','b',...)` from static enum lists (never user input). */
function oneOf(column: string, values: readonly string[]): SQL {
  for (const v of values) if (!/^[A-Za-z_-]+$/.test(v)) throw new Error(`Unsafe enum value: ${v}`);
  return sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(", ")})`);
}

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const ACTOR_TYPES = ["system", "community", "verifier", "admin"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const JOB_KINDS = ["VERIFY_EVENT"] as const;
export const JOB_REASONS = ["NEW_REPORT", "REPORT_ATTACHED", "COMMUNITY_DISPUTE", "MANUAL"] as const;
export type JobReason = (typeof JOB_REASONS)[number];
export const JOB_STATUSES = ["pending", "running", "succeeded", "failed", "cancelled"] as const;
export const REPORT_OUTCOMES = ["created", "attached_to_existing"] as const;

// ---------------------------------------------------------------------------
// Authentication (managed by Better Auth through its Drizzle adapter)
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Unused display name required by Better Auth; Verity never collects one. */
    name: text("name").notNull().default(""),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email),
    check("users_email_normalized", sql`email = lower(email) AND char_length(email) BETWEEN 3 AND 254`),
    check("users_name_len", sql`char_length(name) <= 100`),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Always null: IP tracking is disabled. Column required by Better Auth. */
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("auth_sessions_token_unique").on(t.token), index("auth_sessions_user_idx").on(t.userId)],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_accounts_user_idx").on(t.userId)],
);

/** One-time sign-in codes (stored hashed by Better Auth's email OTP plugin). */
export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_verifications_identifier_idx").on(t.identifier)],
);

// ---------------------------------------------------------------------------
// Events: Verity's canonical representation of something believed to be happening
// ---------------------------------------------------------------------------

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    category: text("category").notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    approximateLocation: text("approximate_location").notNull(),
    affectedRadiusM: integer("affected_radius_m"),
    status: text("status").notNull().default("UNVERIFIED"),
    verificationState: text("verification_state").notNull().default("idle"),
    origin: text("origin").notNull(),
    evidenceSummary: text("evidence_summary"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }),
    scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    isDemo: boolean("is_demo").notNull().default(false),
    /** Internal only; never returned by public endpoints. */
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("events_status_valid", oneOf("status", EVENT_STATUSES)),
    check("events_category_valid", oneOf("category", EVENT_CATEGORIES)),
    check("events_verification_state_valid", oneOf("verification_state", VERIFICATION_STATES)),
    check("events_origin_valid", oneOf("origin", EVENT_ORIGINS)),
    check("events_latitude_range", sql`latitude BETWEEN -90 AND 90`),
    check("events_longitude_range", sql`longitude BETWEEN -180 AND 180`),
    check("events_title_len", sql`char_length(title) BETWEEN 1 AND 200`),
    check("events_summary_len", sql`char_length(summary) <= 2000`),
    check("events_location_len", sql`char_length(approximate_location) BETWEEN 1 AND 200`),
    check("events_evidence_summary_len", sql`evidence_summary IS NULL OR char_length(evidence_summary) <= 1000`),
    check("events_radius_range", sql`affected_radius_m IS NULL OR affected_radius_m BETWEEN 1 AND 50000`),
    check(
      "events_schedule_order",
      sql`scheduled_start_at IS NULL OR scheduled_end_at IS NULL OR scheduled_end_at >= scheduled_start_at`,
    ),
    index("events_lat_lng_idx").on(t.latitude, t.longitude),
    index("events_updated_idx").on(t.lastUpdatedAt, t.id),
    index("events_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// Reports: one person's claim/observation. Several may attach to one event.
// ---------------------------------------------------------------------------

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    /** Always derived from the authenticated session. */
    reporterUserId: uuid("reporter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    category: text("category").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    locationLabel: text("location_label"),
    /** Validated and stored, never fetched in Phase 2. */
    sourceUrl: text("source_url"),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    attachOutcome: text("attach_outcome").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("reports_category_valid", oneOf("category", EVENT_CATEGORIES)),
    check("reports_outcome_valid", oneOf("attach_outcome", REPORT_OUTCOMES)),
    check("reports_latitude_range", sql`latitude BETWEEN -90 AND 90`),
    check("reports_longitude_range", sql`longitude BETWEEN -180 AND 180`),
    check("reports_title_len", sql`char_length(title) BETWEEN 4 AND 120`),
    check("reports_description_len", sql`description IS NULL OR char_length(description) <= 1000`),
    check("reports_label_len", sql`location_label IS NULL OR char_length(location_label) BETWEEN 1 AND 120`),
    check(
      "reports_source_url_http",
      sql`source_url IS NULL OR (char_length(source_url) <= 2048 AND source_url ~ '^https?://')`,
    ),
    index("reports_event_idx").on(t.eventId),
    index("reports_reporter_created_idx").on(t.reporterUserId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Community signals
// ---------------------------------------------------------------------------

export const communitySignals = pgTable(
  "community_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    signalGroup: text("signal_group").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [
    check("community_signals_type_valid", oneOf("type", SIGNAL_TYPES)),
    check("community_signals_group_valid", oneOf("signal_group", SIGNAL_GROUPS)),
    check(
      "community_signals_group_matches_type",
      sql`(type IN ('CONFIRM', 'DISPUTE') AND signal_group = 'validity') OR (type IN ('STILL_HAPPENING', 'NO_LONGER_HAPPENING', 'NOT_SURE') AND signal_group = 'current_state')`,
    ),
    check("community_signals_active_consistent", sql`active = (superseded_at IS NULL)`),
    // At most one active answer per person, event and question.
    uniqueIndex("community_signals_one_active").on(t.eventId, t.userId, t.signalGroup).where(sql`active`),
    index("community_signals_event_active_idx").on(t.eventId, t.type).where(sql`active`),
  ],
);

// ---------------------------------------------------------------------------
// Follows
// ---------------------------------------------------------------------------

export const eventFollows = pgTable(
  "event_follows",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.eventId] }), index("event_follows_event_idx").on(t.eventId)],
);

// ---------------------------------------------------------------------------
// Evidence (source records). Phase 2: community reports; Phase 3: Nimble.
// ---------------------------------------------------------------------------

export const sourceRecords = pgTable(
  "source_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    reportId: uuid("report_id").references(() => reports.id, { onDelete: "restrict" }),
    sourceType: text("source_type").notNull(),
    sourceName: text("source_name").notNull(),
    sourceUrl: text("source_url"),
    sourceDomain: text("source_domain"),
    publisher: text("publisher"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
    quote: text("quote"),
    agentNote: text("agent_note"),
    stance: text("stance").notNull(),
    sourceClass: text("source_class").notNull(),
    isPrimary: boolean("is_primary").notNull(),
    lineageId: text("lineage_id").notNull(),
    countsAsIndependent: boolean("counts_as_independent").notNull(),
    freshnessState: text("freshness_state").notNull().default("fresh"),
    locationMatch: text("location_match").notNull().default("unclear"),
    timeMatch: text("time_match").notNull().default("current"),
    rawSnapshotRef: text("raw_snapshot_ref"),
    extractionMetadata: jsonb("extraction_metadata"),
    createdAt: createdAt(),
  },
  (t) => [
    check("source_records_type_valid", oneOf("source_type", SOURCE_TYPES)),
    check("source_records_stance_valid", oneOf("stance", EVIDENCE_STANCES)),
    check("source_records_class_valid", oneOf("source_class", SOURCE_CLASSES)),
    check("source_records_freshness_valid", oneOf("freshness_state", FRESHNESS_STATES)),
    check("source_records_location_valid", oneOf("location_match", LOCATION_MATCHES)),
    check("source_records_time_valid", oneOf("time_match", TIME_MATCHES)),
    check("source_records_name_len", sql`char_length(source_name) BETWEEN 1 AND 200`),
    check("source_records_quote_len", sql`quote IS NULL OR char_length(quote) <= 1000`),
    check("source_records_note_len", sql`agent_note IS NULL OR char_length(agent_note) <= 1000`),
    check("source_records_lineage_len", sql`char_length(lineage_id) BETWEEN 1 AND 64`),
    check(
      "source_records_url_http",
      sql`source_url IS NULL OR (char_length(source_url) <= 2048 AND source_url ~ '^https?://')`,
    ),
    // Copies of one origin never count twice toward independence.
    uniqueIndex("source_records_one_independent_per_lineage")
      .on(t.eventId, t.lineageId)
      .where(sql`counts_as_independent`),
    index("source_records_event_idx").on(t.eventId),
  ],
);

// ---------------------------------------------------------------------------
// History: append-only (enforced by triggers)
// ---------------------------------------------------------------------------

export const eventTimeline = pgTable(
  "event_timeline",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    detail: text("detail"),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, { onDelete: "restrict" }),
    actorType: text("actor_type").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("event_timeline_kind_valid", oneOf("kind", TIMELINE_KINDS)),
    check("event_timeline_actor_valid", oneOf("actor_type", ACTOR_TYPES)),
    check("event_timeline_from_valid", sql`from_status IS NULL OR ${oneOf("from_status", EVENT_STATUSES)}`),
    check("event_timeline_to_valid", sql`to_status IS NULL OR ${oneOf("to_status", EVENT_STATUSES)}`),
    check("event_timeline_label_len", sql`char_length(label) BETWEEN 1 AND 300`),
    check("event_timeline_detail_len", sql`detail IS NULL OR char_length(detail) <= 1000`),
    index("event_timeline_event_at_idx").on(t.eventId, t.at),
  ],
);

/** Audit trail of every status change, written only by the transition service. */
export const eventStateTransitions = pgTable(
  "event_state_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    /** Null when the event was created. */
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    reason: text("reason").notNull(),
    actorType: text("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    check("event_state_transitions_from_valid", sql`from_status IS NULL OR ${oneOf("from_status", EVENT_STATUSES)}`),
    check("event_state_transitions_to_valid", oneOf("to_status", EVENT_STATUSES)),
    check("event_state_transitions_actor_valid", oneOf("actor_type", ACTOR_TYPES)),
    check("event_state_transitions_changes", sql`from_status IS DISTINCT FROM to_status`),
    check("event_state_transitions_reason_len", sql`char_length(reason) BETWEEN 1 AND 500`),
    index("event_state_transitions_event_idx").on(t.eventId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Outbox: verification work to be done after the user's transaction commits
// ---------------------------------------------------------------------------

export const verificationJobs = pgTable(
  "verification_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("verification_jobs_kind_valid", oneOf("kind", JOB_KINDS)),
    check("verification_jobs_reason_valid", oneOf("reason", JOB_REASONS)),
    check("verification_jobs_status_valid", oneOf("status", JOB_STATUSES)),
    check("verification_jobs_attempts_range", sql`attempts >= 0 AND max_attempts BETWEEN 1 AND 10 AND attempts <= max_attempts`),
    check("verification_jobs_error_len", sql`last_error IS NULL OR char_length(last_error) <= 1000`),
    uniqueIndex("verification_jobs_idempotency_unique").on(t.idempotencyKey),
    // Deduplicate: at most one open verification job per event.
    uniqueIndex("verification_jobs_one_open_per_event")
      .on(t.eventId, t.kind)
      .where(sql`status IN ('pending', 'running')`),
    index("verification_jobs_ready_idx").on(t.status, t.availableAt),
  ],
);

// ---------------------------------------------------------------------------
// Rate limiting (fixed windows; keys are HMACs, never raw emails or IPs)
// ---------------------------------------------------------------------------

export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index("rate_limit_counters_expires_idx").on(t.expiresAt)],
);
