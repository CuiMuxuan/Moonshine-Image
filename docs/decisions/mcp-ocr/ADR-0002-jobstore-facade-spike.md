# ADR-0002: JobStore and Application Facade Spike

- Status: proposed spike
- Date: 2026-08-16
- Owner: APP/root
- Reviewer: QA/RED
- Scope: M1-APP-001 only; no production runtime wiring

## Context

The current application keeps active work in process memory (`activeProcessingTasks`,
`activeFfmpegTasks`, and the Python SAM task manager). The v1 image/video services
also call FastAPI routes directly. Those facts satisfy the current product, but they
do not provide a durable job registry, request idempotency, event cursors, artifact
provenance, or crash recovery.

`core-v2` already freezes the proposed `Job`, `JobEvent`, and `Artifact` shapes. This
spike turns the behavior around those shapes into executable, reversible rules before
any SQLite schema or application facade is added.

## Decision Under Test

The future application layer will expose a single submission/fetch/cancel facade and
one coordinator-owned JobStore writer:

1. A submission is keyed by `(client_scope, idempotency_key)` and stores the request
   fingerprint. Repeating the key with the same fingerprint returns the existing job;
   a different fingerprint is a conflict and cannot create a second job.
2. Allowed status transitions are `queued -> running`, `running -> succeeded`,
   `running -> failed`, `running -> cancelling`, `cancelling -> cancelled`, and
   `cancelling -> failed`. Terminal states do not transition again.
3. Job events are append-only and have a contiguous, zero-based sequence per job.
   Readers use a cursor and never infer completion from renderer or process exit.
4. Results are staged under a job-scoped temporary reference, hashed, and atomically
   published as an artifact. A started write is not automatically replayed after a
   crash; recovery marks it for inspection/cleanup.
5. Cancellation is cooperative: the registry records `cancelling` first, then only
   the worker/coordinator can publish `cancelled` after cleanup is complete.

## Current Code Boundary

This ADR does not claim that `JobStore`, `ApplicationFacade`, SQLite persistence,
crash recovery, or worker adapters exist. It does not change Electron IPC, Vue stores,
FastAPI routes, Python task managers, or user data.

## Unknowns and Stop Conditions

- SQLite single-writer locking, migration, fsync/atomic rename, and restart recovery
  remain `unknown_reversible` and require a two-day spike before implementation.
- v1 facade extraction must compare status codes, fields, per-item failures, output
  locations, and cancellation behavior before any route is switched.
- Stop if a duplicate request can publish twice, an event sequence skips/rewinds, a
  terminal job changes state, a staged file is replayed without confirmation, or a
  migration cannot be rolled back.

## Evidence and Rollback

The executable fixture and test are local E2 behavior evidence only. They are isolated
under `test/contracts/m1-jobstore/` and do not import production modules. Rollback is
path-limited: remove this ADR, the M1 evidence directory, and the M1 fixture/test
directory. No database, release object, pointer, IPC channel, or user file is touched.
