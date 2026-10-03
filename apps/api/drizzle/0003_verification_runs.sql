CREATE TABLE "verification_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"outcome" text DEFAULT 'running' NOT NULL,
	"search_count" integer DEFAULT 0 NOT NULL,
	"agent_run_count" integer DEFAULT 0 NOT NULL,
	"agent_requested_at" timestamp with time zone,
	"agent_run_id" text,
	"escalation_reason" text,
	"decision_rule_id" text,
	"transition_id" uuid,
	"evidence_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_runs_outcome_valid" CHECK (outcome IN ('running', 'retry_scheduled', 'deferred', 'state_changed', 'no_change', 'failed')),
	CONSTRAINT "verification_runs_completion_consistent" CHECK ((outcome IN ('running', 'retry_scheduled', 'deferred')) = (completed_at IS NULL)),
	CONSTRAINT "verification_runs_completed_after_start" CHECK (completed_at IS NULL OR completed_at >= started_at),
	CONSTRAINT "verification_runs_search_count_range" CHECK (search_count BETWEEN 0 AND 50),
	CONSTRAINT "verification_runs_agent_count_range" CHECK (agent_run_count BETWEEN 0 AND 1),
	CONSTRAINT "verification_runs_agent_claim_consistent" CHECK ((agent_run_count = 1) = (agent_requested_at IS NOT NULL)),
	CONSTRAINT "verification_runs_agent_id_requires_claim" CHECK (agent_run_id IS NULL OR agent_requested_at IS NOT NULL),
	CONSTRAINT "verification_runs_agent_id_len" CHECK (agent_run_id IS NULL OR char_length(agent_run_id) BETWEEN 1 AND 128),
	CONSTRAINT "verification_runs_escalation_len" CHECK (escalation_reason IS NULL OR char_length(escalation_reason) BETWEEN 1 AND 64),
	CONSTRAINT "verification_runs_rule_len" CHECK (decision_rule_id IS NULL OR char_length(decision_rule_id) BETWEEN 1 AND 64),
	CONSTRAINT "verification_runs_error_len" CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 64),
	CONSTRAINT "verification_runs_evidence_len" CHECK (cardinality(evidence_ids) <= 200)
);
--> statement-breakpoint
ALTER TABLE "verification_jobs" DROP CONSTRAINT "verification_jobs_reason_valid";--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_job_id_verification_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."verification_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_transition_id_event_state_transitions_id_fk" FOREIGN KEY ("transition_id") REFERENCES "public"."event_state_transitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_runs_one_per_job" ON "verification_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "verification_runs_event_started_idx" ON "verification_runs" USING btree ("event_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_one_per_url" ON "source_records" USING btree ("event_id","source_url") WHERE source_url IS NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_jobs" ADD CONSTRAINT "verification_jobs_reason_valid" CHECK (reason IN ('NEW_REPORT', 'REPORT_ATTACHED', 'COMMUNITY_DISPUTE', 'MANUAL', 'RECHECK'));--> statement-breakpoint
-- Hand-written (as in 0002): verification_runs is reached only by the Verity
-- service. Enable RLS with NO policies, and revoke the Supabase client roles
-- explicitly. 0002's default-privilege revoke already keeps them off new
-- tables; this states it for this table too. Role statements run only when the
-- roles exist, so plain Postgres and PGlite apply this unchanged.
ALTER TABLE "verification_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE verification_runs FROM %I', client_role);
    END IF;
  END LOOP;
END
$$;
