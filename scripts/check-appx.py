"""Verify an unsigned x64 Store APPX and exit nonzero on any failed check.

python scripts/check-appx.py package.appx dist/win-unpacked/resources/app.asar
Optional --version, --identity and --publisher default to repository package.json.
Local validation does not establish Microsoft Store certification.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

PACKAGE_NAMESPACE = "http://schemas.microsoft.com/appx/manifest/foundation/windows10"
REQUIRED_ROOTS = ("[Content_Types].xml", "AppxManifest.xml", "AppxBlockMap.xml")
ASAR_PATH = "app/resources/app.asar"


def sha_stream(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def normalized_entry(name):
    normalized = name.replace("\\", "/")
    parts = normalized.rstrip("/").split("/")
    if not normalized or normalized.startswith("/") or any(
        not part or part in (".", "..") or ":" in part or "\x00" in part
        or part != part.rstrip(" .") for part in parts
    ):
        raise ValueError(f"Unsafe package entry: {name}")
    return "/".join(parts).casefold()


def backup_entry(name):
    parts = name.replace("\\", "/").rstrip("/").split("/")
    directory_parts = parts if name.endswith(("/", "\\")) else parts[:-1]
    for part in directory_parts:
        lowered = part.casefold()
        if lowered in {".git", ".codex", ".worktrees", "backup", "backups", ".backup", ".backups", "__pycache__"}:
            return True
        if re.search(r"(?:^|[._-])(?:backup|backups|bak)(?:$|[._-])", lowered):
            return True
    return False


def parse_manifest(data):
    if len(data) > 2 * 1024 * 1024 or b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("Manifest is oversized or contains a prohibited DTD/entity")
    root = ET.fromstring(data)
    if root.tag != f"{{{PACKAGE_NAMESPACE}}}Package":
        raise ValueError("Unexpected AppxManifest root or namespace")
    identities = root.findall(f"{{{PACKAGE_NAMESPACE}}}Identity")
    if len(identities) != 1:
        raise ValueError("AppxManifest must contain exactly one Identity")
    return root, identities[0]


def verify_package(package, asar_reference, *, version, identity, publisher):
    errors = []
    evidence = {"package": str(package), "expectedVersion": version}
    if not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", version) or any(int(part) > 65535 for part in version.split(".")):
        raise ValueError("Expected APPX version must contain four integers between 0 and 65535")
    if not identity or not publisher:
        raise ValueError("Expected Identity and Publisher must be provided")
    with open(asar_reference, "rb") as reference:
        evidence["referenceAsarSha256"] = sha_stream(reference)
    with zipfile.ZipFile(package) as archive:
        bad = archive.testzip()
        if bad is not None:
            errors.append(f"ZIP integrity failed at {bad}")
        infos = archive.infolist()
        seen = set()
        names = {info.filename for info in infos if not info.is_dir()}
        file_paths = {normalized_entry(name) for name in names}
        for info in infos:
            normalized = normalized_entry(info.filename)
            if normalized in seen:
                errors.append(f"Duplicate package path: {info.filename}")
            seen.add(normalized)
            if info.flag_bits & 1:
                errors.append(f"Encrypted ZIP entry is prohibited: {info.filename}")
            if backup_entry(info.filename):
                errors.append(f"Development/backup directory included: {info.filename}")
        for needed in REQUIRED_ROOTS:
            if needed not in names:
                errors.append(f"Missing root entry: {needed}")
        if "appxsignature.p7x" in seen:
            errors.append("Store submission deliverable must be unsigned; AppxSignature.p7x is present")
        if "AppxManifest.xml" in names:
            root, manifest_identity = parse_manifest(archive.read("AppxManifest.xml"))
            expected = {"Name": identity, "Publisher": publisher, "Version": version, "ProcessorArchitecture": "x64"}
            evidence["identity"] = dict(manifest_identity.attrib)
            for attribute, value in expected.items():
                actual = manifest_identity.get(attribute)
                if actual != value:
                    errors.append(f"Identity {attribute} mismatch: expected {value!r}, got {actual!r}")
            applications = root.findall(f"{{{PACKAGE_NAMESPACE}}}Applications/{{{PACKAGE_NAMESPACE}}}Application")
            if not applications:
                errors.append("Manifest contains no Application")
            for application in applications:
                executable = application.get("Executable", "").replace("\\", "/")
                if not executable or normalized_entry(executable) not in file_paths:
                    errors.append(f"Application executable missing from package: {executable!r}")
        if ASAR_PATH not in names:
            errors.append(f"Missing application source archive: {ASAR_PATH}")
        else:
            with archive.open(ASAR_PATH) as inner:
                evidence["packagedAsarSha256"] = sha_stream(inner)
            if evidence["packagedAsarSha256"] != evidence["referenceAsarSha256"]:
                errors.append("ASAR mismatch: package does not contain the rebuilt application")
    evidence["sizeBytes"] = Path(package).stat().st_size
    evidence["ok"] = not errors
    evidence["errors"] = errors
    return evidence


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("asar_reference", type=Path)
    parser.add_argument("--package-json", type=Path, default=Path(__file__).resolve().parent.parent / "package.json")
    parser.add_argument("--version")
    parser.add_argument("--identity")
    parser.add_argument("--publisher")
    args = parser.parse_args(argv)
    try:
        defaults = {}
        if not all((args.version, args.identity, args.publisher)):
            defaults = json.loads(args.package_json.read_text(encoding="utf-8-sig"))
        appx = defaults.get("build", {}).get("appx", {})
        version = args.version or f"{defaults.get('version', '')}.0"
        evidence = verify_package(args.package, args.asar_reference, version=version,
                                  identity=args.identity or appx.get("identityName"),
                                  publisher=args.publisher or appx.get("publisher"))
    except (OSError, ValueError, KeyError, ET.ParseError, zipfile.BadZipFile, RuntimeError) as error:
        evidence = {"ok": False, "errors": [str(error)]}
    print(json.dumps(evidence, ensure_ascii=False, indent=2))
    return 0 if evidence["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
