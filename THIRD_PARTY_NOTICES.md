# Third-party software

FlyingMouse Format is authored by 牢蜂 (LaoFeng). Its application license does not replace the licenses of independently bundled third-party components.

## Pandoc 3.11

Copyright John MacFarlane and contributors; GPL version 2 or later, with component exceptions described in `third_party/pandoc/COPYRIGHT.txt`. The complete upstream license is included in `third_party/pandoc/COPYING.rtf` and beside the packaged executable in `resources/pandoc/`.

The application invokes the unmodified official Pandoc executable as a separate process to parse Markdown and write Office Math documents. Fixed release archives and their SHA-256 values are recorded in `pandoc-engine-lock.json`.

- Release: https://github.com/jgm/pandoc/releases/tag/3.11
- Exact source: https://hackage.haskell.org/package/pandoc-3.11/pandoc-3.11.tar.gz
- Source repository: https://github.com/jgm/pandoc/tree/3.11

## JavaScript dependencies and other engines

KaTeX, marked, docx, and the other JavaScript dependencies retain their upstream licenses in `node_modules/`. FFmpeg, LibreOffice, Poppler, Tesseract, and the other bundled conversion engines retain the license notices distributed in their resource directories. See `package-lock.json` for resolved JavaScript versions and `ci-engines-v1.json` for fixed engine assets.

PasteMD was reviewed as a behavior reference. Its application source code is not incorporated into this project.

## LibRaw 0.22.2 (Windows CR2 decoding)

Unmodified official dcraw_emu.exe and libraw.dll from https://www.libraw.org/data/LibRaw-0.22.2-Win64.zip. Dual licensed LGPL 2.1 / CDDL 1.0. COPYRIGHT, both license texts and the complete upstream source/binary archive are included in resources/libraw. Microsoft VC143 x64 runtime files are distributed app-locally from the Visual Studio Build Tools redistributable directory; its Redist.txt is included. Exact source and payload hashes are in libraw-engine-lock.json.
