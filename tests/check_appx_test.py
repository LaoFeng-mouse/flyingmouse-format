"""python -m unittest discover -s tests -p check_appx_test.py"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "check-appx.py"
SPEC = importlib.util.spec_from_file_location("check_appx", SCRIPT)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class CheckAppxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fm-appx-check-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.reference = self.root / "app.asar"
        self.reference.write_bytes(b"rebuilt source")
        self.package = self.root / "fixture.appx"
        self.expected = {"version": "0.7.0.0", "identity": "FlyingMouse.Test", "publisher": "CN=Test"}

    def build(self, *, identity="FlyingMouse.Test", publisher="CN=Test", version="0.7.0.0", architecture="x64", omit=(), extra=(), asar=b"rebuilt source"):
        manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="{CHECK.PACKAGE_NAMESPACE}">
  <Identity Version='{version}'
      Publisher="{publisher}" ProcessorArchitecture='{architecture}'
      Name='{identity}' />
  <Applications><Application Id="FlyingMouse" Executable="app\\FlyingMouse.exe" /></Applications>
</Package>'''
        entries = [("[Content_Types].xml", "types"), ("AppxManifest.xml", manifest),
                   ("AppxBlockMap.xml", "blockmap"), ("app/resources/app.asar", asar), ("app/FlyingMouse.exe", b"MZ")]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.package, "w") as archive:
                for name, content in entries + list(extra):
                    if name not in omit:
                        archive.writestr(name, content)

    def verify(self):
        return CHECK.verify_package(self.package, self.reference, **self.expected)

    def run_checker(self):
        return subprocess.run([sys.executable, str(SCRIPT), str(self.package), str(self.reference),
                               "--version", self.expected["version"], "--identity", self.expected["identity"],
                               "--publisher", self.expected["publisher"]], capture_output=True, text=True, encoding="utf-8")

    def test_valid_multiline_identity_and_mixed_quotes(self):
        self.build()
        self.assertTrue(self.verify()["ok"])
        self.assertEqual(self.run_checker().returncode, 0)

    def test_identity_publisher_version_and_architecture_fail_closed(self):
        for changed in ({"identity": "Other"}, {"publisher": "CN=Wrong"}, {"version": "0.6.10.0"}, {"architecture": "arm64"}):
            with self.subTest(changed=changed):
                self.build(**changed)
                self.assertFalse(self.verify()["ok"])
                self.assertNotEqual(self.run_checker().returncode, 0)

    def test_required_entries_must_exist_at_root(self):
        for name in CHECK.REQUIRED_ROOTS:
            with self.subTest(name=name):
                self.build(omit=(name,), extra=((f"nested/{name}", "wrong place"),))
                self.assertFalse(self.verify()["ok"])

    def test_signature_rejected(self):
        self.build(extra=(("AppxSignature.p7x", b"signed"),))
        self.assertFalse(self.verify()["ok"])

    def test_missing_and_mismatched_asar_fail(self):
        self.build(asar=b"stale source")
        self.assertFalse(self.verify()["ok"])
        self.assertNotEqual(self.run_checker().returncode, 0)
        self.build(omit=(CHECK.ASAR_PATH,))
        self.assertFalse(self.verify()["ok"])

    def test_duplicate_and_case_colliding_paths_fail(self):
        for entry in ("app/resources/app.asar", "APP/Resources/App.Asar"):
            with self.subTest(entry=entry):
                self.build(extra=((entry, b"rebuilt source"),))
                self.assertFalse(self.verify()["ok"])

    def test_backup_directories_rejected(self):
        for entry in ("app/resources/backup/old.dll", "app/resources/libreoffice.backup-123/old.dll", "app/.git/config"):
            with self.subTest(entry=entry):
                self.build(extra=((entry, b"old"),))
                self.assertFalse(self.verify()["ok"])

    def test_missing_executable_and_traversal_rejected(self):
        self.build(omit=("app/FlyingMouse.exe",))
        self.assertFalse(self.verify()["ok"])
        self.build(extra=(("../outside", b"x"),))
        self.assertNotEqual(self.run_checker().returncode, 0)

    def test_corrupt_zip_returns_nonzero(self):
        self.package.write_bytes(b"not a zip")
        result = self.run_checker()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)["ok"])

    def test_repository_defaults_are_loaded(self):
        self.build()
        manifest = self.root / "package.json"
        manifest.write_text(json.dumps({"version": "0.7.0", "build": {"appx": {
            "identityName": "FlyingMouse.Test", "publisher": "CN=Test"}}}), encoding="utf-8")
        command = [sys.executable, str(SCRIPT), str(self.package), str(self.reference), "--package-json", str(manifest)]
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
        manifest.write_text("{}", encoding="utf-8")
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()
