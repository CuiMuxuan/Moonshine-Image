import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[1]
SERVER_ROOT = REPO_ROOT / "server"
REPORT_PATH = REPO_ROOT / "docs" / "video-temporal-persistence-simulation-report.md"

sys.path.insert(0, str(SERVER_ROOT))

from moonshine_server.video_temporal_enhancement import VideoTemporalEnhancer


def make_frame(index: int, width: int, height: int) -> np.ndarray:
    x = np.linspace(0, 255, width, dtype=np.uint8)
    y = np.linspace(0, 120, height, dtype=np.uint8)[:, None]
    red = np.tile(x, (height, 1))
    green = np.tile(y, (1, width))
    blue = np.full((height, width), 96 + (index % 5) * 2, dtype=np.uint8)
    frame = np.stack([red, green, blue], axis=2)
    cv2.putText(
        frame,
        f"F{index:03d}",
        (12, 28),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.55,
        (255, 255, 255),
        1,
        cv2.LINE_AA,
    )
    return frame


def make_mask(index: int, width: int, height: int) -> np.ndarray:
    mask = np.zeros((height, width), dtype=np.uint8)
    x0 = 54 + min(index, 40) // 10
    y0 = 30
    cv2.rectangle(mask, (x0, y0), (x0 + 34, y0 + 18), 255, -1)
    return mask


def make_independent_result(frame_rgb: np.ndarray, mask: np.ndarray, index: int) -> np.ndarray:
    bgr = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR)
    result = bgr.copy()
    masked = mask > 127
    color = np.array(
        [130 + (index % 3) * 6, 95 + (index % 4) * 4, 170 + (index % 2) * 5],
        dtype=np.uint8,
    )
    result[masked] = color
    return cv2.GaussianBlur(result, (3, 3), 0)


def build_options(work_dir: Path, mode: str, width: int, height: int, fps: int) -> dict:
    options = {
        "enabled": True,
        "mode": "conservative",
        "stabilize_mask": True,
        "stabilize_result": True,
        "texture_cache": True,
        "diagnostics": True,
        "scene_change_threshold": 0.35,
        "mask_iou_threshold": 0.45,
        "center_shift_threshold": 0.08,
        "blend_strength": 0.25,
        "cache_ttl_frames": 12,
        "min_mask_area": 16,
        "diagnostics_path": str(work_dir / f"{mode}_diagnostics.jsonl"),
        "state_path": str(work_dir / "temporal_state.json"),
        "cache_dir": str(work_dir / "temporal_cache"),
        "config_signature": "simulation-config-v1",
        "source_fingerprint": "simulation-source-v1",
        "video_width": width,
        "video_height": height,
        "fps": fps,
    }
    if mode == "baseline":
        options.pop("state_path", None)
        options.pop("cache_dir", None)
    return options


def read_jsonl(path: Path) -> list:
    if not path.exists():
        return []
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def run_batch(
    *,
    mode: str,
    batch_id: str,
    frame_indexes: range,
    width: int,
    height: int,
    fps: int,
    work_dir: Path,
) -> dict:
    enhancer = VideoTemporalEnhancer(
        build_options(work_dir, mode, width, height, fps),
        batch_id=batch_id,
    )
    decisions = []
    start = time.perf_counter()

    for frame_index in frame_indexes:
        frame_rgb = make_frame(frame_index, width, height)
        mask = make_mask(frame_index, width, height)
        independent = make_independent_result(frame_rgb, mask, frame_index)
        output, decision = enhancer.enhance_frame(
            frame_index=frame_index,
            image_rgb=frame_rgb,
            mask=mask,
            independent_bgr=independent,
            output_path=str(work_dir / f"result_{frame_index:06d}.png"),
            temporal_objects=[
                {
                    "object_key": "mask:simulation-track",
                    "source": "mask",
                    "mask_id": "simulation-track",
                }
            ],
        )
        if output.shape != independent.shape:
            raise RuntimeError(f"Unexpected output shape for frame {frame_index}")
        decisions.append(decision)

    if hasattr(enhancer, "finalize_batch"):
        enhancer.finalize_batch()

    elapsed_ms = (time.perf_counter() - start) * 1000
    return {
        "batch_id": batch_id,
        "elapsed_ms": elapsed_ms,
        "decisions": decisions,
    }


