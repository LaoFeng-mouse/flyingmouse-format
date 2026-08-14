import re
import unittest
from pathlib import Path


class PyInstallerSpecTests(unittest.TestCase):
    def test_builds_one_folder_distribution_without_models(self):
        spec = (Path(__file__).resolve().parents[1] / "docstructure-engine.spec").read_text("utf-8")
        self.assertRegex(spec, r"EXE\([\s\S]*exclude_binaries=True")
        self.assertRegex(spec, r"COLLECT\(exe,\s*a\.binaries,\s*a\.datas,[\s\S]*name=['\"]docstructure-engine['\"]")
        self.assertNotRegex(spec, r"datas\s*=\s*\[[^\]]*models")

    def test_collects_paddle_runtime_resources(self):
        # The packaged engine failed at runtime without these: paddle's BLAS/MKL DLLs,
        # paddlex's YAML configs, distribution metadata (paddlex deps checks
        # importlib.metadata at import time) and setuptools-vendored submodules
        # (jaraco.context imports backports top-level on Python < 3.12).
        spec = (Path(__file__).resolve().parents[1] / "docstructure-engine.spec").read_text("utf-8")
        self.assertIn('collect_data_files("paddlex")', spec)
        self.assertIn('collect_dynamic_libs("paddle")', spec)
        self.assertIn('collect_submodules', spec)
        self.assertIn('"*.dist-info"', spec)
        self.assertIn('"*.egg-info"', spec)
        self.assertIn('import setuptools', spec)


if __name__ == "__main__":
    unittest.main()
