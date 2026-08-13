# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

root = Path(SPECPATH)

a = Analysis(
    [str(root / "flyingmouse_docstructure" / "__main__.py")],
    pathex=[str(root)],
    binaries=[],
    datas=[],
    hiddenimports=["paddleocr", "paddlex", "img2table", "fitz", "PIL"],
    hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=["tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="docstructure-engine",
          debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
          console=True, disable_windowed_traceback=True)
dist = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False,
               name="docstructure-engine")
