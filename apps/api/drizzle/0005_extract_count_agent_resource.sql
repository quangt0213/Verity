ALTER TABLE "verification_runs" ADD COLUMN "extract_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD COLUMN "agent_cleaned_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_extract_count_range" CHECK (extract_count BETWEEN 0 AND 50);--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_agent_resource_len" CHECK (agent_id IS NULL OR char_length(agent_id) BETWEEN 1 AND 128);--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_agent_resource_with_run" CHECK (agent_id IS NULL OR agent_run_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_cleanup_requires_resource" CHECK (agent_cleaned_up_at IS NULL OR agent_id IS NOT NULL);