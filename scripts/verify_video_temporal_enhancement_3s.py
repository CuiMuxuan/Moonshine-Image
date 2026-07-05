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
REPORT_PATH = REPO_ROOT / "docs" / "video-temporal-object-cache-3s-report.md"
DEFAULT_VIDEO_PATH = Path(r"C:\Users\cjh02\Downloads\生成看板娘呼吸动画视频 (5).mp4")

sys.path.insert(0, str(SERVER_ROOT))

from moonshine_server.video_temporal_enhancement import VideoTemporalEnhancer


def extract_video_frames(video_path: Path, duration_seconds: float, sample_fps: float, max_width: int) -> tuple:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    source_fps = float(capture.get(cv2.CAP_PROP_FPS) or 0) or sample_fps
    source_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    source_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    frames = []
    target_count = max(1, int(round(duration_seconds * sample_fps)))

    for index in range(target_count):
        timestamp_ms = (index / max(sample_fps, 0.001)) * 1000.0
        capture.set(cv2.CAP_PROP_POS_MSEC, timestamp_ms)
        ok, frame_bgr = capture.read()
        if not ok or frame_bgr is None:
            break
        if max_width > 0 and frame_bgr.shape[1] > max_width:
            scale = max_width / frame_bgr.shape[1]
            frame_bgr = cv2.resize(
                frame_bgr,
                (max_width, max(1, int(round(frame_bgr.shape[0] * scale)))),
                interpolation=cv2.INTER_AREA,
            )
        frames.append(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))

    capture.release()
    if not frames:
        raise RuntimeError("No frames extracted from video")

    return frames, {
        "source_fps": source_fps,
        "source_width": source_width,
        "source_height": source_height,
        "sample_fps": sample_fps,
        "duration_seconds": duration_seconds,
        "width": int(frames[0].shape[1]),
        "height": int(frames[0].shape[0]),
    }


def make_object_masks(frame_index: int, width: int, height: int) -> dict:
    left = np.zeros((height, width), dtype=np.uint8)
    right = np.zeros((height, width), dtype=np.uint8)
    drift = min(frame_index, 24) // 8

    left_x0 = max(0, int(width * 0.22) + drift)
    left_y0 = max(0, int(height * 0.24))
    left_x1 = min(width - 1, left_x0 + max(14, int(width * 0.14)))
    left_y1 = min(height - 1, left_y0 + max(12, int(height * 0.12)))

    right_x0 = max(0, int(width * 0.58) - drift)
    right_y0 = max(0, int(height * 0.58))
    right_x1 = min(width - 1, right_x0 + max(14, int(width * 0.13)))
    right_y1 = min(height - 1, right_y0 + max(12, int(height * 0.12)))

    cv2.rectangle(left, (left_x0, left_y0), (left_x1, left_y1), 255, -1)
    cv2.rectangle(right, (right_x0, right_y0), (right_x1, right_y1), 255, -1)
    combined = np.maximum(left, right)
    return {
        "mask:left-object": left,
        "mask:right-object": right,
        "combined": combined,
    }


def make_independent_result(frame_rgb: np.ndarray, masks: dict, frame_index: int) -> np.ndarray:
    result = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR)
    left = masks["mask:left-object"] > 127
    right = masks["mask:right-object"] > 127
    result[left] = np.array([80 + frame_index % 5, 118, 180], dtype=np.uint8)
    result[right] = np.array([165, 96 + frame_index % 7, 82], dtype=np.uint8)
    return cv2.GaussianBlur(result, (3, 3), 0)


def build_options(work_dir: Path, enabled: bool, video_info: dict, label: str) -> dict:
    return {
        "enabled": enabled,
        "mode": "conservative",
        "stabilize_mask": True,
        "stabilize_result": True,
        "texture_cache": True,
        "diagnostics": True,
        "diagnostics_path": str(work_dir / f"{label}_diagnostics.jsonl"),
        "state_path": str(work_dir / "temporal_state.json"),
        "cache_dir": str(work_dir / "temporal_cache"),
        "config_signature": f"{label}-config-v1",
        "source_fingerprint": f"{label}-source-v1",
        "video_width": video_info["width"],
        "video_height": video_info["height"],
        "fps": video_info["sample_fps"],
    }


