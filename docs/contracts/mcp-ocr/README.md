# MCP/OCR Contract Baseline

Status: `M0 draft`, executable locally, not a claim that 2.0 runtime features exist.

## Current Code Facts

- The renderer currently calls the existing image, video, SAM, runtime, and update paths.
- `src-electron/electron-main.js` keeps `activeProcessingTasks` and `activeFfmpegTasks` in memory. They are not a persistent `JobStore`.
- `server/moonshine_server/schema.py` exposes the current Pydantic request/response DTOs, including path/base64 image processing. It does not expose the v2 job, artifact, MCP, or OCR contracts in this directory.
- The current Electron main/preload IPC surface is not the planned MCP bridge. There is no implemented `TrayManager`, `WindowLifecycleController`, MCP adapter, OCR engine facade, or `/activity/mcp` route yet.

## Target Contract

The files in `schemas/` define the proposed v2 boundary shared by future application services, Electron IPC, MCP adapters, OCR engines, UI review flows, tests, and evidence tooling.

- `core-v2.schema.yaml`: `AssetRef`, `MaskRef`, `Job`, `JobEvent`, `Artifact`, `TextRegion`, OCR sidecar, safe error, and confirmation plan.
- `governance-v1.schema.yaml`: task declaration, handoff, unknown register, evidence manifest, gate record, and golden-set manifest.
- `templates/`: human-editable YAML examples validated by the contract test.
- `test/contracts/fixtures/`: positive and negative executable fixtures.

The schemas use JSON Schema 2020-12 expressed as YAML. Contract IDs and `schema_version` values are stable once M0 is accepted. Breaking changes require a new schema ID and an ADR; fields cannot silently change meaning.

## Boundary Rules

1. Asset references are path-oriented but never expose arbitrary absolute paths across MCP or renderer boundaries. Workspace assets use an approved `workspace_id` plus a traversal-free relative path; published results use an `artifact_id`.
2. User text, OCR full text, raw engine output, tokens, absolute paths, stack traces, and image/video bytes are not activity-log fields.
3. Jobs freeze request fingerprints, policy snapshots, engine/model revisions, and renderer requirements when queued.
4. Masks and OCR regions use original-image pixel coordinates. A rectangle alone is insufficient for rotated or perspective text.
5. Confirmation plans are separate short-lived artifacts. A renderer confirmation cannot grant a broader policy or outlive its TTL.
6. Current v1 DTOs remain supported until a later milestone implements an explicit adapter and migration. These M0 files do not alter current runtime behavior.

## Local Validation

```powershell
npm run test:contracts:mcp-ocr
```

The test compiles both schemas, accepts every positive fixture, rejects every negative fixture, validates the templates and M0 evidence files, checks unique unknown IDs, and verifies evidence-file SHA-256 values.

## Decision And Unknown Flow

- Facts describe observed code or test evidence.
- Decisions cite an ADR and state the rejected alternatives.
- Unknowns have exactly one owner, a quadrant, a timebox or review trigger, and a stop condition.
- `unknown_nonreversible` items stay `decision_required` until an authorized owner supplies evidence. They cannot be converted into implementation assumptions.
