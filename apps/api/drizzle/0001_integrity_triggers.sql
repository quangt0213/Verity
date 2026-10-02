-- History is append-only: timeline entries and state-transition audit rows
-- can be inserted but never updated or deleted.
CREATE OR REPLACE FUNCTION verity_forbid_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER event_timeline_append_only
  BEFORE UPDATE OR DELETE ON event_timeline
  FOR EACH ROW EXECUTE FUNCTION verity_forbid_history_mutation();
--> statement-breakpoint
CREATE TRIGGER event_state_transitions_append_only
  BEFORE UPDATE OR DELETE ON event_state_transitions
  FOR EACH ROW EXECUTE FUNCTION verity_forbid_history_mutation();
--> statement-breakpoint
-- Event status changes only through the transition service, which sets a
-- transaction-local flag while it writes the audit row. New events must start
-- UNVERIFIED unless created through the same path (e.g. the dev seed).
CREATE OR REPLACE FUNCTION verity_guard_event_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed boolean := coalesce(current_setting('verity.transition_in_progress', true), '') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'UNVERIFIED' AND NOT allowed THEN
      RAISE EXCEPTION 'new events must start UNVERIFIED' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NOT allowed THEN
    RAISE EXCEPTION 'event status may only change through the transition service' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER events_status_guard
  BEFORE INSERT OR UPDATE OF status ON events
  FOR EACH ROW EXECUTE FUNCTION verity_guard_event_status();
