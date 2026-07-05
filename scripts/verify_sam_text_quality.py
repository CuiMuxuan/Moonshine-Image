import argparse
import base64
import json
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw


REPO_ROOT = Path(__file__).resolve().parents[1]
SERVER_ROOT = REPO_ROOT / "server"
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))


def build_red_rectangle_image() -> str:
    image = Image.new("RGB", (192, 128), (245, 245, 245))
    draw = ImageDraw.Draw(image)
    draw.rectangle((48, 32, 144, 96), fill=(220, 32, 32))
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run repeatable SAM3/SAM3.1 text smart-selection quality smoke checks."
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
        help="Device to request. SAM3 text smoke currently expects CUDA.",
    )
    parser.add_argument(
        "--model-id",
        default="",
        choices=["", "sam3", "sam3_1_multiplex"],
        help="Optional SAM3/SAM3.1 model id to test. Defaults to the service text default model.",
    )
    parser.add_argument(
        "--include-image-prompts",
        action="store_true",
        help="Also run SAM3 image point and box prompt smoke on the synthetic image.",
    )
    args = parser.parse_args()

    try:
        import torch

        from moonshine_server.moonshine.sam_service import SamService, SamServiceError
    except Exception as error:
        print(
            json.dumps(
                {
                    "status": "skip",
                    "reason": f"sam runtime import failed: {error}",
                },
                ensure_ascii=False,
            )
        )
        return 0

    if args.device == "cuda" and not torch.cuda.is_available():
        print(
            json.dumps(
                {
                    "status": "skip",
                    "reason": "CUDA is not available; SAM3 text smoke requires CUDA bf16 autocast.",
                },
                ensure_ascii=False,
            )
        )
        return 0

    service = SamService(Path(args.model_dir), args.device)
    capabilities = service.capabilities()
    if not capabilities.get("text", {}).get("enabled"):
        print(
            json.dumps(
                {
                    "status": "skip",
                    "reason": capabilities.get("text", {}).get("reason")
                    or "SAM3 text capability is disabled.",
                    "warnings": capabilities.get("text", {}).get("warnings") or [],
                },
                ensure_ascii=False,
            )
        )
        return 0

    image = build_red_rectangle_image()
    model_id = args.model_id or capabilities.get("text", {}).get("defaultModelId") or "sam3_1_multiplex"
    cases = [
        {"name": "english_short_phrase", "text": "red rectangle", "language": "en"},
        {"name": "basic_chinese_lexicon", "text": "红色矩形", "language": "zh"},
        {"name": "unknown_absent_target", "text": "green bicycle", "language": "en"},
    ]
    results = []
    for case in cases:
        try:
            result = service.predict_text(
                image=image,
                image_type="base64",
                model_id=model_id,
                text=case["text"],
                language=case["language"],
            )
            results.append(
                {
                    **case,
                    "status": "ok",
                    "candidateCount": len(result.get("candidates") or []),
                    "diagnostics": result.get("diagnostics") or {},
                }
            )
        except SamServiceError as error:
            results.append({**case, "status": "error", "error": str(error)})

    image_prompt_results = []
    if args.include_image_prompts:
        image_prompt_cases = [
            {
                "name": "image_point_center",
                "points": [{"x": 96, "y": 64, "label": 1}],
                "box": None,
            },
            {
                "name": "image_box_inside",
                "points": [],
                "box": {"x": 48, "y": 32, "width": 96, "height": 64},
            },
        ]
        for case in image_prompt_cases:
            try:
                result = service.predict(
                    image=image,
                    image_type="base64",
                    model_id=model_id,
                    points=case["points"],
                    box=case["box"],
                    multimask_output=True,
                )
                image_prompt_results.append(
                    {
                        "name": case["name"],
                        "status": "ok",
                        "candidateCount": len(result.get("candidates") or []),
                        "performance": result.get("performance") or {},
                    }
                )
            except SamServiceError as error:
                image_prompt_results.append(
                    {"name": case["name"], "status": "error", "error": str(error)}
                )

    required_success = [
        item
        for item in results
        if item["name"] in {"english_short_phrase", "basic_chinese_lexicon"}
    ]
    image_prompts_passed = all(
        item.get("candidateCount", 0) > 0 for item in image_prompt_results
    )
    passed = all(item.get("candidateCount", 0) > 0 for item in required_success) and (
        not args.include_image_prompts or image_prompts_passed
    )
    print(
        json.dumps(
            {
                "status": "pass" if passed else "fail",
                "modelId": model_id,
                "results": results,
                "imagePromptResults": image_prompt_results,
                "capabilityWarnings": capabilities.get("text", {}).get("warnings") or [],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
