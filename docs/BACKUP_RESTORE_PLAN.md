# Backup and restore-validation plan (before migration 0006)

The concrete procedure behind [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md),
gate 2, item 1. **Writing or reviewing this plan authorizes nothing.** Taking
the production dump needs its own approval:

> "Approve production backup: read-only `pg_dump` of the Verity schemas, plus a
> local restore validation."

It is read-only on production, but it copies all production data to a local
disk, so it is approved separately from gate 2. Never restore into production
except under "Approve restore from the gate 2 backup."

Git, code and tests win over this file. If they disagree, fix this file.

## What is backed up

- **Schemas:** `public` (the 15 Verity tables, the `verity_*` functions and
  their 3 triggers, RLS settings) and `drizzle` (the migration history). That
  is everything Verity's migrations create (`apps/api/drizzle/0000–0005`).
  Verity uses no extensions and no Supabase-managed schemas (`auth`, `storage`,
  `vault` and so on). Its own auth tables live in `public`.
- **Format:** custom (`-Fc`): compressed, checksummable, and restorable table
  by table with `pg_restore`.
- **Not included:** roles, Supabase platform schemas and Supabase's own
  backups. Supabase's platform backups, where the plan has them, are an
  independent fallback. Check them in the Supabase dashboard; this plan
  doesn't rely on them.

## Prerequisites (operator)

