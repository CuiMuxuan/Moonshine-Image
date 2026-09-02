# Moonshine-Image Project Context

This document contains stable context for ordinary development. Current version, release status, acceptance gates, and other changing facts belong in `PROJECT_BASELINE.md`.

## Product

Moonshine-Image is a Windows x64 Electron desktop application for local image and video processing. It supports text/icon/semitransparent watermark removal, mask editing, OCR smart selection, SAM segmentation, video timeline processing, and policy-controlled local MCP automation.

The primary user flow is composable rather than a fixed wizard:

```text
Import source -> create/combine mask -> run a model -> preview/edit -> export a new result
```

OCR, SAM, manual drawing, and erasing all operate on the same mask lifecycle. Image and video workflows share concepts but remain separate: video has a timeline, frame ranges, propagation, and export fallback behavior.

## Architecture

- Frontend: Vue 3, Quasar, and Vite. Main routes are `/image`, `/video`, and `/activity/mcp`; `/` redirects to `/image`.
- Desktop shell: Electron. The main process owns windows, tray, quit lifecycle, backend lifecycle, MCP secrets, and durable task state. Renderer code uses named preload IPC projections.
- Backend: Python/FastAPI under `server/moonshine_server`.
- Video: WebAV, `vue-timeline-editor`, Canvas playback/timeline, with FFmpeg fallback for export failures.
- OCR: RapidOCR adapter with separate detection, recognition, and classification ONNX assets plus ONNX Runtime.
- Segmentation: SAM1, SAM2.1, standard SAM3, and the separately constrained `sam3_1_multiplex` model.
- Inpainting/removal: LaMa, MAT, and SLBR. MAT is CUDA-only and has a non-commercial license constraint; SLBR targets visible semitransparent watermarks.

## Development Invariants

- Model capabilities come from metadata/capability matrices, not filename guesses.
- The backend path used by a packaged app is derived from the current `process.resourcesPath`; persisted developer-machine absolute paths are not portable runtime configuration.
- User source files are preserved. Processing writes new outputs and exposes controlled artifact descriptors.
- MCP operations validate tool allowlists, trusted-directory containment, schemas, job ownership, output paths, cancellation, and lifecycle state independently; unauthorized or failed operations fail closed.
- Keep changes aligned with existing Quasar components and project patterns. Add focused regression coverage for shared contracts and user-visible workflows.

## Where to Look

- Electron/runtime: `src-electron/electron-main.js`, `src-electron/runtime/*`, preload IPC, `src/components/global/BackendManager.vue`.
- Image/mask: `src/pages/IndexPage.vue`, `src/services/ImageProcessingService.js`, smart-selection toolbar/editor, backend API and model manager.
- Video: `src/pages/VideoPage.vue`, `src/services/VideoProcessingService.js`, Canvas/timeline code, backend video batch and temporal enhancement.
- Models: `server/moonshine_server/model_manager.py`, LaMa/MAT modules, `moonshine/slbr_runner.py`, SAM prediction service and metadata.
- MCP: `src-electron/mcp/*`, `mcp-stdio-server.mjs`, native broker, bridge, JobStore, activity, and cancellation providers.
- Packaging: `quasar.config.js`, `scripts/packaging-layout.mjs`, `scripts/prepare-electron-resources.mjs`, `scripts/build-electron-installer-local.mjs`, `scripts/package-win-matrix.mjs`, and `scripts/release/*`.
