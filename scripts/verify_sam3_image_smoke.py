"""Run CUDA SAM3 point, box, and text selection smoke checks through Moonshine."""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw


def create_fixture(root: Path) -> Path:
    image_path = root / "sam3-image-smoke.png"
    image = Image.new("RGB", (192, 128), (238, 242, 246))
    draw = ImageDraw.Draw(image)
    draw.rectangle((48, 32, 143, 95), fill=(215, 48, 39))
    image.save(image_path)
    return image_path


def candidate_count(result: dict) -> int:
    return len(result.get("candidates") or [])


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run repeatable SAM3 image point, box, and text smoke checks."
    )
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--device", default="cuda", choices=("cuda", "cpu"))
    parser.add_argument("--image-model-id", default="sam3")
    parser.add_argument("--text-model-id", default="sam3_1_multiplex")
    args = parser.parse_args()

    result: dict = {
        "status": "fail",
        "imageModelId": args.image_model_id,
        "textModelId": args.text_model_id,
    }
    temp_root = Path(tempfile.mkdtemp(prefix="moonshine_sam3_image_smoke_"))
    service = None
    try:
        import torch

        from moonshine_server.moonshine.sam_service import SamService

        if args.device != "cuda" or not torch.cuda.is_available():
            raise RuntimeError("SAM3 image smoke requires CUDA and torch.cuda.is_available().")

        model_dir = Path(args.model_dir).resolve()
        image_path = create_fixture(temp_root)
        service = SamService(model_dir, args.device)

        point = service.predict(
            image=str(image_path),
            image_type="path",
            model_id=args.image_model_id,
            points=[{"x": 96, "y": 64, "label": 1}],
            box=None,
            multimask_output=False,
        )
        box = service.predict(
            image=str(image_path),
            image_type="path",
            model_id=args.image_model_id,
            points=[],
            box={"x": 48, "y": 32, "width": 96, "height": 64},
            multimask_output=False,
        )
        if candidate_count(point) <= 0 or candidate_count(box) <= 0:
            raise RuntimeError("SAM3 image point or box smoke did not return a candidate mask.")

        # Release the image predictor before loading the text predictor on the same GPU.
        service.release()
        text = service.predict_text(
            image=str(image_path),
            image_type="path",
            model_id=args.text_model_id,
            text="red rectangle",
            language="en",
            prompt_source="release-runtime-smoke",
        )
        if candidate_count(text) <= 0:
            raise RuntimeError("SAM3 text smoke did not return a candidate mask.")

        result.update(
            {
                "status": "pass",
                "pointCandidateCount": candidate_count(point),
                "boxCandidateCount": candidate_count(box),
                "textCandidateCount": candidate_count(text),
            }
        )
    except Exception as error:
        result["error"] = str(error)
    finally:
        if service is not None:
            service.release()
        shutil.rmtree(temp_root, ignore_errors=True)

    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