| Item | Requirement |
| --- | --- |
| Tools | PostgreSQL client tools of the server's major version or newer. Production reported 17.11 (gate 1); the installed `pg_dump`/`pg_restore` 18.6 (`C:\Program Files\PostgreSQL\18\bin`) can dump and restore a 17 server. Record `pg_dump --version`. |
| Connection | The same verified-TLS path the service uses: `sslmode=verify-full`, `sslrootcert=apps/api/certs/prod-ca-2021.crt` (public Supabase root CA, in the repo). Session pooler (port 5432) or the direct host. **Not** the transaction pooler (6543), because `pg_dump` needs one session for its snapshot. |
| Credentials | Typed at the password prompt, or kept in a `pgpass` file inside the secure destination folder (`PGPASSFILE`). Never on the command line, in shell history, in the repo, in OneDrive or in chat. |
| Destination | A new folder **outside Git and outside OneDrive**, for example `C:\VerityBackups\<UTC date>\` on a local disk, or an encrypted external drive. Not `Desktop`, `Documents` or `Downloads`: OneDrive can back those up. Optionally restrict access to the operator's account (`icacls`). |
| Disk | A few MB today (84 rows in 15 tables at gate 1). Leave room for 10× growth. |
| Restore target | A disposable local cluster: `initdb` in a temporary folder, listening on `127.0.0.1` only (for example port 55433), trust auth. Deleted after validation. Never a shared, staging or production database. |

## Procedure

Times in UTC. The operator runs every production-facing step. An agent may run
the local restore steps under the same approval if asked.

1. **Window.** Choose a quiet period shortly before the gate 2 migration
   window, so the dump reflects the data that the migration will see.
2. **Read-only production counts** at dump time, for the comparison in step 7,
   run in a `BEGIN TRANSACTION READ ONLY` session:

   ```sql
   SELECT 'users', count(*) FROM users UNION ALL
   SELECT 'events', count(*) FROM events UNION ALL
   SELECT 'reports', count(*) FROM reports UNION ALL
   SELECT 'source_records', count(*) FROM source_records UNION ALL
   SELECT 'community_signals', count(*) FROM community_signals UNION ALL
   SELECT 'verification_jobs', count(*) FROM verification_jobs UNION ALL
   SELECT 'verification_runs', count(*) FROM verification_runs;
   SELECT count(*) FROM drizzle.__drizzle_migrations;            -- 6
   ```

   `rate_limit_counters` and `auth_sessions` change constantly; they are not
   compared.
3. **Dump** (read-only on production; prompts for the password):

   ```sh
   pg_dump --format=custom --schema=public --schema=drizzle \
     --no-owner --no-privileges --verbose \
     --file="<destination>/verity-<UTC timestamp>.dump" \
     "host=<host> port=5432 dbname=postgres user=<role> sslmode=verify-full sslrootcert=<repo>/apps/api/certs/prod-ca-2021.crt"
   ```

   - **Ownership and grants:** `--no-owner --no-privileges` let the dump
     restore into a plain local cluster. Production ownership and grants
     (the service role as owner, `anon`/`authenticated` revoked) are
     re-established by the migrations and checked by the runbook's queries.
     Record the start and end times.
   - **Log:** the `--verbose` output goes to the console. Keep it out of the
     repo.
4. **Checksum and size:** `sha256sum` (or PowerShell `Get-FileHash -Algorithm
   SHA256`) and the byte size. Store the checksum next to the dump.
5. **Inventory validation:** `pg_restore --list <dump>` succeeds. Record the
   entry count, and that it lists 15 `TABLE` entries in `public`, the
   `__drizzle_migrations` table in `drizzle`, 2 `FUNCTION` and 3 `TRIGGER`
   entries. This proves the file is readable, **not** that it restores.
6. **Restore validation**, local and disposable:

   ```sh
   initdb -D <tmp>/restore-check -U restore_check --auth=trust -E UTF8
   pg_ctl -D <tmp>/restore-check -o "-p 55433 -c listen_addresses=127.0.0.1" -l <tmp>/restore-check.log start
   createdb -h 127.0.0.1 -p 55433 -U restore_check verity_restore
   psql -h 127.0.0.1 -p 55433 -U restore_check -d verity_restore -c "DROP SCHEMA public"
   pg_restore --exit-on-error --no-owner --no-privileges \
     -h 127.0.0.1 -p 55433 -U restore_check -d verity_restore "<dump>"
   ```

   - **`--exit-on-error`:** any error fails the step. Record success, or the
     first error's class, never row data.
   - **Why the empty `public` schema is dropped first:** a dump that names
     `--schema=public` contains `CREATE SCHEMA public`. Without the drop, the
     restore fails with "schema public already exists". The drop is safe only
     because `verity_restore` was created in the previous command and is
     empty. Never run it anywhere else.
7. **Checks on the restored database:**
   - 15 tables in `public` (`SELECT count(*) FROM pg_tables WHERE schemaname='public'`);
   - the step 2 counts match exactly;
   - `drizzle.__drizzle_migrations` has 6 rows, and `(created_at, hash)`
     equals the runbook's gate 2 table;
   - `to_regclass('public.report_schedules')` is `NULL`;
   - the 3 triggers exist and are enabled (`O`):
     `SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal`;
   - RLS is enabled on the 15 tables (`relrowsecurity`).
   - **Optional rehearsal:** on this restored copy, run PR A's
     `dist/migrate.js` against `127.0.0.1:55433` and the runbook's gate 3
     queries. This rehearses gate 2 on real data, locally.
8. **Cleanup:** `pg_ctl -D <tmp>/restore-check -m fast stop`, then delete
   `<tmp>/restore-check` and its log. Keep only the dump and its checksum in
   the destination.
9. **Evidence for the gate 2 approval** (facts only):
   - start and end times;
   - tool and server versions;
   - size and SHA-256;
   - the destination, described ("local disk outside OneDrive" or "encrypted
     external drive"), never a path inside the repo or OneDrive;
   - the inventory result;
   - the restore result;
   - the step 7 checks.
10. **Retention:** keep the dump until 0006 has been verified in production
    (gate 3) and the release has run cleanly for an agreed period. Then delete
    it from the destination. It contains every production row, including user
    emails and sessions.

## Local rehearsal (2026-10-18, no production data)

The procedure was run end to end on two throwaway local PostgreSQL 18
clusters:
- **Source:** a 0005 database with Supabase-like roles and demo data (15
  events, 29 source records).
- **Dump:** exit 0, 69 KB.
- **Inventory:** 119 entries: 15 `TABLE` in `public`, 1 in `drizzle`, 2
  `FUNCTION`, 3 `TRIGGER`.
- **First restore:** failed on `CREATE SCHEMA public`. That is the step-6
  issue, fixed by dropping the empty `public` schema first.
- **Restore with the fix:** exit 0. Key-table counts and migration history
  were identical to the source; 15 tables; RLS on 15/15; 3 triggers enabled;
  no `report_schedules`.
- **Optional step 7 rehearsal:** the built `dist/migrate.js` applied 0006 to
  the restored copy (7 history rows, RLS on the new table).

Both clusters were deleted afterwards. A production dump can still differ:
Supabase role names, grants and the server version (17.11). This is why the
real restore validation is required.

## Failure handling

| Failure | Meaning | Next step |
| --- | --- | --- |
| `pg_dump` can't connect, or TLS fails | Nothing was dumped | Fix the connection settings; rerun under the same backup approval |
| `pg_dump` errors mid-dump | The file is incomplete | Delete the partial file; rerun under the same backup approval |
| Inventory fails | The file is unreadable | Delete it; take a new dump |
| Restore fails | The backup is not usable as-is | Gate 2 stays blocked. Report the error class. Don't accept inventory-only without the approver's explicit, recorded risk acceptance |
| Counts differ | Writes between the counts and the dump, or a bad dump | Re-count and re-dump in a quieter window. Gate 2 stays blocked until they match |
