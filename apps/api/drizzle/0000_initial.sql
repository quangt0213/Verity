CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"signal_group" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "community_signals_type_valid" CHECK (type IN ('CONFIRM', 'DISPUTE', 'STILL_HAPPENING', 'NO_LONGER_HAPPENING', 'NOT_SURE')),
	CONSTRAINT "community_signals_group_valid" CHECK (signal_group IN ('validity', 'current_state')),
	CONSTRAINT "community_signals_group_matches_type" CHECK ((type IN ('CONFIRM', 'DISPUTE') AND signal_group = 'validity') OR (type IN ('STILL_HAPPENING', 'NO_LONGER_HAPPENING', 'NOT_SURE') AND signal_group = 'current_state')),
	CONSTRAINT "community_signals_active_consistent" CHECK (active = (superseded_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "event_follows" (
	"user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_follows_user_id_event_id_pk" PRIMARY KEY("user_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "event_state_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_state_transitions_from_valid" CHECK (from_status IS NULL OR from_status IN ('UNVERIFIED', 'DEVELOPING', 'LIKELY', 'VERIFIED', 'CONFLICTING', 'STALE', 'RESOLVED', 'REJECTED')),
	CONSTRAINT "event_state_transitions_to_valid" CHECK (to_status IN ('UNVERIFIED', 'DEVELOPING', 'LIKELY', 'VERIFIED', 'CONFLICTING', 'STALE', 'RESOLVED', 'REJECTED')),
	CONSTRAINT "event_state_transitions_actor_valid" CHECK (actor_type IN ('system', 'community', 'verifier', 'admin')),
	CONSTRAINT "event_state_transitions_changes" CHECK (from_status IS DISTINCT FROM to_status),
	CONSTRAINT "event_state_transitions_reason_len" CHECK (char_length(reason) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "event_timeline" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"detail" text,
	"from_status" text,
	"to_status" text,
	"source_record_id" uuid,
	"actor_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_timeline_kind_valid" CHECK (kind IN ('report_received', 'report_merged', 'verification_started', 'source_found', 'contradiction_found', 'status_changed', 'checked_no_change', 'verification_unavailable', 'community_update', 'expected_end_passed')),
	CONSTRAINT "event_timeline_actor_valid" CHECK (actor_type IN ('system', 'community', 'verifier', 'admin')),
	CONSTRAINT "event_timeline_from_valid" CHECK (from_status IS NULL OR from_status IN ('UNVERIFIED', 'DEVELOPING', 'LIKELY', 'VERIFIED', 'CONFLICTING', 'STALE', 'RESOLVED', 'REJECTED')),
	CONSTRAINT "event_timeline_to_valid" CHECK (to_status IS NULL OR to_status IN ('UNVERIFIED', 'DEVELOPING', 'LIKELY', 'VERIFIED', 'CONFLICTING', 'STALE', 'RESOLVED', 'REJECTED')),
	CONSTRAINT "event_timeline_label_len" CHECK (char_length(label) BETWEEN 1 AND 300),
	CONSTRAINT "event_timeline_detail_len" CHECK (detail IS NULL OR char_length(detail) <= 1000)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"category" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"approximate_location" text NOT NULL,
	"affected_radius_m" integer,
	"status" text DEFAULT 'UNVERIFIED' NOT NULL,
	"verification_state" text DEFAULT 'idle' NOT NULL,
	"origin" text NOT NULL,
	"evidence_summary" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"scheduled_start_at" timestamp with time zone,
	"scheduled_end_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_status_valid" CHECK (status IN ('UNVERIFIED', 'DEVELOPING', 'LIKELY', 'VERIFIED', 'CONFLICTING', 'STALE', 'RESOLVED', 'REJECTED')),
	CONSTRAINT "events_category_valid" CHECK (category IN ('road_closure', 'crash', 'flooding', 'fire', 'police_activity', 'transit_disruption', 'construction', 'power_outage', 'protest', 'parade', 'concert', 'sporting_event', 'festival', 'campus_event', 'parking_traffic', 'other')),
	CONSTRAINT "events_verification_state_valid" CHECK (verification_state IN ('queued', 'in_progress', 'idle', 'unavailable')),
	CONSTRAINT "events_origin_valid" CHECK (origin IN ('community_report', 'source_discovered')),
	CONSTRAINT "events_latitude_range" CHECK (latitude BETWEEN -90 AND 90),
	CONSTRAINT "events_longitude_range" CHECK (longitude BETWEEN -180 AND 180),
	CONSTRAINT "events_title_len" CHECK (char_length(title) BETWEEN 1 AND 200),
	CONSTRAINT "events_summary_len" CHECK (char_length(summary) <= 2000),
	CONSTRAINT "events_location_len" CHECK (char_length(approximate_location) BETWEEN 1 AND 200),
	CONSTRAINT "events_evidence_summary_len" CHECK (evidence_summary IS NULL OR char_length(evidence_summary) <= 1000),
	CONSTRAINT "events_radius_range" CHECK (affected_radius_m IS NULL OR affected_radius_m BETWEEN 1 AND 50000),
	CONSTRAINT "events_schedule_order" CHECK (scheduled_start_at IS NULL OR scheduled_end_at IS NULL OR scheduled_end_at >= scheduled_start_at)
);
--> statement-breakpoint
CREATE TABLE "rate_limit_counters" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_counters_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"location_label" text,
	"source_url" text,
	"observed_at" timestamp with time zone,
	"attach_outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_category_valid" CHECK (category IN ('road_closure', 'crash', 'flooding', 'fire', 'police_activity', 'transit_disruption', 'construction', 'power_outage', 'protest', 'parade', 'concert', 'sporting_event', 'festival', 'campus_event', 'parking_traffic', 'other')),
	CONSTRAINT "reports_outcome_valid" CHECK (attach_outcome IN ('created', 'attached_to_existing')),
	CONSTRAINT "reports_latitude_range" CHECK (latitude BETWEEN -90 AND 90),
	CONSTRAINT "reports_longitude_range" CHECK (longitude BETWEEN -180 AND 180),
	CONSTRAINT "reports_title_len" CHECK (char_length(title) BETWEEN 4 AND 120),
	CONSTRAINT "reports_description_len" CHECK (description IS NULL OR char_length(description) <= 1000),
	CONSTRAINT "reports_label_len" CHECK (location_label IS NULL OR char_length(location_label) BETWEEN 1 AND 120),
	CONSTRAINT "reports_source_url_http" CHECK (source_url IS NULL OR (char_length(source_url) <= 2048 AND source_url ~ '^https?://'))
);
--> statement-breakpoint
CREATE TABLE "source_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"report_id" uuid,
	"source_type" text NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text,
	"source_domain" text,
	"publisher" text,
	"published_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"quote" text,
	"agent_note" text,
	"stance" text NOT NULL,
	"source_class" text NOT NULL,
	"is_primary" boolean NOT NULL,
	"lineage_id" text NOT NULL,
	"counts_as_independent" boolean NOT NULL,
	"freshness_state" text DEFAULT 'fresh' NOT NULL,
	"location_match" text DEFAULT 'unclear' NOT NULL,
	"time_match" text DEFAULT 'current' NOT NULL,
	"raw_snapshot_ref" text,
	"extraction_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_records_type_valid" CHECK (source_type IN ('web_page', 'news_article', 'official_feed', 'social_post', 'community_report', 'structured_extraction')),
	CONSTRAINT "source_records_stance_valid" CHECK (stance IN ('supports', 'contradicts', 'ended', 'context')),
	CONSTRAINT "source_records_class_valid" CHECK (source_class IN ('OFFICIAL', 'FIRST_PARTY', 'REPUTABLE_NEWS', 'LOCAL_NEWS', 'COMMUNITY', 'SOCIAL', 'UNKNOWN')),
	CONSTRAINT "source_records_freshness_valid" CHECK (freshness_state IN ('fresh', 'aging', 'stale')),
	CONSTRAINT "source_records_location_valid" CHECK (location_match IN ('exact', 'near', 'unclear', 'mismatch')),
	CONSTRAINT "source_records_time_valid" CHECK (time_match IN ('current', 'recent', 'outdated', 'unclear')),
	CONSTRAINT "source_records_name_len" CHECK (char_length(source_name) BETWEEN 1 AND 200),
	CONSTRAINT "source_records_quote_len" CHECK (quote IS NULL OR char_length(quote) <= 1000),
	CONSTRAINT "source_records_note_len" CHECK (agent_note IS NULL OR char_length(agent_note) <= 1000),
	CONSTRAINT "source_records_lineage_len" CHECK (char_length(lineage_id) BETWEEN 1 AND 64),
	CONSTRAINT "source_records_url_http" CHECK (source_url IS NULL OR (char_length(source_url) <= 2048 AND source_url ~ '^https?://'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_normalized" CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
	CONSTRAINT "users_name_len" CHECK (char_length(name) <= 100)
);
--> statement-breakpoint
CREATE TABLE "verification_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"event_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_jobs_kind_valid" CHECK (kind IN ('VERIFY_EVENT')),
	CONSTRAINT "verification_jobs_reason_valid" CHECK (reason IN ('NEW_REPORT', 'REPORT_ATTACHED', 'COMMUNITY_DISPUTE', 'MANUAL')),
	CONSTRAINT "verification_jobs_status_valid" CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "verification_jobs_attempts_range" CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 10 AND attempts <= max_attempts),
	CONSTRAINT "verification_jobs_error_len" CHECK (last_error IS NULL OR char_length(last_error) <= 1000)
);
--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_signals" ADD CONSTRAINT "community_signals_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_signals" ADD CONSTRAINT "community_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_follows" ADD CONSTRAINT "event_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_follows" ADD CONSTRAINT "event_follows_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_state_transitions" ADD CONSTRAINT "event_state_transitions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_state_transitions" ADD CONSTRAINT "event_state_transitions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_timeline" ADD CONSTRAINT "event_timeline_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_timeline" ADD CONSTRAINT "event_timeline_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_jobs" ADD CONSTRAINT "verification_jobs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_accounts_user_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_unique" ON "auth_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "community_signals_one_active" ON "community_signals" USING btree ("event_id","user_id","signal_group") WHERE active;--> statement-breakpoint
CREATE INDEX "community_signals_event_active_idx" ON "community_signals" USING btree ("event_id","type") WHERE active;--> statement-breakpoint
CREATE INDEX "event_follows_event_idx" ON "event_follows" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_state_transitions_event_idx" ON "event_state_transitions" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX "event_timeline_event_at_idx" ON "event_timeline" USING btree ("event_id","at");--> statement-breakpoint
CREATE INDEX "events_lat_lng_idx" ON "events" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE INDEX "events_updated_idx" ON "events" USING btree ("last_updated_at","id");--> statement-breakpoint
CREATE INDEX "events_status_idx" ON "events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "rate_limit_counters_expires_idx" ON "rate_limit_counters" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "reports_event_idx" ON "reports" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "reports_reporter_created_idx" ON "reports" USING btree ("reporter_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_one_independent_per_lineage" ON "source_records" USING btree ("event_id","lineage_id") WHERE counts_as_independent;--> statement-breakpoint
CREATE INDEX "source_records_event_idx" ON "source_records" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_jobs_idempotency_unique" ON "verification_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_jobs_one_open_per_event" ON "verification_jobs" USING btree ("event_id","kind") WHERE status IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "verification_jobs_ready_idx" ON "verification_jobs" USING btree ("status","available_at");