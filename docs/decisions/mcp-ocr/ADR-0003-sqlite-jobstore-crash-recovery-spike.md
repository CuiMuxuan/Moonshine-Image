# ADR-0003: SQLite Single-Writer and Crash-Recovery Spike

- Status: Proposed for bounded spike review
- Date: 2026-08-16
- Task: M1-APP-002
- Milestone: M1
- Owner: APP/sqlite-spike-owner
- Reviewer: QA/evidence-reviewer

## Context

M1-APP-001 accepted the desired JobStore state, idempotency, event-ordering, and
no-automatic-replay behavior as a contract spike. The current application still has
only in-memory Electron processing maps and the Python SAM task manager. It does not
have a persistent JobStore, application facade, recovery worker, or database migration.

The architecture targets a coordinator-owned registry under the future
`server/moonshine_server/jobs/` boundary. Before product code can be written, local
SQLite behavior must be exercised across process exits and competing writers rather
than inferred from documentation.

## Decision Under Test

Use Python's standard-library `sqlite3` in an isolated temporary directory to test:

1. `BEGIN IMMEDIATE` serializes writers and a competing writer fails explicitly rather
   than creating a second source of truth.
2. WAL plus `synchronous=FULL` leaves no partial Job or JobEvent after a process exits
   before commit.
3. A committed `running` job with `write_started=1` is marked `interrupted` on restart,
   records `manual_confirmation_required`, and is never returned for automatic replay.
4. Schema DDL and `user_version` advance in one transaction, so an injected migration
   failure restores both the old columns/indexes and the old version.
5. JobEvent sequences are allocated and checked inside the writer transaction; a gap
   request rolls back without appending anything.

The spike uses short-lived subprocesses only to create lock and crash boundaries. Every
database is created beneath `TemporaryDirectory`; no application `userData`, project
database, backend route, Electron process, renderer, or IPC channel is touched.

## Acceptance and Stop Conditions

Accept the spike only if the isolated tests reproduce all five properties on Windows
and the existing M1/M0 contracts and governance schemas remain green. Stop and retain
the result as unknown if any competing write succeeds while the lock is held, an
uncommitted row survives, a migration partially applies, an event sequence skips, the
database fails `integrity_check`, or restart scanning schedules an automatic replay.

## Evidence Boundary

Passing tests are local E2 evidence for the recorded Python and SQLite versions only.
They do not prove packaged Python 3.12 behavior, filesystem durability under power loss,
artifact staging/fsync/atomic rename, userData migration, v1 facade parity, packaged
Electron integration, or external-machine recovery. Those remain separate reversible
spikes or implementation gates.

## Rollback

Delete this ADR, `docs/evidence/M1/M1-APP-002/`, and the two M1 SQLite spike files.
Temporary databases are removed by the tests. No production schema, user data, release
object, or channel pointer exists to migrate or restore.
