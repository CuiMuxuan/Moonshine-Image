# ADR-0005: MCP SDK Packaging Spike

- Status: proposed reversible spike
- Date: 2026-08-16
- Owner: SEC/m3-security-spike-owner
- Reviewer: SEC independent reviewer
- Scope: M3-SEC-001 only; no production adapter or package change

## Context

The 2.0.0 plan requires a local stdio MCP adapter to expose JSON-RPC while the
running application owns processing, authorization, user files, and the Python
runtime. Current production code has no MCP adapter or bridge. This spike must not
add an SDK dependency, start Electron or Python, or create a second backend merely
to make a local client work.

## Candidate Under Test

The candidate host shape is one Node stdio process using built-in stream handling:

1. Input consists of newline-delimited JSON-RPC requests.
2. Every stdout line is one JSON-RPC response. Diagnostics use stderr only.
3. `initialize`, `tools/list`, and an isolated status probe execute in that process.
4. The status probe reports zero spawned backends and zero listeners. The fixture
   also rejects imports for child-process, network, HTTP, and Electron modules.

The test fixture is not production MCP code and is not an endorsement of a
hand-written protocol implementation. It establishes the non-negotiable hosting
properties that a separately selected SDK must preserve.

## Decision and Evidence Boundary

The candidate proves that a Node-hosted stdio adapter can preserve JSON-RPC-only
stdout without a second backend. No package is selected or installed by this spike;
the implementation task must select a supported SDK only after rerunning this exact
stdout/no-backend transcript against that SDK and auditing its lockfile/package
impact. The adapter must return `APP_NOT_RUNNING` through the future bridge when the
application is absent, never launch Electron or Python itself.

Evidence is local E2 only: `test/mcp/mcp-sdk-packaging-spike.test.mjs` launches a
short-lived Node child process, sends three JSON-RPC requests, parses every stdout
line, verifies the process identity and backend/listener counters, and scans emitted
stdout/stderr for the supplied token. It writes no user data and has no package
installation step.

## Stop Conditions and Remaining Risks

Stop the M3 implementation task if a selected SDK writes diagnostics or banners to
stdout, requires a second backend, or cannot reproduce the transcript. Do not hide
such output with a filter because that would corrupt protocol semantics.

This spike does not prove full MCP specification compatibility, SDK maintenance
status, package footprint, upgrade behavior, tool-schema behavior, or packaged
Electron execution. Those remain implementation-gate requirements.

## Rollback

Delete only this ADR, `docs/evidence/M3/M3-SEC-001/`, and
`test/mcp/mcp-sdk-packaging-spike.test.mjs`; restore U-001 to an empty-evidence
`spike` entry. No production code, lockfile, process, IPC channel, release object,
pointer, model, or user data is changed by this spike.
