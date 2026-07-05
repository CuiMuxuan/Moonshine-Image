import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw


REPO_ROOT = Path(__file__).resolve().parents[1]
SERVER_ROOT = REPO_ROOT / "server"
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))


def build_frame_dir(root: Path, frame_count: int = 6) -> Path:
    frame_dir = root / "frames"
    frame_dir.mkdir(parents=True, exist_ok=True)
    for index in range(frame_count):
        image = Image.new("RGB", (192, 128), (245, 245, 245))
        draw = ImageDraw.Draw(image)
        offset = index * 2
        draw.rectangle((48 + offset, 32, 144 + offset, 96), fill=(220, 32, 32))
        image.save(frame_dir / f"{index:06d}.jpg", format="JPEG", quality=95)
    return frame_dir


def parse_box(value: str) -> dict:
    parts = [part.strip() for part in str(value or "").split(",")]
    if len(parts) != 4:
        raise ValueError("--video-box must use x,y,width,height")
    x, y, width, height = [float(part) for part in parts]
    if width <= 0 or height <= 0:
        raise ValueError("--video-box width and height must be positive")
    return {"x": x, "y": y, "width": width, "height": height}


def get_video_size(video_path: Path) -> tuple[int, int]:
    import cv2

    capture = cv2.VideoCapture(str(video_path))
    try:
        if not capture.isOpened():
            raise ValueError(f"Cannot open video: {video_path}")
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        if width <= 0 or height <= 0:
            raise ValueError(f"Cannot read video size: {video_path}")
        return width, height
    finally:
        capture.release()


def build_default_video_box(video_path: Path) -> dict:
    width, height = get_video_size(video_path)
    box_width = max(8, int(round(width * 0.4)))
    box_height = max(8, int(round(height * 0.55)))
    x = max(0, int(round((width - box_width) / 2)))
    y = max(0, int(round((height - box_height) / 2)))
    return {"x": x, "y": y, "width": box_width, "height": box_height}


def run_case(
    service,
    *,
    frame_dir: Path | None = None,
    video_path: Path | None = None,
    input_type: str = "jpegFrameDirectory",
    mask_root: Path,
    model_id: str,
    case: dict,
) -> dict:
    output_dir = mask_root / case["name"]
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        result = service.propagate_video(
            frame_dir=str(frame_dir) if frame_dir is not None else None,
            video_path=str(video_path) if video_path is not None else None,
            input_type=input_type,
            model_id=model_id,
            frame_index=0,
            object_id=1,
            points=[],
            box=case.get("box"),
            objects=None,
            text=case.get("text"),
            language=case.get("language", "en"),
            prompt_source=case.get("promptSource", "manual"),
            prompt_color=None,
            prompt_noun=None,
            max_frames=case.get("maxFrames", 3),
            reverse=False,
            offload_video_to_cpu=False,
            offload_state_to_cpu=False,
            response_type="path",
            mask_output_dir=str(output_dir),
            progress_callback=None,
        )
        return {
            "name": case["name"],
            "status": "ok",
            "objectCount": int(result.get("objectCount") or 0),
            "frameCount": len(result.get("frames") or []),
            "diagnostics": result.get("diagnostics") or {},
            "performance": result.get("performance") or {},
        }
    except Exception as error:
        return {"name": case["name"], "status": "error", "error": str(error)}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run repeatable SAM3/SAM3.1 video text and box propagation smoke checks."
    )
    parser.add_argument(
        "--model-dir",
        default=str(Path.cwd() / "models"),
        help="Moonshine model directory containing models/sam3 checkpoints.",
    )
    parser.add_argument(
        "--device",
        default="cuda",
        choices=["cuda", "cpu"],
        help="Device to request. SAM3 video smoke requires CUDA.",
    )
    parser.add_argument(
        "--model-id",
        default="sam3_1_multiplex",
        choices=["sam3", "sam3_1_multiplex"],
        help="SAM3/SAM3.1 video model id to test.",
    )
    parser.add_argument(
        "--video-path",
        default="",
        help="Optional real local video path. When set, also smoke-test videoPath input staging.",
    )
    parser.add_argument(
        "--video-box",
        default="",
        help="Optional real-video box as x,y,width,height. Defaults to a centered box.",
    )
    parser.add_argument(
        "--video-text",
        default="",
        help="Optional real-video text prompt. When omitted, only the real-video box case runs.",
    )
    parser.add_argument(
        "--video-max-frames",
        type=int,
        default=3,
        help="Maximum real-video frames to propagate after the prompt frame.",
    )
    args = parser.parse_args()

    try:
        import torch

        from moonshine_server.moonshine.sam_service import SamService
    except Exception as error:
        print(json.dumps({"status": "skip", "reason": f"sam runtime import failed: {error}"}, ensure_ascii=False))
        return 0

    if args.device != "cuda" or not torch.cuda.is_available():
        print(
            json.dumps(
                {
                    "status": "skip",
                    "reason": "SAM3 video smoke requires CUDA and torch.cuda.is_available().",
                },
                ensure_ascii=False,
            )
        )
        return 0

    temp_root = Path(tempfile.mkdtemp(prefix="moonshine_sam3_video_smoke_"))
    try:
        frame_dir = build_frame_dir(temp_root)
        mask_root = temp_root / "masks"
        service = SamService(Path(args.model_dir), args.device)
        cases = [
            {
                "name": "video_text_red_rectangle",
                "text": "red rectangle",
                "language": "en",
            },
            {
                "name": "video_box_red_rectangle",
                "box": {"x": 48, "y": 32, "width": 96, "height": 64},
            },
            {
                "name": "video_text_absent_target",
                "text": "green bicycle",
                "language": "en",
            },
        ]
        results = [
            run_case(
                service,
                frame_dir=frame_dir,
                input_type="jpegFrameDirectory",
                mask_root=mask_root,
                model_id=args.model_id,
                case=case,
            )
            for case in cases
        ]
        required_positive = [item for item in results if item["name"] != "video_text_absent_target"]
        absent = next((item for item in results if item["name"] == "video_text_absent_target"), None)
        passed = all(
            item.get("status") == "ok"
            and item.get("objectCount", 0) > 0
            and item.get("frameCount", 0) > 0
            for item in required_positive
        ) and absent is not None and absent.get("status") == "ok" and absent.get("objectCount", 0) == 0
        real_video_path = Path(args.video_path).expanduser() if args.video_path else None
        if real_video_path is not None:
            real_results = []
            real_mask_root = mask_root / "real_video"
            video_box = parse_box(args.video_box) if args.video_box else build_default_video_box(real_video_path)
            real_cases = [
                {
                    "name": "real_video_box",
                    "box": video_box,
                    "maxFrames": max(1, int(args.video_max_frames or 1)),
                }
            ]
            if args.video_text.strip():
                real_cases.append(
                    {
                        "name": "real_video_text",
                        "text": args.video_text.strip(),
                        "language": "en",
                        "maxFrames": max(1, int(args.video_max_frames or 1)),
                    }
                )
            for case in real_cases:
                real_results.append(
                    run_case(
                        service,
                        video_path=real_video_path,
                        input_type="videoPath",
                        mask_root=real_mask_root,
                        model_id=args.model_id,
                        case=case,
                    )
                )
            real_passed = all(
                item.get("status") == "ok"
                and item.get("objectCount", 0) > 0
                and item.get("frameCount", 0) > 0
                for item in real_results
            )
            results.extend(real_results)
            passed = passed and real_passed
        print(
            json.dumps(
                {
                    "status": "pass" if passed else "fail",
                    "modelId": args.model_id,
                    "results": results,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0 if passed else 1
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
