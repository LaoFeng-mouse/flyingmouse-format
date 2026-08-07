# AGENTS.md

## Project

飞鼠格式 (FlyingMouse Format) is a Windows Electron desktop app for file format conversion. Keep the app usable offline: FFmpeg, LibreOffice, and Poppler are bundled under `bin/` and copied into Electron `extraResources`.

## Structure

- `server.js`: Express conversion service, target detection, filename decoding, conversion dispatch, download URLs.
- `logger.js`: single leveled logger (INFO/WARN/ERROR) shared by main process, server, and renderer-forwarded IPC events; writes `userData/debug.log` (Electron) or `%TEMP%\flyingmouse-format-debug.log` (standalone `node server.js`). `FLYINGMOUSE_LOG_FILE` env var overrides the path (used by tests). Log lines are bounded to ~1MB by trimming the tail. WARN/ERROR are also mirrored to stdout.
- `public/index.html`, `public/app.js`, `public/styles.css`: renderer UI, single-file and batch conversion queue, progress and error display. Clean neutral theme (orange accent, rounded cards, no mascot, no donation widget).
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
- UI has no mascot and no donation/sponsor widget (removed for the Xianyu sales build). Do not reintroduce mouse mascot states or a sponsor QR panel. Favicon is `public/assets/app-icon.svg` (neutral lightning mark).
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

The installer is `dist\FlyingMouse Format-Setup-0.2.1-x64.exe`.

### Win7 兼容版（Electron 22）

Mainline tracks Electron 43+ (Windows 10/11). A Win7-compatible build lives in a
separate working copy `D:\34615\飞鼠格式-win7` (NOT committed; rebuildable):

