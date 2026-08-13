import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from PIL import Image

from flyingmouse_docstructure.pipeline import (MissingModelError, attach_second_opinion,
                                                build_pipeline, materialize_assets,
                                                validate_manifest_limits)


class PipelineTests(unittest.TestCase):
    def _models(self, root):
        required = ["layout_detection", "doc_orientation_classification", "doc_unwarping",
                    "text_detection", "text_recognition", "table_classification",
                    "wired_table_structure", "wireless_table_structure",
                    "wired_table_cells", "wireless_table_cells",
                    "seal_text_detection"]
        for name in required:
            (root / name).mkdir(parents=True)
        return required

    def test_build_pipeline_uses_local_cpu_single_process_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "models"
            self._models(root)
            fake_module = mock.Mock()
            instance = object()
            fake_module.PPStructureV3.return_value = instance
            with mock.patch.dict(sys.modules, {"paddleocr": fake_module}):
                built = build_pipeline(root, "ch")
            self.assertIs(built.backend, instance)
            kwargs = fake_module.PPStructureV3.call_args.kwargs
            self.assertEqual(kwargs["device"], "cpu")
            self.assertFalse(kwargs["use_formula_recognition"])
            self.assertTrue(kwargs["use_seal_recognition"])
            self.assertEqual(kwargs["cpu_threads"], 1)
            config = json.loads(Path(kwargs["paddlex_config"]).read_text("utf-8"))
            self.assertEqual(config["batch_size"], 1)
            def collect(value, key):
                found = []
                if isinstance(value, dict):
                    found.extend(item for name, item in value.items() if name == key)
                    for nested in value.values(): found.extend(collect(nested, key))
                elif isinstance(value, list):
                    for nested in value: found.extend(collect(nested, key))
                return found
            configured_paths = {Path(item).resolve() for item in collect(config, "model_dir")}
            self.assertEqual(configured_paths, {path.resolve() for path in root.iterdir()})
            self.assertTrue(all(item == 1 for item in collect(config, "batch_size")))
            model_kwargs = {key: value for key, value in kwargs.items() if key.endswith("_model_dir")}
            self.assertEqual(len(model_kwargs), 13)
            self.assertTrue(all(Path(value).resolve().is_relative_to(root.resolve())
                                for value in model_kwargs.values()))
            self.assertTrue(kwargs["use_doc_orientation_classify"])
            self.assertTrue(kwargs["use_doc_unwarping"])
            self.assertFalse(kwargs["use_textline_orientation"])
            self.assertFalse(kwargs["use_chart_recognition"])
            self.assertFalse(kwargs["use_region_detection"])
            config_path = built.config_path
            built.close()
            self.assertFalse(config_path.exists())

    def test_missing_model_and_url_or_escape_are_rejected_before_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "models"
            with self.assertRaises(MissingModelError):
                build_pipeline(root, "ch")
            root.mkdir()
            with mock.patch.dict(sys.modules, {"paddleocr": None}):
                with self.assertRaises(MissingModelError):
                    build_pipeline(root, "ch")
            (root / "doc_preprocessor").mkdir()
            (root / "model-map.json").write_text(
                json.dumps({"doc_preprocessor": "https://invalid/model"}), "utf-8")
            with self.assertRaises(MissingModelError):
                build_pipeline(root, "ch")

    def test_manifest_total_limits_fail_before_serialization(self):
        page = {"blocks": [{}] * 5001, "tables": [], "tableCandidates": [],
                "width": 1, "height": 1}
        with self.assertRaises(Exception) as caught:
            validate_manifest_limits([page] * 10)
        self.assertEqual(caught.exception.__class__.__name__, "ResourceLimitError")

    def test_materializes_clipped_seal_signature_and_figure_assets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); reference = root / "page-001.png"
            Image.new("RGB", (100, 120), "white").save(reference)
            raw = {"width": 100, "height": 120, "parsing_res_list": [
                {"block_label": "seal", "block_bbox": [-5, 5, 25, 30]},
                {"block_label": "signature", "block_bbox": [30, 40, 60, 70]},
                {"block_label": "image", "block_bbox": [70, 80, 105, 130]}]}
            materialize_assets(raw, reference, root, 1)
            assets = [block["asset"] for block in raw["parsing_res_list"]]
            self.assertEqual(assets, ["page-001-seal-001.png",
                                      "page-001-signature-002.png",
                                      "page-001-figure-003.png"])
            self.assertTrue(all((root / asset).is_file() for asset in assets))
            self.assertEqual(raw["parsing_res_list"][0]["block_bbox"], [0, 5, 25, 30])

    def test_second_opinion_only_adds_candidates_when_pp_has_no_table(self):
        raw = {"width": 100, "height": 100, "table_res_list": []}
        with mock.patch("flyingmouse_docstructure.img2table_adapter.detect_table_candidates",
                        return_value=[{"source": "img2table"}]) as detect:
            attach_second_opinion(raw, Path("page.png"), 2)
        self.assertTrue(raw["tableLike"])
        self.assertEqual(raw["tableCandidates"], [{"source": "img2table"}])
        detect.assert_called_once()
        raw = {"table_res_list": [{"cells": []}]}
        with mock.patch("flyingmouse_docstructure.img2table_adapter.detect_table_candidates") as detect:
            attach_second_opinion(raw, Path("page.png"), 2)
        detect.assert_not_called()

    @unittest.skipIf(os.name == "nt", "symlink creation is not reliably permitted on Windows")
    def test_symlink_model_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "models"; root.mkdir()
            outside = Path(tmp) / "outside"; outside.mkdir()
            (root / "doc_preprocessor").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(MissingModelError):
                build_pipeline(root, "ch")


if __name__ == "__main__":
    unittest.main()
