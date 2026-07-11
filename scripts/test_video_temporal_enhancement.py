from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[1]
SERVER_ROOT = REPO_ROOT / "server"
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from moonshine_server.video_temporal_enhancement import VideoTemporalEnhancer


WIDTH = 32
HEIGHT = 24
FPS = 10.0


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def build_options(
    output_root: Path,
    *,
    resume_root: Path | None = None,
    resume_before_frame_index: int | None = None,
    cache_ttl_frames: int = 12,
) -> dict:
    options = {
        "enabled": True,
        "mode": "conservative",
        "stabilize_mask": False,
        "stabilize_result": False,
        "texture_cache": True,
        "diagnostics": False,
        "blend_strength": 0.5,
        "cache_ttl_frames": cache_ttl_frames,
        "min_mask_area": 4,
        "state_path": str(output_root / "state.json"),
        "cache_dir": str(output_root / "cache"),
        "config_signature": "temporal-test-v2",
        "source_fingerprint": "source-test-v2",
        "video_width": WIDTH,
        "video_height": HEIGHT,
        "fps": FPS,
    }
    if resume_root is not None:
        options["resume_state_path"] = str(resume_root / "state.json")
        options["resume_cache_dir"] = str(resume_root / "cache")
    if resume_before_frame_index is not None:
        options["resume_before_frame_index"] = resume_before_frame_index
    return options


def make_mask() -> np.ndarray:
    mask = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
    mask[6:18, 8:24] = 255
    return mask


def make_result(background: tuple[int, int, int], fill: tuple[int, int, int]) -> np.ndarray:
    result = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    result[:, :] = background
    result[6:18, 8:24] = fill
    return result


def test_texture_cache_compositing(work_root: Path) -> None:
    checkpoint_root = work_root / "texture"
    object_mask = make_mask()
    object_mask_path = checkpoint_root / "object-mask.png"
    object_mask_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(object_mask_path), object_mask)
    object_refs = [
        {
            "object_key": "mask:object-1",
            "source": "mask",
            "mask_id": "object-1",
            "mask_path": str(object_mask_path),
        }
    ]
    image_rgb = np.full((HEIGHT, WIDTH, 3), 96, dtype=np.uint8)
    first_result = make_result((12, 18, 24), (20, 40, 220))
    second_result = make_result((12, 18, 24), (220, 40, 20))
    enhancer = VideoTemporalEnhancer(build_options(checkpoint_root), batch_id="texture")

    _, first_decision = enhancer.enhance_frame(
        frame_index=0,
        image_rgb=image_rgb,
        mask=object_mask,
        independent_bgr=first_result,
        temporal_objects=object_refs,
    )
    assert_true(first_decision["skip_reason"] == "missing-reference", "first frame should seed cache")

    enhanced, second_decision = enhancer.enhance_frame(
        frame_index=1,
        image_rgb=image_rgb,
        mask=object_mask,
        independent_bgr=second_result,
        temporal_objects=object_refs,
    )
    outside_mask = object_mask == 0
    inside_mask = object_mask > 0
    assert_true(second_decision.get("texture_cache_hit") is True, "cache should affect second frame")
    assert_true(
        np.array_equal(enhanced[outside_mask], second_result[outside_mask]),
        "texture cache must not modify pixels outside the current mask",
    )
    assert_true(
        float(np.abs(enhanced[inside_mask].astype(np.int16) - second_result[inside_mask]).mean()) > 1,
        "texture cache should change pixels inside the current object mask",
    )

    objects_dir = checkpoint_root / "cache" / "objects"
    corrupt_dir = objects_dir / "00-corrupt"
    corrupt_dir.mkdir(parents=True, exist_ok=True)
    corrupt_meta = {
        "version": 1,
        "objectKey": "mask:corrupt",
        "lastReliableFrameIndex": "not-an-integer",
        "bounds": [8, 6, 24, 18],
        "areaRatio": 0.25,
        "center": [0.5, 0.5],
        "patchPath": "missing-patch.png",
        "maskPath": "missing-mask.png",
        "configSignature": "temporal-test-v2",
        "sourceFingerprint": "source-test-v2",
        "video": {"width": WIDTH, "height": HEIGHT, "fps": FPS},
    }
    (corrupt_dir / "meta.json").write_text(
        json.dumps(corrupt_meta), encoding="utf-8"
    )

    checkpoint = enhancer.finalize_batch()
    assert_true(checkpoint is not None, "texture cache should produce a checkpoint")
    valid_meta_path = next(
        path for path in objects_dir.glob("*/meta.json") if path.parent != corrupt_dir
    )
    valid_meta = json.loads(valid_meta_path.read_text(encoding="utf-8"))
    bad_geometry_dir = objects_dir / "01-bad-geometry"
    bad_geometry_dir.mkdir(parents=True, exist_ok=True)
    for path_key in ("patchPath", "maskPath"):
        shutil.copy2(
            valid_meta_path.parent / valid_meta[path_key],
            bad_geometry_dir / valid_meta[path_key],
        )
    bad_geometry_meta = {
        **valid_meta,
        "objectKey": "mask:bad-geometry",
        "safeKey": "bad-geometry",
        "bounds": [8, 6, 8, 18],
    }
    (bad_geometry_dir / "meta.json").write_text(
        json.dumps(bad_geometry_meta), encoding="utf-8"
    )

    resumed = VideoTemporalEnhancer(
        build_options(
            work_root / "texture-resume",
            resume_root=checkpoint_root,
            resume_before_frame_index=2,
        ),
        batch_id="texture-resume",
    )
    assert_true(
        "mask:object-1" in resumed.texture_cache,
        "a corrupt cache entry must not block later valid objects",
    )
    assert_true(
        "mask:corrupt" not in resumed.texture_cache,
        "corrupt cache metadata must be rejected",
    )
    assert_true(
        "mask:bad-geometry" not in resumed.texture_cache,
        "cache entries with invalid geometry must be rejected",
    )

    enhancer.texture_cache["mask:object-1"]["frame_index"] = 5
    future_result, future_decision = enhancer.enhance_frame(
        frame_index=2,
        image_rgb=image_rgb,
        mask=object_mask,
        independent_bgr=second_result,
        temporal_objects=object_refs,
    )
    assert_true(not future_decision.get("texture_cache_hit"), "future cache entry must be rejected")
    assert_true(np.array_equal(future_result, second_result), "future cache must not change output")

    enhancer.texture_cache["mask:object-1"]["frame_index"] = 0
    expired_result, expired_decision = enhancer.enhance_frame(
        frame_index=20,
        image_rgb=image_rgb,
        mask=object_mask,
        independent_bgr=second_result,
        temporal_objects=object_refs,
    )
    assert_true(not expired_decision.get("texture_cache_hit"), "expired cache entry must be rejected")
    assert_true(np.array_equal(expired_result, second_result), "expired cache must not change output")


