# M0 Threat Model

Status: baseline for review. Controls listed as `target` are not implemented by this document-only milestone.

| Boundary | Current fact | Target control | Stop condition |
|---|---|---|---|
| MCP client -> stdio adapter | No 2.0 MCP adapter exists | JSON-RPC only on stdout; initialize/tool allow-list; small references instead of user bytes | Any non-JSON stdout or unregistered tool |
| Adapter -> Electron bridge | No dedicated bridge exists | Private transport, per-launch token/profile, request fingerprint, timeout, cancellation | Token disclosure, second backend, or arbitrary IPC reachability |
| Renderer -> main process | Existing preload exposes approved app operations, not v2 jobs | Renderer submits commands and consumes events; main owns jobs, tray, quit, and navigation policy | Renderer becomes job truth or controls Tray/exit directly |
| Main process -> Python service | Existing DTOs allow path/base64 processing | Application facade maps v2 refs to explicit legacy/new DTOs; no implicit field sharing | Path escapes approved roots or schema version is unknown |
| Job staging -> artifact publication | No persistent v2 JobStore exists | Single writer, atomic staging promotion, hash, retention, replay, orphan cleanup | Duplicate write, future state, orphan artifact, non-reversible migration |
| OCR/SAM/model assets | SAM/model management exists; default OCR decision is open | Signed component identity, license record, frozen model revision, resource quota | Missing license owner, silent download, or unbounded resource use |
| Logs/activity/telemetry | Existing diagnostics may contain process details | IDs, counts, aggregate confidence, safe codes, and diagnostic IDs only | Token, absolute path, OCR full text, raw stack, or user bytes leak |
| Confirmation | Existing dialogs are renderer interactions | Short-lived confirmation artifact bound to action, policy snapshot, and request fingerprint | Reuse after expiry or privilege expansion |

## Protected Data

- User images, video, masks, OCR text, raw OCR engine output, source paths, tokens, model-license acceptance, and unpublished artifacts.
- Release credentials, signing keys, immutable object identities, and update channel pointers remain outside M0 allowed actions.

## Negative-Test Baseline

- Reject absolute and traversal asset paths.
- Reject unknown fields that could carry raw text, stack traces, or tokens.
- Reject missing idempotency/policy fingerprints on jobs and confirmations.
- Reject text regions without a four-point polygon.
- Reject handoffs or gates without an independent reviewer and rollback path.
