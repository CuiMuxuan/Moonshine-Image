# ADR-0006: MCP Bridge Handshake Spike

- Status: proposed reversible spike
- Date: 2026-08-16
- Owner: SEC/m3-security-spike-owner
- Reviewer: SEC independent reviewer
- Scope: M3-SEC-002 only; no Electron bridge or preload IPC

## Context

The MCP adapter must not call Electron IPC, a public FastAPI port, or application
services directly. The plan instead requires an application-owned private bridge
with a token/profile handshake. Current production code has no `McpBridge`, session
descriptor, token store, activity log, or renderer IPC for MCP.

## Candidate Under Test

This reversible probe uses a short-lived Node loopback server with an OS-assigned
port and an in-memory token/profile pair. Its session descriptor contains only the
protocol version, instance ID, `127.0.0.1` endpoint, and expiry; it never contains
the token. The bridge accepts a call only after all of these match:

1. the protocol version;
2. the capability token; and
3. the authorized profile.

An unauthenticated direct call returns `AUTH_REQUIRED`; wrong-token, wrong-profile,
and wrong-protocol handshakes return `AUTH_DENIED`, `PROFILE_DENIED`, and
`PROTOCOL_MISMATCH`. An authenticated call returns `APP_NOT_RUNNING` because this
probe never starts an application or a backend.

## Decision and Evidence Boundary

The candidate transport choice for the later implementation is loopback-only
`127.0.0.1` with an OS-assigned endpoint plus a per-profile bearer handshake. The
production bridge must also create the descriptor under application control, use a
short TTL and revocation-aware token store, freeze a policy snapshot before task
submission, and keep all token values out of descriptors, activity logs, MCP text,
and diagnostics.

Evidence is local E2 only: `test/mcp/mcp-bridge-handshake-spike.test.mjs` starts a
temporary child process, exercises unauthenticated and malformed handshakes, then
checks the authenticated no-app response. It scans captured bridge stdout/stderr and
the descriptor for the supplied token. The process is terminated after the test;
there is no package installation, Electron process, persistent listener, or user
data write.

## Security Limitation and Stop Conditions

Loopback limits network exposure but does not make a port invisible to processes
running as the same OS user. Token/profile authorization is therefore required for
every call, and allowed roots, tool policy, confirmation, and audit redaction remain
future bridge responsibilities. A named-pipe alternative requires a separately
verified current-user ACL; this spike does not claim that Node alone supplies it.

Stop M3 implementation if an arbitrary caller can invoke a bridge operation without
the matching handshake, if a token appears in any emitted output, or if the endpoint
binds outside `127.0.0.1`. Do not compensate by exposing a renderer IPC channel.

## Rollback

Delete only this ADR, `docs/evidence/M3/M3-SEC-002/`, and
`test/mcp/mcp-bridge-handshake-spike.test.mjs`; restore U-002 to an empty-evidence
`spike` entry. No production bridge, Electron/preload IPC, release object, pointer,
or user data is changed by this spike.
