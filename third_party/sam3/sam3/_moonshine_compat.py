# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
#
# Moonshine compatibility additions are distributed under the SAM License in
# the vendored source root.

"""Optional Triton acceleration controls for the vendored SAM3 runtime."""

from __future__ import annotations

import os
from typing import Any


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


_force_fallback = _truthy(os.environ.get("MOONSHINE_SAM3_DISABLE_TRITON"))
_triton = None
_triton_language = None
_triton_import_error: str | None = None
_triton_runtime_error: str | None = None

if not _force_fallback:
    try:
        import triton as _triton_module
        import triton.language as _triton_language_module

        _triton = _triton_module
        _triton_language = _triton_language_module
    except Exception as error:
        _triton_import_error = str(error)


def triton_importable() -> bool:
    return _triton is not None and _triton_language is not None


def triton_enabled() -> bool:
    return triton_importable() and _triton_runtime_error is None


def get_triton_modules():
    if not triton_enabled():
        raise RuntimeError("Triton acceleration is unavailable")
    return _triton, _triton_language


def disable_triton(error: BaseException | str) -> None:
    global _triton_runtime_error
    _triton_runtime_error = str(error)


def runtime_capabilities() -> dict[str, Any]:
    reason = _triton_runtime_error
    if reason is None and _force_fallback:
        reason = "disabled by MOONSHINE_SAM3_DISABLE_TRITON"
    if reason is None:
        reason = _triton_import_error
    return {
        "triton": {
            "importable": triton_importable(),
            "enabled": triton_enabled(),
            "backend": "triton" if triton_enabled() else "compatibility-fallback",
            "reason": reason,
        },
        "fallbacks": {
            "edt": "scipy",
            "nms": "cpu",
            "connectedComponents": "cpu",
        },
    }
