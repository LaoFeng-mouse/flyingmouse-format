# AGENTS.md

## Project

飞鼠格式 (FlyingMouse Format) is a Windows Electron desktop app for file format conversion. Keep the app usable offline: FFmpeg, LibreOffice, and Poppler are bundled under `bin/` and copied into Electron `extraResources`.

## Structure

- `server.js`: Express conversion service, target detection, filename decoding, conversion dispatch, download URLs.
- `public/index.html`, `public/app.js`, `public/styles.css`: renderer UI, single-file and batch conversion queue, progress and error display.
- `electron-main.js`: starts the local server, opens the window, handles save dialogs and batch save-to-folder.
- `electron-security.js`: pure URL/origin policy used by navigation, external-link, IPC, and download guards.
- `preload.js`: exposes safe IPC methods as `window.flyingMouseFormat`.
- `dist/`, `runtime/`, `test-results/`, `output/`, `.playwright-cli/`, and `node_modules/` are generated or local-only. `bin/` (bundled conversion engines) is also git-ignored and must be backed up separately.

## Rules

- Preserve original uploaded filenames when producing output names: `original basename.target extension`. This must work for Chinese names and other non-ASCII names.
- Batch conversion uses the intersection of all selected files' supported targets. Do not offer a target unless every selected file can convert to it.
- In desktop mode, converted files should be saved through Electron dialogs so the user can choose the destination.
- PDF to XLSX is text-table extraction, not OCR. Do not claim scanned image PDFs support XLSX reconstruction until layout analysis is added and tested.
- PDF to PNG/JPG uses bundled Poppler and returns a zip because a PDF can contain multiple pages.
- Image/PDF OCR to TXT uses bundled Tesseract.js language data. Do not claim scanned table-to-XLSX reconstruction is supported until layout analysis is added and tested.
- Keep UI text wrapped with `overflow-wrap: anywhere` or equivalent when adding long filenames, error messages, or buttons.
- Mouse-style UI assets must preserve the `鼠鼠打印` character grammar: full low-resolution mouse head, white blob body, rough black outline, and pink accent. Never crop the head into a circle or attach it to a generic vector body.
- Mouse UI state changes are renderer-only. Do not couple mascot states to conversion backend logic or change conversion APIs for visual effects.
- Keep Electron privilege boundaries intact: renderer navigation and IPC must stay on the exact local service origin; downloads must stay under `/downloads/<id>`; external opening only permits credential-free HTTPS URLs.
- Do not reintroduce dynamic `innerHTML` for filenames, conversion errors, capability data, or other runtime values. Use DOM APIs and `textContent`.
- Local builds are intentionally unsigned. Never store signing certificates, passwords, or tokens in the repository.

## Build

Use the mirror environment variables when packaging on this machine:

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:npm_config_registry='https://registry.npmmirror.com'
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm run dist
```

The installer is `dist\FlyingMouse Format-Setup-0.1.0-x64.exe`.

Store package: `npm run dist` also builds `dist\FlyingMouse Format-Setup-0.1.0-x64.appx` (MSIX, for Microsoft Store). `signExecutable:false`/`signAndEditExecutable:false` are intentional: electron-builder's bundled signtool cannot sign .appx — the appx is either signed manually with the Windows SDK signtool or left unsigned for the Store to sign at submission. The `appx` block in package.json holds the Partner Center identity (`identityName`, `publisher` CN, `displayName`). Full flow: docs/微软商店上架清单.md.

App icon: `build/icon.png` (512x512, 鼠鼠 avatar, transparent) — electron-builder picks it up automatically for NSIS installer, exe, taskbar, and appx store logos. Regenerate from `public/assets/mouse-format/source-mouse-avatar.png` if the mascot changes.

## Verification

Before handing off packaging changes, run syntax checks:

```powershell
node --check server.js
node --check public\app.js
node --check electron-main.js
node --check electron-security.js
node --check preload.js
npm test
```

For functional checks, test:

- Chinese-named OGG to MP3 keeps the original Chinese basename.
- Two TXT files batch-convert to HTML and show two successful queue rows.
- Packaged `dist\win-unpacked\FlyingMouse Format.exe` can perform the same conversion after `npm run dist`.
- Packaged startup reaches `Window finished loading`, and the browser console is free of application errors or warnings.
- Before public distribution, run `npm audit --omit=dev`; unresolved production advisories must be reported rather than hidden with a forced upgrade.
- Audio files (e.g. MP3) must NOT offer video container targets (mp4/webm/mkv/mov); the `targetsForExt` audio branch filters them.

Note on running tests from git-bash/MSYS: `npm test` uses `tar -tf <windows path>` in `conversion.test.js`, and the MSYS GNU tar misreads `C:\...` as a remote host, producing two false failures (`renders PDF pages to a PNG/JPG zip`). Run the test suite from cmd/PowerShell (or set PATH to prefer `C:\Windows\System32\tar.exe`) so Windows bsdtar handles the paths; the suite passes 25/25 there.

CI: GitHub Actions runs the engine-free suite (`npm run test:ci`, static/security/UI tests, 19 tests). `conversion.test.js` needs the gitignored `bin/` engines and runs locally (`npm test`, 25 tests). Workflow: `.github/workflows/ci.yml`.

## Repository

- Remote: `https://github.com/LaoFeng-mouse/flyingmouse-format.git` (public)
- Author identity: `LaoFeng <LaoFeng-mouse@users.noreply.github.com>` (repo-local git config; do not commit as Codex)
- License: MIT (LICENSE file, author LaoFeng). CI: GitHub Actions runs syntax check + `npm test` + `npm audit --omit=dev` on push/PR (`.github/workflows/ci.yml`).
- Release: v0.1.0 published; installer asset `FlyingMouse.Format-Setup-0.1.0-x64.exe` (SHA-256 7765A695...) matches local `dist\FlyingMouse Format-Setup-0.1.0-x64.exe`.
- Desktop shortcut: `C:\Users\34615\Desktop\FlyingMouse Format.lnk` → `dist\win-unpacked\FlyingMouse Format.exe`（2026-08-07 手动重建；NSIS 安装器 `createDesktopShortcut: true` 正式安装时也会自动创建）。
