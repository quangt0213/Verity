-- A reporter's CLAIMED schedule for a planned event, one row per report and
-- only when given. Never copied to events.scheduled_* (the established
-- schedule the decision rules use), so a reporter's input can't move an
-- event's status. A new table rather than new `reports` columns, so report
-- creation keeps working if code is deployed before this migration.
CREATE TABLE "report_schedules" (
	"report_id" uuid PRIMARY KEY NOT NULL,
	"scheduled_start_at" timestamp with time zone NOT NULL,
	"scheduled_end_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_schedules_order" CHECK (scheduled_end_at IS NULL OR scheduled_end_at >= scheduled_start_at)
);
--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Hand-written (as in 0002/0003/0004): report_schedules is reached only by the
-- Verity service and worker. Enable RLS with NO policies, and revoke the
-- Supabase client roles explicitly. Role statements run only when the roles
-- exist, so plain Postgres and PGlite apply this unchanged.
ALTER TABLE "report_schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE report_schedules FROM %I', client_role);
    END IF;
  END LOOP;
END
$$;