- Downgrades: `electron` 22.3.27 (last line supporting Win7, requires Win7 x64 SP1),
  `sharp` ^0.32.6 (last Node-14-compatible; N-API build loads under Electron 22's Node 16.17),
  `pdfjs-dist` 2.16.105 (3.11.x legacy build crashes under Node 16 with `Cannot read
  properties of undefined (reading 'prototype')` — core-js interop; 4.x+ needs Node 20).
- Code delta vs mainline: `server.js` `loadPdfjs()` falls back
  `.mjs` → `legacy/build/pdf.js` and normalizes `mod.default || mod`;
  `tests/electron-hardening-static.test.js` accepts Electron 22 or 43.
- package.json deltas: artifactName suffix `-win7-${arch}`, `win.target` = nsis only
  (no appx — Store is Win10+).
- Verified: `npm test` 48/48, node --check all modules, win-unpacked launches with
  engines resolved; PE header OS requirement 5.2 (Win7 6.1 OK) vs 10.0 on mainline.
- Rebuild steps: copy mainline source + `bin/` (exclude node_modules/dist/.git),
  apply the deltas above, `npm install` with the mirror env vars (see below;
  electron 22 binary may need manual download to `%LOCALAPPDATA%\electron\Cache` if
  install.js silently skips), then `npm run dist`.
- Release asset: `FlyingMouse Format-Setup-0.2.1-win7-x64.exe` on the v0.2.1 release.

Store package: `npm run dist` also targets `appx` (MSIX, for Microsoft Store). The store package currently in certification is still **v0.1.0** (`dist\FlyingMouse Format-Setup-0.1.0-x64.appx` / copy `上传商店用这个.appx`); the 0.2.x builds did not emit an appx locally — verify appx build before the next store submission. `signExecutable:false` is intentional (electron-builder's bundled signtool cannot sign .appx — the appx is either signed manually with the Windows SDK signtool or left unsigned for the Store to sign at submission). Do NOT reintroduce `signAndEditExecutable:false` — it also skips icon embedding (v0.2.0 shipped without the app icon because of it). The `appx` block in package.json holds the Partner Center identity (`identityName`, `publisher` CN, `displayName`). Full flow: docs/微软商店上架清单.md.

App icon: `build/icon.png` (512x512, 鼠鼠 avatar, transparent) — electron-builder picks it up automatically for NSIS installer, exe, taskbar, and appx store logos; effective since v0.2.1 (`signExecutable:false` keeps icon embedding). Regenerate from `public/assets/mouse-format/source-mouse-avatar.png` if the mascot changes.

## Verification

Before handing off packaging changes, run syntax checks:

```powershell
node --check server.js
node --check public\app.js
node --check electron-main.js
node --check electron-security.js
node --check preload.js
node --check logger.js
npm test
```

To diagnose a user-reported conversion failure: read the tail of `%APPDATA%\FlyingMouse Format\debug.log` (Electron userData). It records server startup (engine paths), every convert request (filename, extension, category, target, size), successes, rejected requests, engine stderr (`Command failed: ...`), and renderer-forwarded uncaught errors (`[renderer] ...`). In dev, `node server.js` logs to `%TEMP%\flyingmouse-format-debug.log`.

- Chinese-named OGG to MP3 keeps the original Chinese basename.
- Two TXT files batch-convert to HTML and show two successful queue rows.
- Packaged `dist\win-unpacked\FlyingMouse Format.exe` can perform the same conversion after `npm run dist`.
- Packaged startup reaches `Window finished loading`, and the browser console is free of application errors or warnings.
- Before public distribution, run `npm audit --omit=dev`; unresolved production advisories must be reported rather than hidden with a forced upgrade.
- Audio files (e.g. MP3) must NOT offer video container targets (mp4/webm/mkv/mov); the `targetsForExt` audio branch filters them.

Note on running tests from git-bash/MSYS: `npm test` uses `tar -tf <windows path>` in `conversion.test.js`, and the MSYS GNU tar misreads `C:\...` as a remote host, producing two false failures (`renders PDF pages to a PNG/JPG zip`). Run the test suite from cmd/PowerShell (or set PATH to prefer `C:\Windows\System32\tar.exe`) so Windows bsdtar handles the paths; the suite passes 48/48 there.

CI: GitHub Actions runs the engine-free suite (`npm run test:ci`, static/security/UI tests, 19 tests). `conversion.test.js` needs the gitignored `bin/` engines and runs locally (`npm test`, 48 tests; ncm/kgg fixture tests auto-skip when the real samples are absent). Workflow: `.github/workflows/ci.yml`.

Proprietary audio formats: `ncm-format.js` (NetEase NCM) and `kgg-format.js` (Kugou v5 KGG) convert in-place then transcode via ffmpeg. Both are verified against real official-client files (2026-08). NCM layout: magic(8)+version(1)+keyLen@10+key@14+metaLen+meta+crc(4)+unknown(5)+coverLen(4)+cover+audio; RC4 key = AES-ECB-decrypted keyBox[17..payloadEnd] (PKCS7-stripped); audio uses a one-shot 256-byte keystream variant (NOT standard continuous RC4). KGG needs the Kugou desktop key db (`%APPDATA%\KuGou8\KGMusicV3.db`, AES-CBC page decrypt + sql.js SQLite read); only songs downloaded by the local Kugou client convert. `sql.js` ships the wasm inside node_modules (asarUnpack for the packaged app). Compliance note: these capabilities must NOT be mentioned in any public-facing intro (README / store description); keep them as quiet format support.

Packaging: `build.files` is an explicit whitelist — **every new root-level JS module required by server.js must be added there** (ncm-format.js / kgg-format.js were missed once as ncm-decrypt.js/kgg-decrypt.js, causing MODULE_NOT_FOUND at runtime in the packaged app). After packaging, smoke-test `dist\win-unpacked\FlyingMouse Format.exe` (launch, confirm process stays alive) before publishing. Build from cmd with full PATH (electron-builder needs powershell.exe; a stripped PATH breaks the node-module collector). `signExecutable:false` (not signAndEditExecutable) keeps icon embedding while skipping code signing — needed for the desktop icon to update.

## Repository

- Remote: `https://github.com/LaoFeng-mouse/flyingmouse-format.git` (public)
- Author identity: `LaoFeng <LaoFeng-mouse@users.noreply.github.com>` (repo-local git config; do not commit as Codex)
- License: MIT (LICENSE file, author LaoFeng). CI: GitHub Actions runs syntax check + `npm test` + `npm audit --omit=dev` on push/PR (`.github/workflows/ci.yml`).
- Release: v0.2.1 published (latest; v0.1.0 and v0.2.0 also remain). Installer asset `FlyingMouse.Format-Setup-0.2.1-x64.exe` (SHA-256 1DEC8245...) matches local `dist\FlyingMouse Format-Setup-0.2.1-x64.exe`. Release notes must not mention proprietary audio format support.
- Desktop shortcut: `C:\Users\34615\Desktop\FlyingMouse Format.lnk` → `dist\win-unpacked\FlyingMouse Format.exe`（2026-08-07 重建；NSIS 安装器 `createDesktopShortcut: true` 正式安装时也会自动创建）。After repacking, rebuild the shortcut and refresh the icon cache (`ie4uinit -show`; if stubborn, delete `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db` and restart explorer).
