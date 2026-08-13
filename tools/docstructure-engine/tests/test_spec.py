import re
import unittest
from pathlib import Path


class PyInstallerSpecTests(unittest.TestCase):
    def test_builds_one_folder_distribution_without_models(self):
        spec = (Path(__file__).resolve().parents[1] / "docstructure-engine.spec").read_text("utf-8")
        self.assertRegex(spec, r"EXE\([\s\S]*exclude_binaries=True")
        self.assertRegex(spec, r"COLLECT\(exe,\s*a\.binaries,\s*a\.datas,[\s\S]*name=['\"]docstructure-engine['\"]")
        self.assertNotRegex(spec, r"datas\s*=\s*\[[^\]]*models")


if __name__ == "__main__":
    unittest.main()
