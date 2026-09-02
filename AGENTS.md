# Moonshine-Image Agent Instructions

## Scope and Routing

- Read `PROJECT_CONTEXT.md` for stable product and architecture context when a task touches a related area.
- Read `PROJECT_BASELINE.md` when changing product capabilities, model boundaries, runtime/environment behavior, MCP security, release claims, acceptance status, or README installation/release instructions.
- Only read `.codex/skills/moonshine-image-windows-packaging/SKILL.md` for tasks that explicitly involve Windows packaging, installer/portable artifacts, versioned releases, signing, R2, updater channels, artifact audits, or offline bundles. Do not load it for ordinary UI, backend, model, or MCP feature work.
- Project-local Codex skills must remain under the Git-ignored `.codex/skills/` directory and must never be staged or committed.

## Repository Boundaries

- Keep `scripts/packaging-layout.mjs` as the machine-readable source of truth for Windows artifact paths and names. Do not hardcode packaging directory names in build, audit, or release scripts.
- Keep `src-electron/updater/edition.js` as the source of truth for official/test product identity and release channel.
- `win-unpacked` is only the electron-builder installer intermediate directory. It is not the portable distribution directory.
- Packaged runtime code must resolve the backend from the current `process.resourcesPath/backend/server`; never persist a developer-machine `dist/electron/Packaged/...` path as a runtime invariant.
- Preserve Electron main/preload/renderer ownership and MCP fail-closed rules documented in `PROJECT_BASELINE.md`.
- Never overwrite user source media. Replacing stale generated files under `dist` during a rebuild is allowed.

## Authorization

- A build request does not authorize Git push, R2 upload, channel-pointer updates, or public release. Require explicit user authorization immediately before those mutations.