def summarize(mode: str, work_dir: Path, batches: list, diagnostics: list) -> dict:
    decisions = [decision for batch in batches for decision in batch["decisions"]]
    skip_counts = {}
    for decision in decisions:
        reason = decision.get("skip_reason") or "applied"
        skip_counts[reason] = skip_counts.get(reason, 0) + 1

    state_path = work_dir / "temporal_state.json"
    cache_dir = work_dir / "temporal_cache"
    state_payload = {}
    if state_path.exists():
        state_payload = json.loads(state_path.read_text(encoding="utf-8"))
    refs_dir = cache_dir / "refs"
    objects_dir = cache_dir / "objects"
    return {
        "mode": mode,
        "work_dir": str(work_dir),
        "total_elapsed_ms": sum(batch["elapsed_ms"] for batch in batches),
        "batch_elapsed_ms": [round(batch["elapsed_ms"], 3) for batch in batches],
        "frame_count": len(decisions),
        "applied_count": sum(1 for item in decisions if item.get("applied")),
        "texture_cache_hits": sum(1 for item in decisions if item.get("texture_cache_hit")),
        "skip_counts": skip_counts,
        "batch2_first_reason": batches[1]["decisions"][0].get("skip_reason", ""),
        "batch2_first_state_restored": batches[1]["decisions"][0].get("state_restored", False),
        "batch2_first_object_key": batches[1]["decisions"][0].get("object_key", ""),
        "diagnostic_lines": len(diagnostics),
        "state_exists": state_path.exists(),
        "state_last_frame_index": state_payload.get("batch", {}).get("lastFrameIndex"),
        "cache_dir_exists": cache_dir.exists(),
        "refs_file_count": len(list(refs_dir.rglob("*"))) if refs_dir.exists() else 0,
        "object_cache_meta_count": len(list(objects_dir.glob("*/meta.json"))) if objects_dir.exists() else 0,
        "cache_file_count": len(list(cache_dir.rglob("*"))) if cache_dir.exists() else 0,
    }


def append_report(summary: dict) -> None:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    existing = REPORT_PATH.read_text(encoding="utf-8") if REPORT_PATH.exists() else ""
    header = "# 视频时序增强持久化模拟报告\n\n" if not existing else ""
    block = [
        f"## {time.strftime('%Y-%m-%d %H:%M:%S')} - {summary['mode']}",
        "",
        "```json",
        json.dumps(summary, ensure_ascii=False, indent=2),
        "```",
        "",
    ]
    REPORT_PATH.write_text(existing + header + "\n".join(block), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["baseline", "persistence"], required=True)
    parser.add_argument("--keep-work-dir", action="store_true")
    args = parser.parse_args()

    width = 160
    height = 90
    fps = 24
    work_dir = Path(tempfile.mkdtemp(prefix=f"moonshine-temporal-{args.mode}-"))
    try:
        batches = [
            run_batch(
                mode=args.mode,
                batch_id=f"{args.mode}-batch-1",
                frame_indexes=range(0, 24),
                width=width,
                height=height,
                fps=fps,
                work_dir=work_dir,
            ),
            run_batch(
                mode=args.mode,
                batch_id=f"{args.mode}-batch-2",
                frame_indexes=range(24, 48),
                width=width,
                height=height,
                fps=fps,
                work_dir=work_dir,
            ),
        ]
        diagnostics = read_jsonl(work_dir / f"{args.mode}_diagnostics.jsonl")
        summary = summarize(args.mode, work_dir, batches, diagnostics)
        append_report(summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    finally:
        if not args.keep_work_dir:
            shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
