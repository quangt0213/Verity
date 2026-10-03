-- Verity's database is reached only by the Verity service. Hosted Postgres
-- providers such as Supabase also expose the public schema through their own
-- client APIs (PostgREST/GraphQL) as the "anon" and "authenticated" roles, and
-- grant those roles access to every new table by default. Verity uses neither
-- API, so this migration closes that path at two independent layers:
--
-- 1. Row-level security is enabled on every table, with NO policies, so any
--    non-owner role without BYPASSRLS sees no rows and can write none. The
--    service connects as the table owner, which RLS does not apply to.
-- 2. All table and function privileges are revoked from anon/authenticated,
--    and the migration role's default privileges in public stop granting them
--    on future tables, sequences and functions.
--
-- Role operations run only when those roles exist, so plain Postgres and
-- PGlite (development, tests) apply this migration unchanged.
ALTER TABLE "auth_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_verifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "community_signals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_follows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_state_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_timeline" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rate_limit_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "verification_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Trigger functions are never called directly; firing a trigger does not
-- check EXECUTE, so nobody needs it.
REVOKE ALL ON FUNCTION verity_forbid_history_mutation(), verity_guard_event_status() FROM PUBLIC;--> statement-breakpoint
DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE auth_accounts, auth_sessions, auth_verifications, community_signals, event_follows, '
        'event_state_transitions, event_timeline, events, rate_limit_counters, reports, source_records, users, '
        'verification_jobs FROM %I',
        client_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION verity_forbid_history_mutation(), verity_guard_event_status() FROM %I',
        client_role
      );
      -- Applies to objects later created in public by the role running
      -- migrations (the owner of every Verity table).
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', client_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', client_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', client_role);
    END IF;
  END LOOP;
END
$$;
