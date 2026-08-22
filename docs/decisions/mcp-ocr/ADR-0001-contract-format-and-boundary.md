# ADR-0001: Contract Format And Boundary

- Status: accepted for M0 draft
- Date: 2026-08-16
- Owner: ARCH
- Reviewer: QA/RED pending

## Context

Moonshine-Image currently has Vue/Quasar UI contracts, Electron IPC handlers, in-memory task maps, and Python Pydantic DTOs. The 2.0 plan adds persistent jobs, artifacts, MCP, OCR, confirmation, and evidence flows. Implementing those flows before agreeing on stable data boundaries would multiply adapters and make failure recovery ambiguous.

## Decision

1. Use JSON Schema 2020-12 serialized as YAML for cross-language contracts.
2. Validate schemas and fixtures with a declared Ajv 8 development dependency.
3. Keep current v1 Pydantic DTOs and IPC payloads as observed legacy facts. Future adapters must map them explicitly; v2 fields are not injected into legacy DTOs by implication.
4. Use approved workspace-relative locators and artifact IDs instead of returning arbitrary absolute paths or bulk base64 payloads.
5. Keep governance contracts executable beside runtime contracts so task scope, unknowns, evidence, and gate decisions can be checked by the same test entry.

## Rejected Alternatives

- TypeScript-only interfaces: rejected because Python, Electron, MCP clients, fixtures, and release tooling also consume the boundary.
- Pydantic-only schemas: rejected because it would make the Python server the owner of MCP and Electron contracts that must remain application-level.
- Informal Markdown examples: rejected because negative fixtures and compatibility checks would not be executable.
- Silent reuse of current path/base64 DTOs: rejected because current DTOs permit payload shapes and trust assumptions that are not suitable for MCP or persistent artifacts.

## Consequences

- M1-M6 implementations must cite a schema ID and update fixtures when they change behavior.
- A breaking field change requires a new contract version and migration note.
- The initial M0 schema is a target boundary, not proof that its services or UI exist.
