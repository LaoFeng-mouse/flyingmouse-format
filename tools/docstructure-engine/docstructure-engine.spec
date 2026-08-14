# -*- mode: python ; coding: utf-8 -*-
import site
from pathlib import Path

import setuptools  # activates the _vendor sys.path insert so vendored top-level modules resolve
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

root = Path(SPECPATH)

datas = (
    collect_data_files("paddlex")
    + collect_data_files("paddleocr")
    + collect_data_files("img2table")
)

binaries = collect_dynamic_libs("paddle")

# paddlex.utils.deps reads importlib.metadata at import time (validates the "ocr"
# extra), so every installed distribution's metadata must be shipped.
for _sp in site.getsitepackages():
    _sp_path = Path(_sp)
    if not _sp_path.is_dir():
        continue
    for _entry in list(_sp_path.glob("*.dist-info")) + list(_sp_path.glob("*.egg-info")):
        datas.append((str(_entry), _entry.name))

hiddenimports = ["paddleocr", "paddlex", "img2table", "fitz", "PIL"]

# setuptools vendors packages under setuptools/_vendor and exposes them top-level
# via a sys.path insert. PyInstaller's static analysis misses conditional imports
# inside them (e.g. jaraco.context -> backports on Python < 3.12), so collect the
# vendored submodules under their top-level names.
_vendor = Path(setuptools.__file__).parent / "_vendor"
for _pkg in _vendor.iterdir():
    if not _pkg.is_dir():
        continue
    try:
        hiddenimports += collect_submodules(_pkg.name)
    except Exception:
        pass

a = Analysis(
    [str(root / "flyingmouse_docstructure" / "__main__.py")],
    pathex=[str(root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=["tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="docstructure-engine",
          debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
          console=True, disable_windowed_traceback=True)
dist = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False,
               name="docstructure-engine")