def write_mask(path: Path, mask: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), mask):
        raise RuntimeError(f"Failed to write mask: {path}")


def run_task(frames: list, video_info: dict, work_dir: Path, enabled: bool, label: str) -> dict:
    outputs = {}
    decisions = []
    object_mask_paths_passed = 0
    batches = [
        range(0, max(1, len(frames) // 2)),
        range(max(1, len(frames) // 2), len(frames)),
    ]
    started = time.perf_counter()

    for batch_index, frame_range in enumerate(batches, start=1):
        enhancer = (
            VideoTemporalEnhancer(
                build_options(work_dir, enabled, video_info, label),
                batch_id=f"{label}-batch-{batch_index}",
            )
            if enabled
            else None
        )

        for frame_index in frame_range:
            frame_rgb = frames[frame_index]
            masks = make_object_masks(frame_index, video_info["width"], video_info["height"])
            independent = make_independent_result(frame_rgb, masks, frame_index)
            output_path = work_dir / label / f"result_{frame_index:06d}.png"
            output_path.parent.mkdir(parents=True, exist_ok=True)

            temporal_objects = []
            for object_key in ("mask:left-object", "mask:right-object"):
                object_mask_path = work_dir / label / "object_masks" / (
                    f"object_mask_{frame_index:06d}_{object_key.replace(':', '_')}.jpg"
                )
                write_mask(object_mask_path, masks[object_key])
                object_mask_paths_passed += 1
                temporal_objects.append(
                    {
                        "object_key": object_key,
                        "source": "mask",
                        "mask_id": object_key.split(":", 1)[1],
                        "mask_path": str(object_mask_path),
                    }
                )

            if enhancer is None:
                output = independent
                decision = {
                    "enabled": False,
                    "applied": False,
                    "fallback": True,
                    "skip_reason": "disabled",
                    "frame_index": frame_index,
                }
            else:
                output, decision = enhancer.enhance_frame(
                    frame_index=frame_index,
                    image_rgb=frame_rgb,
                    mask=masks["combined"],
                    independent_bgr=independent,
                    output_path=str(output_path),
                    temporal_objects=temporal_objects,
                )
            cv2.imwrite(str(output_path), output)
            outputs[frame_index] = output
            decisions.append(decision)

        if enhancer is not None:
            enhancer.finalize_batch()

    elapsed_ms = (time.perf_counter() - started) * 1000
    state_path = work_dir / "temporal_state.json"
    cache_dir = work_dir / "temporal_cache"
    object_meta_paths = list((cache_dir / "objects").glob("*/meta.json")) if cache_dir.exists() else []
    object_keys = []
    for meta_path in object_meta_paths:
        try:
            object_keys.append(json.loads(meta_path.read_text(encoding="utf-8")).get("objectKey", ""))
        except (OSError, json.JSONDecodeError):
            object_keys.append("")

    return {
        "enabled": enabled,
        "elapsed_ms": elapsed_ms,
        "outputs": outputs,
        "decisions": decisions,
        "object_mask_paths_passed": object_mask_paths_passed,
        "state_exists": state_path.exists(),
        "cache_dir_exists": cache_dir.exists(),
        "refs_file_count": len(list((cache_dir / "refs").rglob("*"))) if cache_dir.exists() else 0,
        "object_cache_meta_count": len(object_meta_paths),
        "object_cache_keys": sorted(key for key in object_keys if key),
        "cache_file_count": len(list(cache_dir.rglob("*"))) if cache_dir.exists() else 0,
    }


def compare_outputs(off_outputs: dict, on_outputs: dict) -> dict:
    common_indexes = sorted(set(off_outputs).intersection(on_outputs))
    if not common_indexes:
        return {"changed_frame_count": 0, "mean_abs_delta": 0.0, "max_abs_delta": 0.0}
    deltas = []
    changed = 0
    for frame_index in common_indexes:
        left = off_outputs[frame_index].astype(np.int16)
        right = on_outputs[frame_index].astype(np.int16)
        delta = np.abs(left - right)
        mean_delta = float(delta.mean())
        deltas.append(mean_delta)
        if mean_delta > 0.01:
            changed += 1
    return {
        "changed_frame_count": changed,
        "mean_abs_delta": float(np.mean(deltas)),
        "max_abs_delta": float(np.max(deltas)),
    }


def summarize_decisions(result: dict) -> dict:
    decisions = result["decisions"]
    skip_counts = {}
    for decision in decisions:
        reason = decision.get("skip_reason") or "applied"
        skip_counts[reason] = skip_counts.get(reason, 0) + 1
    second_half_index = max(1, len(decisions) // 2)
    batch2_first = decisions[second_half_index] if len(decisions) > second_half_index else {}
    return {
        "frame_count": len(decisions),
        "applied_count": sum(1 for item in decisions if item.get("applied")),
        "texture_cache_hits": sum(1 for item in decisions if item.get("texture_cache_hit")),
        "skip_counts": skip_counts,
        "batch2_first_reason": batch2_first.get("skip_reason", ""),
        "batch2_first_state_restored": batch2_first.get("state_restored", False),
        "batch2_first_object_key": batch2_first.get("object_key", ""),
    }


def append_report(summary: dict) -> None:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    existing = REPORT_PATH.read_text(encoding="utf-8") if REPORT_PATH.exists() else ""
    header = "# 视频时序增强 3 秒真实视频验证报告\n\n" if not existing else ""
    block = [
        f"## {time.strftime('%Y-%m-%d %H:%M:%S')} - {summary['label']}",
        "",
        "```json",
        json.dumps(summary, ensure_ascii=False, indent=2),
        "```",
        "",
    ]
    REPORT_PATH.write_text(existing + header + "\n".join(block), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", default=str(DEFAULT_VIDEO_PATH))
    parser.add_argument("--label", default="manual")
    parser.add_argument("--duration", type=float, default=3.0)
    parser.add_argument("--fps", type=float, default=12.0)
    parser.add_argument("--max-width", type=int, default=320)
    parser.add_argument("--keep-work-dir", action="store_true")
    args = parser.parse_args()

    video_path = Path(args.video)
    if not video_path.exists():
        raise FileNotFoundError(video_path)

    work_dir = Path(tempfile.mkdtemp(prefix=f"moonshine-temporal-3s-{args.label}-"))
    try:
        frames, video_info = extract_video_frames(
            video_path,
            duration_seconds=args.duration,
            sample_fps=args.fps,
            max_width=args.max_width,
        )
        off_result = run_task(frames, video_info, work_dir / "off", False, "off")
        on_result = run_task(frames, video_info, work_dir / "on", True, "on")
        output_delta = compare_outputs(off_result["outputs"], on_result["outputs"])
        summary = {
            "label": args.label,
            "video_path": str(video_path),
            "work_dir": str(work_dir),
            "video": {
                **video_info,
                "frame_count": len(frames),
            },
            "off": {
                "elapsed_ms": off_result["elapsed_ms"],
                **summarize_decisions(off_result),
                "state_exists": off_result["state_exists"],
                "cache_dir_exists": off_result["cache_dir_exists"],
                "object_mask_paths_passed": off_result["object_mask_paths_passed"],
            },
            "on": {
                "elapsed_ms": on_result["elapsed_ms"],
                **summarize_decisions(on_result),
                "state_exists": on_result["state_exists"],
                "cache_dir_exists": on_result["cache_dir_exists"],
                "refs_file_count": on_result["refs_file_count"],
                "object_cache_meta_count": on_result["object_cache_meta_count"],
                "object_cache_keys": on_result["object_cache_keys"],
                "cache_file_count": on_result["cache_file_count"],
                "object_mask_paths_passed": on_result["object_mask_paths_passed"],
            },
            "impact": {
                "enabled_minus_disabled_ms": on_result["elapsed_ms"] - off_result["elapsed_ms"],
                **output_delta,
            },
            "precise_object_cache_effective": (
                on_result["object_cache_meta_count"] >= 2
                and "mask:left-object" in on_result["object_cache_keys"]
                and "mask:right-object" in on_result["object_cache_keys"]
            ),
        }
        append_report(summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    finally:
        if not args.keep_work_dir:
            shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
