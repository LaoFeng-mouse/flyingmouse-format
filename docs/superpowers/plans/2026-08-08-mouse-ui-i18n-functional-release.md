# FlyingMouse Format Mouse UI Bilingual Functional Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the original mouse UI as the GitHub main product while retaining NCM/AV3A and operation-memory features, add persistent Chinese/English language settings, and ship a fully verified v0.3.1.

**Architecture:** Use `fb62e3a` only as the visual/state-machine reference for `public/`; retain current backend and security code. Put language state and translation lookup in a standalone browser/CommonJS module, then wire static and dynamic renderer text to translation keys. Release validation covers unit tests, real NCM samples, packaged conversion, bilingual screenshots, desktop target, GitHub main, and Release assets.

**Tech Stack:** Electron 43, Node.js, browser DOM/localStorage, node:test, electron-builder, FFmpeg, AVS3-P3 helper.

---

### Task 1: Add the persistent bilingual language model

**Files:**
- Create: `public/i18n.js`
- Create: `tests/i18n.test.js`
- Modify: `package.json`

- [ ] Write failing tests importing `public/i18n.js` and asserting `normalizeLanguage("zh-CN") === "zh-CN"`, `normalizeLanguage("en-GB") === "en-US"`, saved choice precedence, system-language fallback, blocked-storage fallback, and translation lookup fallback.
- [ ] Run `node --test tests/i18n.test.js`; expect `MODULE_NOT_FOUND`.
- [ ] Implement UMD/CommonJS exports `LANGUAGE_STORAGE_KEY`, `normalizeLanguage`, `readLanguage`, `saveLanguage`, `translate`, and `createI18n`; store only `zh-CN` or `en-US` under `flyingmouse.language.v1`.
- [ ] Add the focused test to `npm test` and `npm run test:ci`.
- [ ] Run `node --test tests/i18n.test.js`; expect all language-model cases to pass.

### Task 2: Restore the original mouse interface without reverting functionality

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `public/app.js`
- Modify: `tests/ui-static.test.js`
- Modify: `tests/mouse-assets.test.js`

- [ ] Add failing static assertions that the page references `source-mouse-avatar.png`, contains `mouseMascot`, `mouseStatus`, the original mouse workflow classes, `languageSelect`, and loads `/i18n.js` before `/app.js`; remove the assertions that ban mouse UI.
- [ ] Run `node --test tests/ui-static.test.js tests/mouse-assets.test.js`; expect failures because current main uses the neutral/Xianyu layout.
- [ ] Reconstruct `index.html` and `styles.css` from `git show fb62e3a:public/index.html` and `git show fb62e3a:public/styles.css`, preserving current IDs required by `app.js`, workflow, batch, progress, download buttons, CSP-compatible assets, and the new language selector.
- [ ] Restore the mouse state table from `fb62e3a:public/app.js` for `idle`, `upload`, `analyzing`, `converting`, `batch`, `ocr`, `pdf-pages`, `success`, and `error`, while retaining `preferredTarget()` restoration and `rememberTarget()` updates.
- [ ] Run the two focused static suites; expect all assertions to pass.

### Task 3: Translate static and dynamic renderer behavior

**Files:**
- Modify: `public/i18n.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `tests/i18n.test.js`
- Modify: `tests/ui-static.test.js`

- [ ] Extend failing tests with representative translation keys for workflow, upload, target, convert, save, status, mouse status, batch success/failure, and tool capability text; assert missing English keys fall back to Chinese then the key.
- [ ] Run focused tests and observe missing-key failures.
- [ ] Add `data-i18n`/`data-i18n-aria` attributes for static elements and implement `applyLanguage(language)` to update DOM text, option labels, aria labels, `document.documentElement.lang`, and the selector.
- [ ] Replace renderer-owned dynamic Chinese strings with `t(key, params)` calls; wrap raw backend details with localized operation-level messages instead of altering diagnostic text.
- [ ] On selector change call `saveLanguage(localStorage, value)`, apply immediately, and rerender current file/status state without starting conversion.
- [ ] Run `node --test tests/i18n.test.js tests/ui-static.test.js tests/mouse-assets.test.js`; expect all cases to pass.

### Task 4: Publish an accurate bilingual project description

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/HANDOFF.md`
- Test: `tests/electron-hardening-static.test.js`

- [ ] Add failing static checks for package version `0.3.1`, bilingual README anchors, the large-engine source-clone limitation, unsigned warning, and neutral Audio Vivid compatibility notice.
- [ ] Run the static test and observe failures on version/README content.
- [ ] Rewrite README with complete Chinese and English sections covering privacy, formats, quick start, system requirements, source-build limitations, third-party engines, and release downloads; do not advertise DRM circumvention.
- [ ] Set both package files to `0.3.1` and record the corrected mouse-edition release boundary in `docs/HANDOFF.md`.
- [ ] Run static tests and `git diff --check`.

### Task 5: Full functional, visual, package, desktop, and GitHub acceptance

**Files:**
- Test: `tests/*.test.js`
- Build output: `dist/FlyingMouse Format-Setup-0.3.1-x64.exe`
- Desktop shortcut: `%USERPROFILE%/Desktop/FlyingMouse Format.lnk`

- [ ] Run `npm test`; require zero failures.
- [ ] Run the opt-in real AV3A test against the three supplied NCM paths using project-bundled AV3A and FFmpeg resources; require FFmpeg full-file decode success.
- [ ] Run `npm run dist` with signing auto-discovery disabled; inspect `app.asar`, `resources/avs3`, binary hashes, installer version and SHA256.
- [ ] Launch `win-unpacked` with an isolated user-data directory, verify server/window startup, convert one supplied AV3A NCM through the packaged HTTP API, and fully decode the MP3.
- [ ] Capture Chinese and English renderer screenshots; verify mouse art is visible, text fits, controls do not overlap, and workflow remains usable.
- [ ] Back up the existing desktop shortcut, update it to the v0.3.1 `win-unpacked` EXE, launch from the shortcut, and verify the product version; do not alter mouse-print shortcuts.
- [ ] Commit all changes, push `main` through the existing local Mihomo proxy only for the command, publish `v0.3.1` with installer and SHA256, and confirm GitHub `main`, `releases/latest`, asset size and digest by API readback.
