CREATE TABLE "geocode_cache" (
	"provider" text NOT NULL,
	"cell_key" text NOT NULL,
	"status" text NOT NULL,
	"street" text,
	"neighborhood" text,
	"city" text,
	"region" text,
	"country_code" text,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "geocode_cache_provider_cell_key_pk" PRIMARY KEY("provider","cell_key"),
	CONSTRAINT "geocode_cache_status_valid" CHECK (status IN ('ok', 'no_result')),
	CONSTRAINT "geocode_cache_no_result_empty" CHECK (status = 'ok' OR (street IS NULL AND neighborhood IS NULL AND city IS NULL AND region IS NULL AND country_code IS NULL)),
	CONSTRAINT "geocode_cache_cell_key_format" CHECK (cell_key ~ '^-?[0-9]{1,2}\.[0-9]{3},-?[0-9]{1,3}\.[0-9]{3}$'),
	CONSTRAINT "geocode_cache_country_code_format" CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
	CONSTRAINT "geocode_cache_provider_len" CHECK (char_length(provider) BETWEEN 1 AND 64),
	CONSTRAINT "geocode_cache_place_len" CHECK ((street IS NULL OR char_length(street) <= 120) AND (neighborhood IS NULL OR char_length(neighborhood) <= 120) AND (city IS NULL OR char_length(city) <= 120) AND (region IS NULL OR char_length(region) <= 120)),
	CONSTRAINT "geocode_cache_expiry_after_retrieval" CHECK (expires_at > retrieved_at)
);
--> statement-breakpoint
CREATE INDEX "geocode_cache_expires_idx" ON "geocode_cache" USING btree ("expires_at");--> statement-breakpoint
-- Hand-written (as in 0002/0003): geocode_cache is reached only by the Verity
-- worker. Enable RLS with NO policies, and revoke the Supabase client roles
-- explicitly. Role statements run only when the roles exist, so plain
-- Postgres and PGlite apply this unchanged.
ALTER TABLE "geocode_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE geocode_cache FROM %I', client_role);
    END IF;
  END LOOP;
END
$$;
