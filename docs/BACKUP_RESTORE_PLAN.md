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

## Scope

**Verity application backup (schemas `public` + `drizzle`). Not a complete
Supabase project backup.**

- **Included:**
  - `public`: the 15 Verity tables, the 2 `verity_*` functions, their 3 triggers, constraints, indexes, RLS settings, object owners and ACLs, and the schema's default privileges;
  - `drizzle`: the migration history.
  That is everything Verity's migrations create (`apps/api/drizzle/0000–0005`). Verity's own auth tables live in `public`.
- **Excluded:**
  - Supabase platform schemas (`auth`, `storage`, `vault`, `realtime`, `extensions` and others);
  - roles and their passwords (a dump only refers to role names);
  - database-level and platform settings, extensions, and Supabase's own backups.
  Supabase's platform backups, where the plan has them, are an independent fallback. Check them in the Supabase dashboard; this plan doesn't rely on them.
- **Format:** custom (`-Fc`): compressed, checksummable, restorable table by table. Ownership and ACLs are KEPT in the archive. There is no `--no-owner` or `--no-privileges` at dump time; portability options are applied only at restore time.

## Prerequisites (operator)

| Item | Requirement |
| --- | --- |
| Tools | **PostgreSQL 17 client tools (17.11), matching production's major version (17.11, gate 1):** `pg_dump`, `pg_restore`, `psql`, plus `initdb`/`pg_ctl`/`postgres` 17 for the disposable restore server. Record `--version` for each. Don't use 18.x for the production dump: a custom-format archive written by `pg_dump` 18 can't be read by `pg_restore` 17, and validating on an 18 server doesn't prove recovery onto production's major version. |
| Connection | The **direct host** (`db.<ref>.supabase.co:5432`, user `postgres`), which keeps one real session for the exported snapshot. Verified TLS as the service uses it: `sslmode=verify-full`, `sslrootcert=apps/api/certs/prod-ca-2021.crt` (the public Supabase root CA, in the repo). The direct host is IPv6-only: run from an IPv6-capable machine. Never the transaction pooler (6543). |
| Credentials | Read in-process from the operator's local `apps/api/.env`, and passed to `pg_dump` only through the child process environment. Never on the command line, in shell history, in a file in the repo or OneDrive, in logs or in chat. |
| Destination | `C:\VerityBackups\<UTC date>\`, a local disk **outside Git and OneDrive**. Its ACL allows only the operator's account (full control, inheritance removed, no SYSTEM or Administrators). Run `pg_dump`, `initdb` and `pg_ctl` as that user. Layout: `archive\` (the dump and its `.sha256`); `restore\` (the disposable server's data directory and every dump/restore log); `evidence\` (facts only: the backup facts, restore results, and the evidence README). The archive, the restore server and the logs contain authentication and personal data, and restore logs can contain row fragments (COPY error `CONTEXT` lines). Never put them, or any row contents, in screenshots, chat, attachments, commits, PRs, docs, build artifacts, a scratchpad or OneDrive. Reports carry only facts and error classes. |
| Disk | A few MB today (84 rows in 15 tables at gate 1), plus the restore server (~50 MB). Leave room for 10× growth. |
| Restore target | A disposable PostgreSQL 17 server: `initdb -U postgres --auth=trust` with its data directory under `<destination>\restore\`, listening on `127.0.0.1` only (port 55433). Every restore goes into a **newly created** database. Never a shared, staging or production database. Never start the API or worker against it. |

## Required roles and ownership (no passwords)

Production (gate 1, 2026-10-18):
- all 15 `public` tables are owned by the same role as `reports`, the role the service connects as (`postgres` on Supabase);
- RLS is on for 15/15 tables, with 0 policies;
- `anon` and `authenticated` hold 0 effective SELECT/INSERT/UPDATE/DELETE privileges on any table;
- `service_role` holds privileges on all 15 tables (informational, item 4c).

A fidelity restore (mode b) needs every role the archive names to exist first. The list is derived from the archive itself, never assumed:

```sh
pg_restore --schema-only -f - <archive>   # piped, parsed in memory: OWNER TO / GRANT / REVOKE / DEFAULT PRIVILEGES role names
```

Create each one on the disposable server as `CREATE ROLE <name> NOLOGIN`: no password, no login, no attributes beyond what the check needs. The rehearsal and production results below list the roles found.

**Grants are not re-created by re-running migrations.** Drizzle skips every migration recorded in `drizzle.__drizzle_migrations`, so a restored database keeps exactly the owners and ACLs that the archive restores (mode b) or none (mode a).

## Procedure

Times in UTC. The script driver is `ops-backup\backup.mjs` (dump) plus `ops-backup\restore-validate.mjs` (local restore and checks), kept outside Git. It prints facts only: never a connection string, host, user, password or row data.

1. **Window.** A quiet period shortly before the gate 2 migration window.
2. **Preflight** (read-only, on the dump connection). Report:
   - the server version (17.11), `current_database()`;
   - verified TLS (`sslmode=verify-full` with the repo CA, and `pg_stat_ssl` for the session);
   - the remote address family (IPv6);
   - the 6 `drizzle.__drizzle_migrations` rows matching the runbook's gate 2 table;
   - `to_regclass('public.report_schedules')` is NULL;
   - the `public` table count (15);
   - the catalog fingerprint used later: constraint and index counts by kind, functions, triggers, RLS, policies, owners, and client-role privileges.
3. **Same-snapshot counts and dump.**
   1. One session runs `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` and `SELECT pg_export_snapshot()`, and counts every table in `public` and `drizzle` inside that transaction.
   2. While that transaction stays open, the driver starts:

      ```sh
      pg_dump --format=custom --schema=public --schema=drizzle --snapshot=<id> --file=<destination>/archive/verity-<UTC>.dump
      ```

      Connection settings come from `PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE`/`PGSSLMODE`/`PGSSLROOTCERT`/`PGPASSWORD` in the child environment only.
   3. The exporting transaction ends (ROLLBACK) only after `pg_dump` exits.

   Every count and the archive come from one snapshot, so the restored counts must equal them exactly while production keeps writing. Separately timed count queries are never compared. The driver records the start/end UTC and `pg_dump`'s exit code in `<destination>\evidence\backup-facts.json`, writes the archive to `<destination>\archive\`, and writes `pg_dump`'s log to `<destination>\restore\logs\`.
4. **Checksum and size:** SHA-256 and the byte size, stored next to the archive.
5. **Inventory:** `pg_restore --list` succeeds, and lists:
   - 15 `TABLE` in `public` and 1 in `drizzle`;
   - 2 `FUNCTION` and 3 `TRIGGER` entries;
   - `ACL` entries.
   This proves the file is readable, **not** that it restores.
6. **Restore, two modes**, each into a new database on the disposable PG17 server:
   - **(a) Data validation:** `createdb verity_data`, the guarded `DROP SCHEMA public` (below), then `pg_restore --no-owner --no-privileges --exit-on-error -d verity_data`.
   - **(b) Fidelity:** create the archive's roles (NOLOGIN, no passwords), `createdb verity_fidelity`, the guarded drop, then `pg_restore --exit-on-error -d verity_fidelity`, which keeps owners and ACLs.

   With `--exit-on-error`, any error fails the step. Record success, or only the first error's class (the log stays in the destination).
7. **DROP SCHEMA guard.** The archive contains `CREATE SCHEMA public`, so the empty `public` schema of a new database is dropped first. Immediately before the drop, in the same session, the driver asserts:
   - `current_database()` is the database it just created;
   - `inet_server_port()` is the disposable port;
   - `server_version_num` is 17xxxx;
   - `data_directory` is under `<destination>\restore\`;
   - `public` contains zero relations and zero functions.

   It aborts otherwise. There is no DROP anywhere else.
8. **Checks** on both restored databases. Mode a must pass every data check; mode b must pass every check:
   - restore exit 0;
   - 15 tables in `public`, plus `drizzle.__drizzle_migrations`;
   - every per-table count equals the step 3 snapshot count;
   - 6 history rows, with `(created_at, hash)` equal to the runbook's gate 2 table;
   - `to_regclass('public.report_schedules')` is NULL;
   - 2 `verity_*` functions, and 3 non-internal triggers enabled (`O`);
   - constraint and index counts by kind equal the preflight fingerprint;
   - RLS on 15/15, 0 policies;
   - mode b only, roles:
     - table owners equal production's mapping;
     - `has_table_privilege` (SELECT/INSERT/UPDATE/DELETE) for `anon`/`authenticated` is 0;
     - `has_schema_privilege` and `has_function_privilege` for `anon`/`authenticated`/`service_role` equal the production fingerprint;
     - `service_role` table privileges equal production's.
9. **Stop** the disposable server. The restore databases, the data directory and the logs stay in the destination until the approver decides to delete them.
10. **Evidence for the gate 2 approval** (facts only):
    - start/end times;
    - tool and server versions;
    - size and SHA-256;
    - "local disk outside OneDrive";
    - the inventory result;
    - both restore results;
    - the step 8 checks.
11. **Retention:** keep the dump until 0006 has been verified in production
    (gate 3) and the release has run cleanly for an agreed period. Then delete
    it from the destination. It contains every production row, including user
    emails and sessions.

## Local rehearsal (PostgreSQL 17.11, 2026-10-18, synthetic data only)

This is the evidence for the procedure. An earlier rehearsal used PostgreSQL 18 for the dump, the restore and both servers. **That 18→18 rehearsal is superseded and is not evidence:** it doesn't show recovery onto production's major version (17), its archive format can't be read by `pg_restore` 17, and it dropped owners and ACLs at dump time.

**Tools:** all PostgreSQL 17.11 (EDB binaries zip, by absolute path, not on PATH):
- `pg_dump`, `pg_restore`, `psql`;
- `initdb`, `pg_ctl` and `postgres` for both servers.

**Source:** a disposable PG17 server on `127.0.0.1:55434`, built to production's shape:
- Supabase-like roles `anon`, `authenticated` and `service_role` (NOLOGIN);
- every table owned by `postgres`;
- Supabase-style default grants to the client roles, which Verity's migrations revoke from `anon`/`authenticated`;
- migrations 0000–0005, and fictional demo data.

The result matches gate 1's production facts: 15 tables, RLS 15/15, 0 policies, `anon`/`authenticated` with 0 table privileges, and `service_role` with privileges on 15 tables.

**Concurrent writes:**
- **Setup.** A writer committed 646 batches (report, event attach, evidence, timeline, job, counter) over 20 s.
- **Timing.** The driver exported the snapshot at 19:52:26.411Z, counted every `public`/`drizzle` table in that transaction, and waited 4 s (a rehearsal-only flag) before `pg_dump --snapshot` ran (19:52:30.418–30.614Z).
- **Divergence.** Afterwards the live source had diverged: `reports` went from 1389 at the snapshot to 1952, and `rate_limit_counters` from 1377 to 1940.

**Dump and inventory:**
- `pg_dump` 17.11, `-Fc`, `public` + `drizzle`, owners and ACLs kept: exit 0, 512,983 bytes.
- `pg_restore --list`: 140 entries:
  - 15 `TABLE` in `public` and 1 in `drizzle`;
  - 2 `FUNCTION` and 3 `TRIGGER`;
  - 21 `ACL` and 3 `DEFAULT ACL`.

**DROP guard self-test** (on the disposable restore server, `127.0.0.1:55433`):
- it refused a database with a non-empty `public`;
- it refused the wrong database ("not the just-created database");
- it refused the other server ("not the disposable port", "data directory not under the destination's restore dir"), whose `public` was untouched;
- the positive control (a just-created empty database) dropped.

**Restore (a) data** (`--no-owner --no-privileges --exit-on-error`): exit 0, and every check passed:
- 15 tables plus `drizzle.__drizzle_migrations`;
- every per-table count equal to the snapshot (0 mismatches), despite the writes;
- 6 history rows equal to the runbook's `(created_at, hash)`;
- no `report_schedules`;
- 2 functions, 3 triggers enabled;
- constraint and index counts by kind equal to the source;
- RLS 15/15, policies equal.

**Restore (b) fidelity** (with owners and ACLs, `--exit-on-error`):
- **Roles.** The archive references `anon`, `authenticated`, `pg_database_owner` (built in), `postgres` (exists) and `service_role`. The three client roles were created NOLOGIN without passwords.
- **Result.** Exit 0, and every check above passed, plus the fidelity checks:
  - owners equal: tables and functions `postgres`, schema `public` `pg_database_owner`;
  - `anon`/`authenticated`: 0 table privileges, schema USAGE yes, CREATE no, 0 function EXECUTE;
  - `service_role`: all 7 table privileges on 15 tables, schema USAGE, and EXECUTE on the 2 functions (as granted in this source);
  - the whole role fingerprint equals the source's.

**Scripts:** `ops-backup\backup.mjs` and `ops-backup\restore-validate.mjs` (outside Git). Defects found and fixed during the rehearsal: two catalog queries needed explicit casts (SQLSTATE 42725, so the preflight failed closed), and `pg_ctl start` hung on inherited pipes. Both rehearsal servers and their data were deleted afterwards.

**What production can still change:** additional Supabase role names in ACLs (derived from the archive, not assumed), different `service_role` grants (compared to production's own fingerprint, not to this rehearsal), and the data size.

## Failure handling

Gate 2 stays blocked on any failure below.

| Failure | Meaning | Next step |
| --- | --- | --- |
| Preflight fails (TLS, IPv6 reachability, history mismatch, `report_schedules` present) | Nothing was dumped | Fix the connection or stop; rerun under the same backup approval |
| `pg_dump` can't connect, or TLS fails | Nothing was dumped | Fix the connection settings; rerun under the same backup approval |
| `pg_dump` errors mid-dump, or exits non-zero | The file is incomplete | Delete the partial file; rerun under the same backup approval |
| Inventory fails | The file is unreadable | Delete it; take a new dump |
| Restore (a) or (b) fails | The backup is not usable as-is | Report the error class. Don't accept inventory-only without the approver's explicit, recorded risk acceptance |
| Counts differ from the snapshot counts | A bad dump, or a defect in the procedure (with one snapshot, writes can't explain it) | Investigate before any re-dump |
| Role or privilege fingerprint differs (mode b) | The restore doesn't reproduce production's security state | Report the difference; the data backup (mode a) may still be usable, as the approver decides |
| The DROP guard refuses | The target isn't the disposable database | Stop and investigate; never bypass the guard |
