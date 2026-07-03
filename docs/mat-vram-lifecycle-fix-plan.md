# MAT VRAM Lifecycle Fix Plan

Last updated: 2026-07-04

## Goal

Fix the MAT GPU memory lifecycle issues found during CUDA smoke testing without changing the MAT product surface or touching unrelated SAM work.

## Confirmed Baseline

- MAT normal load and repeated 512x512 inference do not show active tensor growth.
- MAT to LaMa model switching releases the MAT instance and its CUDA tensors.
- Folder batch processing keeps PyTorch reserved CUDA cache after returning unless an extra `torch_gc()` runs.
- Some API exception paths do not guarantee `torch_gc()` when MAT inference fails.
- Video batch accepts `model_id=mat`, but the non-SLBR path relies on the current global `ModelManager`; if it was not switched to MAT first, the request can be logged as MAT while actually using the current loaded inpaint model.

## Fix Scope

1. Add an explicit `ModelManager.release()` method that clears the loaded model reference and runs `torch_gc()`.
2. Use `release()` in model switching so failed switch rollback does not reload the old model before clearing failed-load CUDA cache.
3. Ensure one-shot folder batch processing releases its temporary `ModelManager` before returning.
4. Move image and video inference cleanup into `finally` paths so success, normal failures, and disk-space failures all release temporary CUDA cache.
5. Make video batch requests for `lama` or `mat` switch the global inpaint model to `req.model_id` before frame processing.

## Non-Goals

- Do not change MAT model architecture, input/output protocol, or frontend model UI.
- Do not add cross-frame temporal consistency for MAT video processing.
- Do not modify SAM-related files unless a touched shared file already contains MAT code that must be adjusted.
- Do not commit model weights or upload scripts.

## Execution Checklist

- [x] Update `server/moonshine_server/model_manager.py`.
- [x] Update `server/moonshine_server/batch_processing.py`.
- [x] Update `server/moonshine_server/api.py`.
- [x] Compile touched backend files with `moonshine-runtime-312`.
- [x] Run targeted CUDA smoke for MAT load, repeated inference, release, folder batch release, and video `model_id=mat` model selection.
- [x] Run `git diff --check`.

## Expected Results

- MAT repeated inference remains stable after per-request cleanup.
- Deleting or releasing a MAT `ModelManager` drops reserved CUDA memory back near the process baseline after `torch_gc()`.
- Folder batch processing returns with the temporary MAT manager released.
- API exception paths run `torch_gc()` before returning or re-raising.
- Video batch `model_id=mat` actually uses MAT even if the previous global model was LaMa.

## Execution Log

- 2026-07-04: Plan created before code changes.
- 2026-07-04: Added `ModelManager.release()` and cleanup on lazy inference failure, model switch, switch rollback, and object teardown.
- 2026-07-04: Released the temporary folder-batch `ModelManager` before returning.
- 2026-07-04: Moved single-image and image-batch cleanup into `finally`; video-batch cleanup now runs on interval success and immediately on errors.
- 2026-07-04: Video batch now switches the shared inpaint model to `model_id=lama|mat` before processing.
- 2026-07-04: Verification passed:
  - `moonshine-runtime-312` compileall for `api.py`, `batch_processing.py`, and `model_manager.py`.
  - Real CUDA MAT smoke: repeated inference stable, `release()` returns reserved memory to near baseline, folder batch returns with reserved memory near baseline, video `model_id=mat` switches from LaMa to MAT and writes output.
  - `npm run test:regression:p0:assertions`.
  - `npm run test:regression:p1:image`.
  - `npm run test:regression:p1:video`.
  - `git diff --check` passed with CRLF warnings only.
