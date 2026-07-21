# Vendored SAM3 Source

This directory contains the controlled SAM3 source snapshot used to build the
Moonshine CUDA runtime wheel.

- Upstream repository: `https://github.com/facebookresearch/sam3`
- Upstream commit: `8e451d5`
- Source snapshot date: 2026-07-21
- License: `LICENSE` in this directory (SAM License, last updated 2025-11-19)

Moonshine builds this source as a non-editable wheel and installs that wheel
inside the packaged Conda runtime. It does not add this directory to the
released application's `PYTHONPATH`.

## Local Compatibility Changes

- `sam3/_moonshine_compat.py` provides optional Triton capability detection.
- `sam3/model/edt.py` falls back to SciPy EDT when Triton is unavailable.
- `sam3/perflib/nms.py` and `sam3/perflib/connected_components.py` fall back
  to their CPU implementations when native CUDA extensions and Triton are
  unavailable.
- `sam3/train/loss/sigmoid_focal_loss.py` retains a PyTorch fallback for
  environments without Triton.

Keep these changes small and replay them when updating the upstream snapshot.
