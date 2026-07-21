"""Exercise vendored SAM3 compatibility fallbacks without model weights."""

from __future__ import annotations

import argparse
import json
import os


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify SAM3 optional-Triton compatibility paths")
    parser.add_argument(
        "--expect-backend",
        choices=("triton", "compatibility-fallback"),
        default=None,
    )
    args = parser.parse_args()

    import torch
    from sam3 import _moonshine_compat
    from sam3.model.edt import edt_triton
    from sam3.perflib.connected_components import connected_components
    from sam3.perflib.nms import generic_nms
    from sam3.train.loss.sigmoid_focal_loss import (
        triton_sigmoid_focal_loss,
        triton_sigmoid_focal_loss_reduce,
    )

    capabilities = _moonshine_compat.runtime_capabilities()
    backend = capabilities["triton"]["backend"]
    if args.expect_backend:
        require(backend == args.expect_backend, f"Expected {args.expect_backend}, received {backend}")

    masks = torch.tensor(
        [
            [[False, True, True], [False, False, True], [True, True, True]],
            [[True, True, True], [True, True, True], [True, True, True]],
        ],
        dtype=torch.bool,
    )
    edt = edt_triton(masks)
    require(edt.shape == masks.shape, "EDT shape changed")
    require(edt.dtype == torch.float32, "EDT must return float32")
    require(float(edt[0, 0, 0]) == 0.0, "EDT background distance must be zero")
    require(float(edt[0, 0, 1]) > 0.0, "EDT foreground distance must be positive")
    require(float(edt[1].min()) >= 1e8, "EDT all-foreground behavior changed")

    ious = torch.tensor(
        [[1.0, 0.8, 0.2], [0.8, 1.0, 0.1], [0.2, 0.1, 1.0]], dtype=torch.float32
    )
    scores = torch.tensor([0.9, 0.8, 0.7], dtype=torch.float32)
    keep = generic_nms(ious, scores, 0.5)
    require(keep.tolist() == [0, 2], f"Unexpected NMS result: {keep.tolist()}")

    components_input = torch.tensor(
        [[[[1, 1, 0, 0], [0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]]]],
        dtype=torch.uint8,
    )
    labels, counts = connected_components(components_input)
    require(labels.shape == components_input.shape, "Connected-components labels shape changed")
    require(counts.shape == components_input.shape, "Connected-components counts shape changed")
    require(int(counts[0, 0, 0, 0]) == 3, "Connected-components first region size changed")
    require(int(counts[0, 0, 3, 3]) == 1, "Connected-components isolated region size changed")

    logits = torch.tensor([[-1.0, 0.5], [1.5, -0.5]], dtype=torch.float32, requires_grad=True)
    targets = torch.tensor([[0.0, 1.0], [1.0, 0.0]], dtype=torch.float32)
    loss = triton_sigmoid_focal_loss(logits, targets)
    reduced = triton_sigmoid_focal_loss_reduce(logits, targets)
    require(loss.shape == logits.shape, "Focal-loss shape changed")
    require(reduced.ndim == 0, "Reduced focal loss must be scalar")
    (loss.sum() + reduced).backward()
    require(logits.grad is not None and torch.isfinite(logits.grad).all(), "Focal-loss gradient is invalid")

    print(
        json.dumps(
            {
                "status": "pass",
                "backend": backend,
                "forceFallback": os.environ.get("MOONSHINE_SAM3_DISABLE_TRITON") == "1",
                "capabilities": capabilities,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
