from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import torch
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from moonshine_server.moonshine.slbr_runner import (  # noqa: E402
    SlbrRunner,
    build_folder_mask_lookup,
    build_output_collision_keys,
    build_output_stem_plan,
    compose_local_result,
    iter_folder_local_plans,
    local_composite_alpha,
    output_path_for,
    plan_local_tile_inference,
    resolve_folder_mask_match,
    summarize_processing_results,
)
from moonshine_server.mask_image import binary_mask_from_pil  # noqa: E402
from moonshine_server.schema import (  # noqa: E402
    MoonshineImageFolderInspectRequest,
    MoonshineImageFolderProcessRequest,
    MoonshineImageProcessItem,
    MoonshineImageProcessRequest,
    VideoBatchInpaintRequest,
)


class SlbrLocalProcessingTests(unittest.TestCase):
    def test_mask_decoder_uses_alpha_for_rgba_la_and_palette_transparency(self):
        rgba = np.full((8, 8, 4), 255, dtype=np.uint8)
        rgba[:, :, 3] = 0
        rgba[1:3, 2:4, 3] = 1

        la = np.full((8, 8, 2), 255, dtype=np.uint8)
        la[:, :, 1] = 0
        la[3:5, 4:6, 1] = 128

        palette = Image.new("P", (8, 8), color=0)
        palette.putpalette([0, 0, 0, 255, 255, 255] + [0] * (256 * 3 - 6))
        palette.info["transparency"] = 0
        for y in range(5, 7):
            for x in range(1, 3):
                palette.putpixel((x, y), 1)

        for image in (Image.fromarray(rgba, "RGBA"), Image.fromarray(la, "LA"), palette):
            decoded = binary_mask_from_pil(image)
            self.assertEqual(int(np.count_nonzero(decoded)), 4)
            self.assertEqual(set(np.unique(decoded)), {0, 255})

    def test_mask_decoder_uses_grayscale_threshold_without_transparency(self):
        grayscale = np.array([[0, 127, 128, 255]], dtype=np.uint8)

        decoded = binary_mask_from_pil(Image.fromarray(grayscale, "L"))

        self.assertEqual(decoded.tolist(), [[0, 0, 255, 255]])

    def test_small_dense_region_uses_canonical_tile_subset(self):
        mask = np.zeros((768, 768), dtype=np.uint8)
        mask[32:96, 32:96] = 255

        plan = plan_local_tile_inference(
            (768, 768, 3), mask, tile_size=256, strategy="smart_tiles"
        )

        self.assertEqual(plan["inference_strategy"], "smart_tiles")
        self.assertGreater(plan["full_tile_count"], plan["local_tile_count"])
        self.assertGreater(plan["tile_saving_ratio"], 0.15)

    def test_sparse_union_uses_full_in_auto_mode(self):
        mask = np.zeros((768, 768), dtype=np.uint8)
        mask[8, 8] = 255
        mask[760, 760] = 255

        plan = plan_local_tile_inference((768, 768, 3), mask, tile_size=256)

        self.assertEqual(plan["inference_strategy"], "full")
        self.assertEqual(plan["fallback_reason"], "bbox_empty_ratio_threshold")

    def test_composite_never_changes_pixels_outside_mask(self):
        original = np.arange(12 * 12 * 3, dtype=np.uint8).reshape(12, 12, 3)
        clean = np.full_like(original, 255)
        mask = np.zeros((12, 12), dtype=np.uint8)
        mask[2:5, 2:5] = 255
        mask[8:10, 8:10] = 255

        result = compose_local_result(original, clean, mask, edge_feather_px=0)

        self.assertTrue(np.array_equal(result[mask == 0], original[mask == 0]))
        self.assertTrue(np.array_equal(result[mask > 0], clean[mask > 0]))

    def test_edge_mask_keeps_full_alpha_at_image_border(self):
        mask = np.zeros((16, 16), dtype=np.uint8)
        mask[:, :4] = 255

        alpha = local_composite_alpha(mask, edge_feather_px=2)

        self.assertEqual(alpha[8, 0], 1.0)
        self.assertEqual(alpha[8, 4], 0.0)

    def test_local_runner_uses_selected_tiles_without_loading_weights(self):
        image = np.arange(512 * 512 * 3, dtype=np.uint8).reshape(512, 512, 3)
        mask = np.zeros((512, 512), dtype=np.uint8)
        mask[24:80, 24:80] = 255
        runner = SlbrRunner(ROOT, device="cpu")
        batch_sizes = []

        def forward(batch):
            batch_sizes.append(batch.shape[0])
            return batch, torch.zeros(batch.shape[0], 1, batch.shape[2], batch.shape[3])

        runner._forward = forward
        result, diagnostics = runner.infer_bgr_local(
            image,
            mask,
            tile_size=256,
            tile_batch=2,
            strategy="smart_tiles",
            edge_feather_px=0,
        )

        self.assertEqual(diagnostics["inference_strategy"], "smart_tiles")
        self.assertEqual(sum(batch_sizes), diagnostics["local_tile_count"])
        self.assertTrue(np.array_equal(result, image))

    def test_existing_full_request_remains_valid(self):
        request = MoonshineImageProcessRequest(
            model_id="slbr",
            data=[MoonshineImageProcessItem(id="image-1", image="payload")],
        )

        self.assertEqual(request.apply_scope, "full")
        self.assertEqual(request.data[0].apply_scope, None)

    def test_video_slbr_full_scope_remains_compatible_and_local_scope_requires_mask(self):
        full_request = VideoBatchInpaintRequest(
            model_id="slbr",
            frames=[
                {
                    "frame_index": 0,
                    "image_path": "frame.png",
                    "output_path": "result.png",
                }
            ],
        )

        self.assertEqual(full_request.frames[0].apply_scope, "full")
        with self.assertRaisesRegex(ValueError, "local SLBR video frames"):
            VideoBatchInpaintRequest(
                model_id="slbr",
                frames=[
                    {
                        "frame_index": 0,
                        "image_path": "frame.png",
                        "output_path": "result.png",
                        "apply_scope": "mask",
                    }
                ],
            )

    def test_video_slbr_local_scope_uses_image_local_options_and_preserves_outside_pixels(self):
        from moonshine_server.api import Api

        class FakeRunner:
            def __init__(self):
                self.full_calls = 0
                self.local_calls = []

            def infer_bgr(self, image_bgr, **_kwargs):
                self.full_calls += 1
                return image_bgr.copy(), np.zeros_like(image_bgr)

            def infer_bgr_local(self, image_bgr, mask, **kwargs):
                self.local_calls.append({"mask": mask.copy(), "kwargs": kwargs})
                result = image_bgr.copy()
                result[mask > 0] = np.array([0, 0, 255], dtype=np.uint8)
                return result, {"inference_strategy": "smart_tiles"}

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_path = root / "frame.png"
            mask_path = root / "mask.png"
            output_path = root / "result.png"
            source = np.full((8, 8, 3), 40, dtype=np.uint8)
            mask = np.zeros((8, 8), dtype=np.uint8)
            mask[2:5, 3:6] = 255
            Image.fromarray(source).save(image_path)
            Image.fromarray(mask).save(mask_path)

            runner = FakeRunner()
            api = Api.__new__(Api)
            api.config = SimpleNamespace(quality=95)
            api._release_sam_runtime_before_processing = lambda *_args, **_kwargs: None
            api._get_slbr_runner = lambda: runner
            api._normalize_moonshine_options = lambda _options: {
                "tile_size": 256,
                "tile_batch": 2,
                "local_inference_strategy": "smart_tiles",
                "local_bbox_empty_ratio_threshold": 50,
                "local_edge_feather_px": 2,
            }

            request = VideoBatchInpaintRequest(
                model_id="slbr",
                frames=[
                    {
                        "frame_index": 0,
                        "image_path": str(image_path),
                        "mask_path": str(mask_path),
                        "output_path": str(output_path),
                        "apply_scope": "mask",
                    }
                ],
            )
            response = api.api_video_batch_inpaint(request)
            payload = json.loads(response.body)

            self.assertEqual(payload["success_count"], 1)
            self.assertEqual(payload["results"][0]["apply_scope"], "mask")
            self.assertEqual(runner.full_calls, 0)
            self.assertEqual(len(runner.local_calls), 1)
            self.assertEqual(runner.local_calls[0]["kwargs"]["strategy"], "smart_tiles")
            self.assertEqual(runner.local_calls[0]["kwargs"]["bbox_empty_ratio_threshold"], 50)
            self.assertEqual(runner.local_calls[0]["kwargs"]["edge_feather_px"], 2)

            result = np.asarray(Image.open(output_path).convert("RGB"))
            self.assertTrue(np.array_equal(result[mask == 0], source[mask == 0]))
            self.assertTrue(np.all(result[mask > 0] == np.array([255, 0, 0], dtype=np.uint8)))

            full_output_path = root / "full-result.png"
            full_request = VideoBatchInpaintRequest(
                model_id="slbr",
                frames=[
                    {
                        "frame_index": 1,
                        "image_path": str(image_path),
                        "output_path": str(full_output_path),
                    }
                ],
            )
            full_response = api.api_video_batch_inpaint(full_request)
            full_payload = json.loads(full_response.body)
            self.assertEqual(full_payload["results"][0]["apply_scope"], "full")
            self.assertEqual(runner.full_calls, 1)

    def test_folder_inspect_request_keeps_optional_paths_compatible(self):
        request = MoonshineImageFolderInspectRequest(image_folder="images")

        self.assertEqual(request.missing_mask_behavior, "full")
        self.assertIsNone(request.output_folder)
        self.assertIsNone(request.mask_folder)

    def test_nested_duplicate_stems_resolve_by_relative_path_only(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            mask_dir = root / "masks"
            for relative_parent in (Path("a"), Path("b")):
                (image_dir / relative_parent).mkdir(parents=True)
                (mask_dir / relative_parent).mkdir(parents=True)
                Image.new("RGB", (8, 8)).save(image_dir / relative_parent / "same.png")
                Image.new("L", (8, 8), 255).save(mask_dir / relative_parent / "same.png")

            lookup = build_folder_mask_lookup(mask_dir)
            first_match = resolve_folder_mask_match(
                image_dir, image_dir / "a" / "same.png", lookup
            )
            second_match = resolve_folder_mask_match(
                image_dir, image_dir / "b" / "same.png", lookup
            )

            self.assertEqual(first_match, (mask_dir / "a" / "same.png", "relative_path"))
            self.assertEqual(second_match, (mask_dir / "b" / "same.png", "relative_path"))
            self.assertNotIn("same", lookup["stem"])

    def test_unique_stem_fallback_requires_a_unique_target_image_stem(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            mask_dir = root / "masks"
            output_dir = root / "output"
            mask_dir.mkdir()
            for relative_parent in (Path("a"), Path("b")):
                (image_dir / relative_parent).mkdir(parents=True)
                Image.new("RGB", (8, 8)).save(
                    image_dir / relative_parent / "same.jpg"
                )
            Image.new("L", (8, 8), 255).save(mask_dir / "same.png")

            plans = list(
                iter_folder_local_plans(
                    image_dir,
                    output_dir,
                    mask_folder=mask_dir,
                    missing_mask_behavior="skip",
                )
            )

            self.assertEqual(len(plans), 2)
            self.assertTrue(all(plan["mask_status"] == "missing" for plan in plans))
            self.assertTrue(all(plan["apply_scope"] == "skip" for plan in plans))

    def test_same_stem_mask_extensions_resolve_by_exact_relative_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            mask_dir = root / "masks"
            image_dir.mkdir()
            mask_dir.mkdir()
            for extension in (".jpg", ".png"):
                Image.new("RGB", (8, 8)).save(image_dir / f"same{extension}")
                Image.new("L", (8, 8), 255).save(mask_dir / f"same{extension}")

            lookup = build_folder_mask_lookup(mask_dir)
            jpg_match = resolve_folder_mask_match(
                image_dir, image_dir / "same.jpg", lookup
            )
            png_match = resolve_folder_mask_match(
                image_dir, image_dir / "same.png", lookup
            )

            self.assertEqual(jpg_match, (mask_dir / "same.jpg", "relative_path"))
            self.assertEqual(png_match, (mask_dir / "same.png", "relative_path"))
            self.assertNotIn("same", lookup["relative"])

    def test_same_directory_same_stem_outputs_include_source_extension(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            output_dir = root / "output"
            image_dir.mkdir()
            first = image_dir / "same.jpg"
            second = image_dir / "same.png"
            Image.new("RGB", (8, 8)).save(first)
            Image.new("RGB", (8, 8)).save(second)
            collision_keys = build_output_collision_keys(image_dir, [first, second])

            first_output = output_path_for(
                image_dir, first, output_dir, ".png", collision_keys=collision_keys
            )
            second_output = output_path_for(
                image_dir, second, output_dir, ".png", collision_keys=collision_keys
            )

            self.assertEqual(first_output.name, "same_jpg_clean.png")
            self.assertEqual(second_output.name, "same_png_clean.png")

    def test_output_stem_plan_closes_derived_name_collisions(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            output_dir = root / "output"
            image_dir.mkdir()
            images = [
                image_dir / "same.jpg",
                image_dir / "same.png",
                image_dir / "same_jpg.webp",
            ]
            for image_path in images:
                Image.new("RGB", (8, 8)).save(image_path)

            stem_plan = build_output_stem_plan(image_dir, images)
            output_paths = [
                output_path_for(
                    image_dir,
                    image_path,
                    output_dir,
                    ".png",
                    output_stem=stem_plan[image_path.resolve()],
                )
                for image_path in images
            ]

            self.assertEqual(len({path.name.casefold() for path in output_paths}), 3)
            self.assertEqual(output_paths[2].name, "same_jpg_clean.png")
            self.assertEqual(output_paths[0].name, "same_jpg_jpg_clean.png")

    def test_folder_processing_does_not_overwrite_same_stem_png_outputs(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            mask_dir = root / "masks"
            output_dir = root / "output"
            image_dir.mkdir()
            mask_dir.mkdir()
            image = np.full((16, 16, 3), 80, dtype=np.uint8)
            mask = np.full((16, 16), 255, dtype=np.uint8)
            Image.fromarray(image).save(image_dir / "same.jpg")
            Image.fromarray(image).save(image_dir / "same.png")
            Image.fromarray(image).save(image_dir / "same_jpg.webp")
            Image.fromarray(mask).save(mask_dir / "same.jpg")
            Image.fromarray(mask).save(mask_dir / "same.png")
            Image.fromarray(mask).save(mask_dir / "same_jpg.webp")
            runner = SlbrRunner(ROOT, device="cpu")
            runner.infer_bgr_local = lambda image_bgr, local_mask, **kwargs: (
                image_bgr.copy(),
                {
                    "inference_strategy": "full",
                    "fallback_reason": "",
                    "bbox_empty_ratio": 0.0,
                    "effective_mask_coverage": 1.0,
                    "full_tile_count": 1,
                    "local_tile_count": 1,
                    "tile_saving_ratio": 0.0,
                },
            )

            results = runner.process_folder(
                image_dir,
                output_dir,
                apply_scope="mask",
                mask_folder=mask_dir,
            )
            output_paths = {Path(result["output_path"]) for result in results}

            self.assertEqual(len(output_paths), 3)
            self.assertEqual(
                {path.name for path in output_paths},
                {
                    "same_jpg_jpg_clean.png",
                    "same_png_clean.png",
                    "same_jpg_clean.png",
                },
            )
            self.assertTrue(all(path.is_file() for path in output_paths))

    def test_full_auto_folder_outputs_keep_existing_names_when_extensions_differ(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            output_dir = root / "output"
            image_dir.mkdir()
            image = np.full((16, 16, 3), 80, dtype=np.uint8)
            Image.fromarray(image).save(image_dir / "same.jpg")
            Image.fromarray(image).save(image_dir / "same.png")
            runner = SlbrRunner(ROOT, device="cpu")
            runner.infer_bgr = lambda image_bgr, **kwargs: (
                image_bgr.copy(),
                np.zeros_like(image_bgr),
            )

            results = runner.process_folder(
                image_dir,
                output_dir,
                apply_scope="full",
                output_format="auto",
            )

            self.assertEqual(
                {Path(result["output_path"]).name for result in results},
                {"same_clean.jpg", "same_clean.png"},
            )

    def test_empty_current_mask_template_is_rejected_before_inference(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            output_dir = root / "output"
            image_dir.mkdir()
            Image.new("RGB", (8, 8)).save(image_dir / "image.png")
            template = root / "template.png"
            Image.new("L", (8, 8), 0).save(template)
            runner = SlbrRunner(ROOT, device="cpu")
            runner.infer_bgr = lambda *args, **kwargs: self.fail(
                "inference must not run for an empty current-mask template"
            )

            with self.assertRaisesRegex(ValueError, "template is empty"):
                runner.process_folder(
                    image_dir,
                    output_dir,
                    apply_scope="mask",
                    template_mask_path=template,
                    missing_mask_behavior="current_mask",
                )

    def test_current_mask_empty_after_resize_is_an_item_error_not_full_fallback(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            output_dir = root / "output"
            image_dir.mkdir()
            Image.new("RGB", (1, 1)).save(image_dir / "tiny.png")
            template_array = np.zeros((8, 8), dtype=np.uint8)
            template_array[0, 0] = 255
            template = root / "template.png"
            Image.fromarray(template_array).save(template)

            plans = list(
                iter_folder_local_plans(
                    image_dir,
                    output_dir,
                    template_mask_path=template,
                    missing_mask_behavior="current_mask",
                )
            )
            runner = SlbrRunner(ROOT, device="cpu")
            runner.infer_bgr = lambda *args, **kwargs: self.fail(
                "full inference must not run for an unusable current-mask template"
            )
            runner.infer_bgr_local = lambda *args, **kwargs: self.fail(
                "local inference must not run for an unusable current-mask template"
            )
            results = runner.process_folder(
                image_dir,
                output_dir,
                apply_scope="mask",
                template_mask_path=template,
                missing_mask_behavior="current_mask",
            )

            self.assertEqual(plans[0]["apply_scope"], "error")
            self.assertIn("empty after resizing", plans[0]["error"])
            self.assertFalse(results[0]["success"])
            self.assertEqual(results[0]["apply_scope"], "error")

    def test_all_skipped_folder_does_not_load_or_run_the_model(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            output_dir = root / "output"
            image_dir.mkdir()
            Image.new("RGB", (8, 8)).save(image_dir / "missing.png")
            runner = SlbrRunner(ROOT, device="cpu")
            runner._load_model = lambda: self.fail(
                "model weights must not load when every item is skipped"
            )
            runner.infer_bgr = lambda *args, **kwargs: self.fail(
                "full inference must not run when every item is skipped"
            )
            runner.infer_bgr_local = lambda *args, **kwargs: self.fail(
                "local inference must not run when every item is skipped"
            )

            results = runner.process_folder(
                image_dir,
                output_dir,
                apply_scope="mask",
                missing_mask_behavior="skip",
            )

            self.assertEqual(len(results), 1)
            self.assertTrue(results[0]["skipped"])
            self.assertFalse(results[0]["success"])

    def test_folder_inspection_and_execution_share_streamed_local_plan(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            mask_dir = root / "masks"
            output_dir = root / "output"
            image_dir.mkdir()
            mask_dir.mkdir()
            Image.new("RGB", (8, 8)).save(image_dir / "masked.png")
            Image.new("RGB", (8, 8)).save(image_dir / "missing.png")
            mask = Image.new("LA", (8, 8), (255, 0))
            mask.putpixel((3, 4), (255, 1))
            mask.save(mask_dir / "masked.png")

            plans = list(
                iter_folder_local_plans(
                    image_dir,
                    output_dir,
                    mask_folder=mask_dir,
                    missing_mask_behavior="skip",
                    include_mask=False,
                )
            )
            by_name = {Path(plan["image_path"]).name: plan for plan in plans}

            self.assertEqual(by_name["masked.png"]["mask_status"], "valid")
            self.assertEqual(by_name["masked.png"]["apply_scope"], "mask")
            self.assertNotIn("effective_mask", by_name["masked.png"])
            self.assertEqual(by_name["missing.png"]["mask_status"], "missing")
            self.assertEqual(by_name["missing.png"]["apply_scope"], "skip")

    def test_current_mask_fallback_preserves_original_mask_status_and_reason(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            mask_dir = root / "masks"
            output_dir = root / "output"
            image_dir.mkdir()
            mask_dir.mkdir()
            Image.new("RGB", (8, 8)).save(image_dir / "missing.png")
            Image.new("RGB", (8, 8)).save(image_dir / "empty.png")
            Image.new("L", (8, 8), 0).save(mask_dir / "empty.png")
            template = root / "template.png"
            Image.new("L", (8, 8), 255).save(template)

            plans = list(
                iter_folder_local_plans(
                    image_dir,
                    output_dir,
                    mask_folder=mask_dir,
                    template_mask_path=template,
                    missing_mask_behavior="current_mask",
                )
            )
            by_name = {Path(plan["image_path"]).name: plan for plan in plans}

            self.assertEqual(by_name["missing.png"]["mask_status"], "missing")
            self.assertEqual(by_name["missing.png"]["missing_reason"], "missing_mask")
            self.assertEqual(by_name["empty.png"]["mask_status"], "empty")
            self.assertEqual(by_name["empty.png"]["missing_reason"], "empty_mask")
            self.assertTrue(
                all(plan["mask_source"] == "current_mask" for plan in plans)
            )
            self.assertTrue(all(plan["apply_scope"] == "mask" for plan in plans))

    def test_folder_inspection_api_returns_counts_without_loading_model(self):
        from moonshine_server.api import Api

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            mask_dir = root / "masks"
            output_dir = root / "output"
            image_dir.mkdir()
            mask_dir.mkdir()
            Image.new("RGB", (8, 8)).save(image_dir / "masked.png")
            Image.new("RGB", (8, 8)).save(image_dir / "missing.png")
            Image.new("L", (8, 8), 255).save(mask_dir / "masked.png")
            request = MoonshineImageFolderInspectRequest(
                image_folder=str(image_dir),
                output_folder=str(output_dir),
                mask_folder=str(mask_dir),
                missing_mask_behavior="full",
            )
            api = Api.__new__(Api)
            api._get_moonshine_runner = lambda *args, **kwargs: self.fail(
                "folder inspection must not load a model runner"
            )

            response = api.api_moonshine_image_inspect_folder_masks(request)
            payload = json.loads(response.body)

            self.assertEqual(response.status_code, 200)
            self.assertTrue(payload["success"])
            self.assertEqual(payload["status"], "completed")
            self.assertEqual(payload["total_count"], 2)
            self.assertEqual(payload["mask_count"], 1)
            self.assertEqual(payload["full_count"], 1)
            self.assertNotIn("effective_mask", payload["results"][0])
            self.assertNotIn("output_collision", payload["results"][0])
            self.assertNotIn("output_stem", payload["results"][0])

    def test_folder_inspection_counts_original_status_with_current_mask_fallback(self):
        from moonshine_server.api import Api

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            mask_dir = root / "masks"
            output_dir = root / "output"
            image_dir.mkdir()
            mask_dir.mkdir()
            Image.new("RGB", (8, 8)).save(image_dir / "missing.png")
            Image.new("RGB", (8, 8)).save(image_dir / "empty.png")
            Image.new("L", (8, 8), 0).save(mask_dir / "empty.png")
            template = root / "template.png"
            Image.new("L", (8, 8), 255).save(template)
            request = MoonshineImageFolderInspectRequest(
                image_folder=str(image_dir),
                output_folder=str(output_dir),
                mask_folder=str(mask_dir),
                template_mask_path=str(template),
                missing_mask_behavior="current_mask",
            )
            api = Api.__new__(Api)

            response = api.api_moonshine_image_inspect_folder_masks(request)
            payload = json.loads(response.body)

            self.assertEqual(response.status_code, 200)
            self.assertEqual(payload["mask_count"], 2)
            self.assertEqual(payload["missing_count"], 1)
            self.assertEqual(payload["empty_count"], 1)
            self.assertTrue(
                all(
                    result["mask_source"] == "current_mask"
                    and result["apply_scope"] == "mask"
                    for result in payload["results"]
                )
            )

    def test_folder_process_api_preserves_legacy_fields_and_adds_four_states(self):
        from moonshine_server.api import Api

        scenarios = {
            "completed_empty": ([], "completed", True),
            "partial": (
                [{"success": True}, {"success": False, "error": "bad"}],
                "partial",
                True,
            ),
            "skipped": (
                [{"success": False, "skipped": True}],
                "skipped",
                True,
            ),
            "failed": ([{"success": False, "error": "bad"}], "failed", False),
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_dir = root / "images"
            output_dir = root / "output"
            image_dir.mkdir()
            request = MoonshineImageFolderProcessRequest(
                model_id="slbr",
                image_folder=str(image_dir),
                output_folder=str(output_dir),
            )

            for scenario, (results, expected_status, expected_success) in scenarios.items():
                with self.subTest(scenario=scenario):
                    api = Api.__new__(Api)
                    api._release_sam_runtime_before_processing = lambda *args: None
                    api._normalize_moonshine_options = lambda *args: {
                        "tile_size": 256,
                        "tile_batch": 1,
                        "local_inference_strategy": "auto",
                        "local_bbox_empty_ratio_threshold": 50,
                        "local_edge_feather_px": 2,
                    }
                    api._get_moonshine_runner = lambda *args: type(
                        "FakeRunner",
                        (),
                        {"process_folder": lambda self, *args, **kwargs: results},
                    )()

                    response = api.api_moonshine_image_process_folder(request)
                    payload = json.loads(response.body)

                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(payload["status"], expected_status)
                    self.assertEqual(payload["success"], expected_success)
                    self.assertEqual(payload["processed_count"], len(results))
                    self.assertEqual(payload["total_count"], len(results))
                    if expected_status == "completed":
                        self.assertEqual(
                            payload["message"], "Folder processing completed"
                        )
                    elif expected_status == "failed":
                        self.assertEqual(payload["message"], "Folder processing failed")

    def test_result_summary_distinguishes_completed_partial_skipped_and_failed(self):
        scenarios = {
            "completed_empty": ([], "completed"),
            "completed": ([{"success": True}], "completed"),
            "partial": (
                [{"success": True}, {"success": False, "error": "bad"}],
                "partial",
            ),
            "skipped": ([{"success": False, "skipped": True}], "skipped"),
            "failed": ([{"success": False, "error": "bad"}], "failed"),
        }

        for scenario, (results, expected_status) in scenarios.items():
            with self.subTest(scenario=scenario):
                summary = summarize_processing_results(results)
                self.assertEqual(summary["status"], expected_status)
                self.assertEqual(summary["success"], expected_status != "failed")

    def test_folder_local_png_and_full_fallback_keep_separate_output_rules(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            image_dir = temp_root / "images"
            mask_dir = temp_root / "masks"
            output_dir = temp_root / "output"
            image_dir.mkdir()
            mask_dir.mkdir()
            image = np.full((32, 32, 3), 80, dtype=np.uint8)
            Image.fromarray(image).save(image_dir / "masked.png")
            Image.fromarray(image).save(image_dir / "fallback.png")
            mask = np.zeros((32, 32), dtype=np.uint8)
            mask[4:16, 4:16] = 255
            Image.fromarray(mask).save(mask_dir / "masked.png")

            runner = SlbrRunner(ROOT, device="cpu")
            runner._forward = lambda batch: (
                batch,
                torch.zeros(batch.shape[0], 1, batch.shape[2], batch.shape[3]),
            )
            runner.infer_bgr = lambda image_bgr, **kwargs: (
                image_bgr.copy(),
                np.zeros_like(image_bgr),
            )

            results = runner.process_folder(
                image_dir,
                output_dir,
                tile_size=256,
                tile_batch=1,
                output_format="jpg",
                apply_scope="mask",
                mask_folder=mask_dir,
                missing_mask_behavior="full",
                local_inference_strategy="smart_tiles",
                local_edge_feather_px=0,
            )
            by_name = {Path(result["image_path"]).name: result for result in results}

            self.assertEqual(by_name["masked.png"]["apply_scope"], "mask")
            self.assertEqual(by_name["masked.png"]["extension"], ".png")
            self.assertEqual(
                Path(by_name["masked.png"]["output_path"]).name,
                "masked_clean.png",
            )
            self.assertEqual(by_name["fallback.png"]["apply_scope"], "full")
            self.assertEqual(by_name["fallback.png"]["extension"], ".jpg")


if __name__ == "__main__":
    unittest.main(verbosity=2)
