import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from PIL import Image

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from flyingmouse_docstructure import __version__
from flyingmouse_docstructure.__main__ import main
from flyingmouse_docstructure.normalize import ResourceLimitError
from flyingmouse_docstructure.pipeline import InvalidOutputError, MissingModelError, ParseError


class FakePipeline:
    def parse(self, input_path, output_dir):
        Image.new("RGB", (20, 30), "white").save(output_dir / "page-001.png")
        return [{"pageNumber": 1, "width": 20, "height": 30, "rotation": 0,
                 "referenceImage": "page-001.png", "tableLike": False,
                 "blocks": [{"type": "text", "bbox": [1, 1, 10, 10],
                             "text": "anonymous", "confidence": .9}],
                 "tables": [], "warnings": [], "elapsedMs": 1}]


class CandidatePipeline:
    def parse(self, input_path, output_dir):
        Image.new("RGB", (20, 30), "white").save(output_dir / "page-001.png")
        cells = [{"row": row, "column": column, "rowSpan": 1, "columnSpan": 1,
                  "bbox": [column * 10, row * 10, (column + 1) * 10, (row + 1) * 10],
                  "text": f"{row}:{column}", "confidence": .95}
                 for row in range(2) for column in range(2)]
        return [{"pageNumber": 1, "width": 20, "height": 30, "rotation": 0,
                 "referenceImage": "page-001.png", "tableLike": True, "blocks": [],
                 "tables": [], "tableCandidates": [{"source": "pp-structure-v3",
                    "id": "candidate-001", "rowCount": 2, "columnCount": 2,
                    "bbox": [0, 0, 20, 20], "confidence": .95, "cells": cells}],
                 "warnings": [], "elapsedMs": 1}]


class CliTests(unittest.TestCase):
    def invoke(self, argv, effect=None):
        out, err = io.StringIO(), io.StringIO()
        replacement = FakePipeline() if effect is None else effect
        with mock.patch("flyingmouse_docstructure.__main__.build_pipeline", return_value=replacement), \
             redirect_stdout(out), redirect_stderr(err):
            code = main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_parse_writes_atomic_utf8_manifest_and_stdout_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root / "anonymous.pdf"; source.write_bytes(b"%PDF")
            output = root / "out"; models = root / "models"; models.mkdir()
            code, stdout, stderr = self.invoke([
                "parse", "--input", str(source), "--output", str(output),
                "--models", str(models), "--language", "ch"])
            self.assertEqual(code, 0)
            self.assertEqual(stdout, "")
            status = json.loads(stderr)
            self.assertEqual(set(status), {"code", "engineVersion", "pageCount", "elapsedMs"})
            self.assertEqual(status["code"], "OK")
            manifest = json.loads((output / "manifest.json").read_text("utf-8"))
            self.assertEqual(manifest["schemaVersion"], 1)
            self.assertEqual(manifest["engine"]["version"], __version__)
            self.assertFalse(any(output.glob("*.tmp")))

    def test_models_argument_is_required(self):
        code, stdout, stderr = self.invoke(["parse", "--input", "x", "--output", "y"])
        self.assertEqual(code, 20)
        self.assertEqual(stdout, "")
        self.assertEqual(json.loads(stderr)["code"], "MODEL_MISSING")

    def test_other_argument_error_is_parse_failed(self):
        code, stdout, stderr = self.invoke(["parse", "--models", "m", "--output", "y"])
        self.assertEqual((code, stdout), (21, ""))
        self.assertEqual(json.loads(stderr)["code"], "PARSE_FAILED")

    def test_non_directory_output_is_invalid_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root / "in.pdf"; source.write_bytes(b"%PDF")
            output = root / "out"; output.write_bytes(b"keep")
            models = root / "models"; models.mkdir()
            code, stdout, stderr = self.invoke(["parse", "--input", str(source),
                "--output", str(output), "--models", str(models), "--language", "ch"])
        self.assertEqual((code, stdout), (22, ""))
        self.assertEqual(json.loads(stderr)["code"], "INVALID_OUTPUT")

    def test_failures_have_stable_private_status_and_clean_partial_output(self):
        cases = [(MissingModelError(), 20, "MODEL_MISSING"),
                 (ParseError("secret path and OCR text"), 21, "PARSE_FAILED"),
                 (InvalidOutputError(), 22, "INVALID_OUTPUT"),
                 (ResourceLimitError(), 23, "RESOURCE_LIMIT")]
        for failure, expected_exit, expected_code in cases:
            with self.subTest(expected_code), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); source = root / "private.pdf"; source.write_bytes(b"%PDF")
                output = root / "out"; output.mkdir(); (output / "partial.bin").write_bytes(b"x")
                models = root / "models"; models.mkdir()
                fake = mock.Mock(); fake.parse.side_effect = failure
                code, stdout, stderr = self.invoke([
                    "parse", "--input", str(source), "--output", str(output),
                    "--models", str(models), "--language", "ch"], fake)
                self.assertEqual(code, expected_exit)
                self.assertEqual(stdout, "")
                status = json.loads(stderr)
                self.assertEqual(status["code"], expected_code)
                self.assertNotIn("private", stderr)
                self.assertNotIn("secret", stderr)
                self.assertEqual(list(output.iterdir()), [])

    def test_unhandled_failure_collapses_without_trace(self):
        fake = mock.Mock(); fake.parse.side_effect = RuntimeError("OCR SECRET")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / "in.pdf").write_bytes(b"%PDF"); (root / "models").mkdir()
            code, _, stderr = self.invoke(["parse", "--input", str(root / "in.pdf"),
                "--output", str(root / "out"), "--models", str(root / "models"),
                "--language", "ch"], fake)
        self.assertEqual(code, 21)
        self.assertNotIn("SECRET", stderr)
        self.assertNotIn("Traceback", stderr)

    def test_import_does_not_load_heavy_dependencies_or_spawn(self):
        script = "import sys; import flyingmouse_docstructure.__main__; " \
                 "print(','.join(x for x in ('paddleocr','img2table','fitz','PIL') if x in sys.modules))"
        env = dict(os.environ); env["PYTHONPATH"] = str(ENGINE_ROOT)
        completed = subprocess.run([sys.executable, "-c", script], capture_output=True,
                                   text=True, env=env, check=True)
        self.assertEqual(completed.stdout.strip(), "")

    def test_python_manifest_passes_node_task3_contract_and_task7_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root / "anonymous.pdf"; source.write_bytes(b"%PDF")
            output = root / "out"; models = root / "models"; models.mkdir()
            code, _, _ = self.invoke(["parse", "--input", str(source), "--output", str(output),
                                      "--models", str(models), "--language", "ch"], CandidatePipeline())
            self.assertEqual(code, 0)
            validator = Path(__file__).resolve().parents[3] / "pdf-structure-contract.js"
            script = ("const {validateStructureManifest}=require(process.argv[1]);"
                      "const fs=require('fs');const m=JSON.parse(fs.readFileSync(process.argv[2]));"
                      "const v=validateStructureManifest(m,process.argv[3]);"
                      "if(v.pages.length!==1||v.pages[0].tables.length!==1||"
                      "v.pages[0].tables[0].id!=='candidate-001')process.exit(4)")
            completed = subprocess.run(["node", "-e", script, str(validator),
                                        str(output / "manifest.json"), str(output)],
                                       capture_output=True, text=True)
            self.assertEqual(completed.returncode, 0, completed.stderr)


if __name__ == "__main__":
    unittest.main()