def test_transactional_checkpoint_restore(work_root: Path) -> None:
    source_root = work_root / "committed"
    mask = make_mask()
    mask_path = source_root / "object-mask.png"
    mask_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(mask_path), mask)
    refs = [{"object_key": "mask:object-1", "mask_id": "object-1", "mask_path": str(mask_path)}]
    image_rgb = np.full((HEIGHT, WIDTH, 3), 96, dtype=np.uint8)
    result = make_result((10, 20, 30), (40, 80, 160))

    writer = VideoTemporalEnhancer(build_options(source_root), batch_id="committed")
    writer.enhance_frame(
        frame_index=20,
        image_rgb=image_rgb,
        mask=mask,
        independent_bgr=result,
        temporal_objects=refs,
    )
    checkpoint = writer.finalize_batch()
    assert_true(checkpoint is not None, "successful batch should return checkpoint summary")
    assert_true(checkpoint["last_frame_index"] == 20, "checkpoint frame index should be persisted")

    valid_output_root = work_root / "valid-output"
    valid_reader = VideoTemporalEnhancer(
        build_options(
            valid_output_root,
            resume_root=source_root,
            resume_before_frame_index=21,
        ),
        batch_id="valid-reader",
    )
    assert_true(valid_reader.state_restored, "checkpoint before current frame should restore")
    assert_true(bool(valid_reader.texture_cache), "valid object cache should restore")
    assert_true(
        valid_reader.options["state_path"] == str(valid_output_root / "state.json"),
        "new output state path must remain separate from resume state path",
    )

    future_output_root = work_root / "future-output"
    future_reader = VideoTemporalEnhancer(
        build_options(
            future_output_root,
            resume_root=source_root,
            resume_before_frame_index=20,
        ),
        batch_id="future-reader",
    )
    assert_true(not future_reader.state_restored, "future state must be rejected")
    assert_true(not future_reader.texture_cache, "future object cache must be rejected")


def main() -> None:
    work_root = Path(tempfile.mkdtemp(prefix="moonshine-temporal-tests-"))
    try:
        test_texture_cache_compositing(work_root)
        print("PASS  temporal texture cache composites inside current masks only")
        test_transactional_checkpoint_restore(work_root)
        print("PASS  temporal checkpoints reject future state and separate resume/output paths")
    finally:
        shutil.rmtree(work_root, ignore_errors=True)


if __name__ == "__main__":
    main()
