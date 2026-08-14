import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from PIL import Image

from flyingmouse_docstructure.pipeline import (MODEL_ARGUMENTS, InvalidOutputError,
                                                LocalPipeline, MissingModelError,
                                                _is_ascii, attach_second_opinion,
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

    def test_table_recognition_nests_general_ocr_pipeline(self):
        # PaddleX's table_recognition_v2 lazily rebuilds its general OCR pipeline from
        # SubPipelines.GeneralOCR when use_ocr_model is False; without it the pipeline
        # raises KeyError('pipeline_name') during predict.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "models"
            self._models(root)
            fake_module = mock.Mock()
            fake_module.PPStructureV3.return_value = object()
            with mock.patch.dict(sys.modules, {"paddleocr": fake_module}):
                built = build_pipeline(root, "ch")
            try:
                config = json.loads(
                    Path(fake_module.PPStructureV3.call_args.kwargs["paddlex_config"]).read_text("utf-8"))
                table = config["SubPipelines"]["TableRecognition"]
                self.assertFalse(table["use_ocr_model"])
                general = table["SubPipelines"]["GeneralOCR"]
                self.assertEqual(general["pipeline_name"], "OCR")
                self.assertIn("TextDetection", general["SubModules"])
                self.assertIn("TextRecognition", general["SubModules"])
            finally:
                built.close()

    def test_non_ascii_model_path_is_staged_to_ascii_temp_and_cleaned(self):
        # Paddle's native inference runtime cannot open model files under a non-ASCII
        # path (verified: RuntimeError NotFound for a valid `...\飞鼠格式\...` model dir).
        # build_pipeline must materialize an ASCII-only staging copy and clean it on close.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "飞鼠格式模型"
            self._models(root)
            fake_module = mock.Mock()
            fake_module.PPStructureV3.return_value = object()
            with mock.patch.dict(sys.modules, {"paddleocr": fake_module}):
                built = build_pipeline(root, "ch")
            self.assertIsNotNone(built.staging_root)
            staging = built.staging_root
            self.assertTrue(staging.exists())
            self.assertTrue(_is_ascii(str(staging)))
            config = json.loads(
                Path(fake_module.PPStructureV3.call_args.kwargs["paddlex_config"]).read_text("utf-8"))
            collected = []
            def walk(value):
                if isinstance(value, dict):
                    for key, item in value.items():
                        if key == "model_dir": collected.append(item)
                        walk(item)
                elif isinstance(value, list):
                    for item in value: walk(item)
            walk(config)
            self.assertTrue(collected)
            self.assertTrue(all(_is_ascii(str(item)) for item in collected))
            built.close()
            self.assertFalse(staging.exists())

    def test_ascii_model_path_does_not_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "models"
            self._models(root)
            fake_module = mock.Mock()
            fake_module.PPStructureV3.return_value = object()
            with mock.patch.dict(sys.modules, {"paddleocr": fake_module}):
                built = build_pipeline(root, "ch")
            self.assertIsNone(built.staging_root)
            built.close()

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
        raw = {"width": 100, "height": 100, "tableLike": True, "table_res_list": []}
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

    def test_second_opinion_requires_table_like_evidence(self):
        raw = {"width": 100, "height": 100, "table_res_list": [],
               "parsing_res_list": [{"block_label": "text"}]}
        with mock.patch("flyingmouse_docstructure.img2table_adapter.detect_table_candidates") as detect:
            attach_second_opinion(raw, Path("page.png"), 1)
        detect.assert_not_called()

    def test_second_opinion_detects_pp_layout_and_block_table_labels(self):
        evidence = [
            {"layout_det_res": {"boxes": [{"label": "table"}]}},
            {"layout_det_res": {"boxes": [{"block_label": "table"}]}},
            {"layout_det_res": {"boxes": [{"type": "table"}]}},
            {"parsing_res_list": [{"block_label": "table"}]},
            {"blocks": [{"type": "table"}]},
        ]
        for raw in evidence:
            with self.subTest(raw=raw), \
                 mock.patch("flyingmouse_docstructure.img2table_adapter.detect_table_candidates",
                            return_value=[{"source": "img2table"}]) as detect:
                raw["table_res_list"] = []
                attach_second_opinion(raw, Path("page.png"), 1)
            detect.assert_called_once()
            self.assertTrue(raw["tableLike"])

    def test_none_layout_detection_is_invalid_engine_output(self):
        raw = {"layout_det_res": None, "table_res_list": [], "parsing_res_list": []}
        with self.assertRaises(InvalidOutputError):
            attach_second_opinion(raw, Path("page.png"), 1)

    def test_constructed_pipeline_invocation_never_calls_download_or_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); models = root / "models"; model_names = self._models(models)
            output = root / "output"; output.mkdir(); source = root / "input.pdf"; source.write_bytes(b"%PDF")
            expected_arguments = set(MODEL_ARGUMENTS.values()) | {
                "table_orientation_classify_model_dir", "seal_text_recognition_model_dir"}
            downloads = mock.Mock()
            fake_paddlex = ModuleType("paddlex")
            fake_paddlex_utils = ModuleType("paddlex.utils")
            fake_paddlex_download = ModuleType("paddlex.utils.download")
            fake_paddlex_download.download = downloads.paddlex_download
            fake_paddlex.utils = fake_paddlex_utils
            fake_paddlex_utils.download = fake_paddlex_download
            fake_paddle = ModuleType("paddle")
            fake_paddle_utils = ModuleType("paddle.utils")
            fake_paddle_download = ModuleType("paddle.utils.download")
            fake_paddle_download.download = downloads.paddle_download
            fake_paddle.utils = fake_paddle_utils
            fake_paddle_utils.download = fake_paddle_download
            fake_requests = ModuleType("requests")
            fake_requests.get = downloads.requests_get

            def configured_model_dirs(config):
                found = []
                if isinstance(config, dict):
                    for key, value in config.items():
                        if key == "model_dir": found.append(value)
                        found.extend(configured_model_dirs(value))
                elif isinstance(config, list):
                    for value in config: found.extend(configured_model_dirs(value))
                return found

            class DownloadSensitivePPStructureV3:
                def __init__(self, **kwargs):
                    self.kwargs = kwargs
                    self._check_local_configuration()

                def _check_local_configuration(self):
                    supplied = {key for key in self.kwargs if key.endswith("_model_dir")}
                    config = json.loads(Path(self.kwargs["paddlex_config"]).read_text("utf-8"))
                    configured = configured_model_dirs(config)
                    missing = supplied != expected_arguments or len(configured) != 15 or any(
                        not Path(path).is_dir() for path in [
                            *(self.kwargs[key] for key in supplied), *configured])
                    if missing:
                        from paddlex.utils.download import download
                        from paddle.utils.download import download as paddle_download
                        import requests
                        from urllib.request import urlopen
                        import socket
                        download("missing-model")
                        paddle_download("missing-model")
                        requests.get("https://invalid.local/model")
                        urlopen("https://invalid.local/model")
                        socket.create_connection(("invalid.local", 443))

                def predict(self, **_kwargs):
                    self._check_local_configuration()
                    return [SimpleNamespace(json={
                        "parsing_res_list": [{"block_label": "text", "block_bbox": [1, 1, 10, 10],
                                              "block_content": "anonymous", "block_score": .9}],
                        "table_res_list": []})]

            fake_paddleocr = ModuleType("paddleocr")
            fake_paddleocr.PPStructureV3 = DownloadSensitivePPStructureV3
            fake_page = mock.Mock(rect=SimpleNamespace(width=20, height=30), rotation=0)
            fake_pixmap = SimpleNamespace(width=40, height=60,
                save=lambda target: Image.new("RGB", (40, 60), "white").save(target))
            fake_page.get_pixmap.return_value = fake_pixmap
            fake_document = mock.Mock(page_count=1, load_page=mock.Mock(return_value=fake_page))
            fake_fitz = SimpleNamespace(open=mock.Mock(return_value=fake_document),
                                        Matrix=lambda x, y: (x, y))
            with mock.patch.dict(sys.modules, {"paddleocr": fake_paddleocr,
                "paddlex": fake_paddlex, "paddlex.utils": fake_paddlex_utils,
                "paddlex.utils.download": fake_paddlex_download, "requests": fake_requests,
                "paddle": fake_paddle, "paddle.utils": fake_paddle_utils,
                "paddle.utils.download": fake_paddle_download,
                "fitz": fake_fitz}), \
                mock.patch("urllib.request.urlopen", downloads.urlopen), \
                mock.patch("socket.create_connection", downloads.socket_create_connection), \
                mock.patch("flyingmouse_docstructure.pipeline.attach_second_opinion"):
                negative_kwargs = {key: str(models / name)
                                   for name, key in MODEL_ARGUMENTS.items()}
                negative_config = {"models": [
                    {"model_dir": str(models / name)} for name in model_names
                ] + [
                    {"model_dir": str(models / "doc_orientation_classification")},
                    {"model_dir": str(models / "text_recognition")},
                ]}
                negative_config_path = root / "complete-config.json"
                negative_config_path.write_text(json.dumps(negative_config), "utf-8")
                negative_kwargs.update(
                    paddlex_config=str(negative_config_path),
                    table_orientation_classify_model_dir=str(models / "doc_orientation_classification"),
                    seal_text_recognition_model_dir=str(models / "text_recognition"))
                negative_kwargs.pop("layout_detection_model_dir")
                DownloadSensitivePPStructureV3(**negative_kwargs)
                downloads.paddlex_download.assert_called_once()
                downloads.paddle_download.assert_called_once()
                downloads.requests_get.assert_called_once()
                downloads.urlopen.assert_called_once()
                downloads.socket_create_connection.assert_called_once()
                downloads.reset_mock()
                pipeline = build_pipeline(models, "ch")
                pages = pipeline.parse(source, output)
                kwargs = pipeline.backend.kwargs
                pipeline.close()
            self.assertEqual(len(pages), 1)
            self.assertEqual(downloads.mock_calls, [])
            supplied_arguments = {key for key in kwargs if key.endswith("_model_dir")}
            self.assertEqual(supplied_arguments, expected_arguments)
            supplied = {Path(kwargs[key]).resolve() for key in supplied_arguments}
            self.assertEqual(supplied, {path.resolve() for path in models.iterdir()})

    def test_parse_unwraps_paddlex_res_envelope(self):
        # PaddleX JsonMixin.json returns {"res": {...}}; the engine must unwrap it
        # or every real document normalizes to zero blocks/tables.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root / "in.pdf"; source.write_bytes(b"%PDF")
            output = root / "out"; output.mkdir()
            config_path = root / "config.json"; config_path.write_text("{}", "utf-8")
            backend = mock.Mock()
            backend.predict.return_value = [SimpleNamespace(json={"res": {
                "parsing_res_list": [{"block_label": "text", "block_bbox": [1, 1, 10, 10],
                                      "block_content": "hi", "block_score": .9}],
                "table_res_list": [], "layout_det_res": {"boxes": []},
                "overall_ocr_res": {}, "width": 40, "height": 60}})]
            pipeline = LocalPipeline(backend, config_path)
            fake_page = mock.Mock(rect=SimpleNamespace(width=20, height=30), rotation=0)
            fake_pixmap = SimpleNamespace(width=40, height=60,
                save=lambda target: Image.new("RGB", (40, 60), "white").save(target))
            fake_page.get_pixmap.return_value = fake_pixmap
            document = mock.Mock(page_count=1, load_page=mock.Mock(return_value=fake_page))
            fitz = SimpleNamespace(open=mock.Mock(return_value=document), Matrix=lambda x, y: (x, y))
            with mock.patch.dict(sys.modules, {"fitz": fitz}):
                pages = pipeline.parse(source, output)
            self.assertEqual(len(pages), 1)
            self.assertEqual(len(pages[0]["blocks"]), 1)
            self.assertEqual(pages[0]["blocks"][0]["type"], "text")

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
