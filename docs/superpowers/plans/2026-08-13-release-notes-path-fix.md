# Release Notes Path Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the v0.5.0 GitHub Release body and make future tag workflows select the matching versioned release-notes file reliably.

**Architecture:** Add one focused Node.js CLI that maps a strict `vMAJOR.MINOR.PATCH` tag to `docs/release-notes-MAJORMINORPATCH.md`, preserving the `.md` extension and falling back to `docs/RELEASE.md` only when the versioned file is absent. The GitHub Actions workflow delegates path selection to this tested CLI.

**Tech Stack:** Node.js 22, `node:test`, GitHub Actions YAML, GitHub CLI.

---

### Task 1: Add failing release-notes resolver tests

**Files:**
- Modify: `tests/ci-engine-release.test.js`
- Test: `tests/ci-engine-release.test.js`

- [ ] **Step 1: Write failing CLI behavior tests**

Add tests that invoke `scripts/resolve-release-notes.js` with `spawnSync` against a temporary repository root. Cover an existing `docs/release-notes-050.md`, fallback to `docs/RELEASE.md`, and rejection of a malformed tag.

```js
const resolverScript = path.join(root, 'scripts', 'resolve-release-notes.js');

test('release notes resolver preserves the markdown extension', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flyingmouse-release-notes-'));
  fs.mkdirSync(path.join(fixtureRoot, 'docs'));
  fs.writeFileSync(path.join(fixtureRoot, 'docs', 'release-notes-050.md'), '# v0.5.0');

  const result = spawnSync(process.execPath, [resolverScript, 'v0.5.0', fixtureRoot], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'docs/release-notes-050.md');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/ci-engine-release.test.js`

Expected: FAIL because `scripts/resolve-release-notes.js` does not exist and the child process exits nonzero.

- [ ] **Step 3: Commit the failing tests**

```powershell
git add -- tests/ci-engine-release.test.js
git commit -m "test: 覆盖发布说明路径解析"
```

### Task 2: Implement the resolver and connect the workflow

**Files:**
- Create: `scripts/resolve-release-notes.js`
- Modify: `.github/workflows/release.yml`
- Modify: `tests/ci-engine-release.test.js`

- [ ] **Step 1: Implement the minimal resolver**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function resolveReleaseNotes(tag, repositoryRoot) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Invalid release tag: ${tag}`);
  }
  const compactVersion = tag.slice(1).replaceAll('.', '');
  const versionedNotes = `docs/release-notes-${compactVersion}.md`;
  return fs.existsSync(path.join(repositoryRoot, versionedNotes))
    ? versionedNotes
    : 'docs/RELEASE.md';
}

const tag = process.argv[2];
const repositoryRoot = path.resolve(process.argv[3] || process.cwd());
process.stdout.write(`${resolveReleaseNotes(tag, repositoryRoot)}\n`);
```

- [ ] **Step 2: Replace the broken YAML string manipulation**

Replace:

```bash
NOTES="docs/release-notes-${TAG#v}.md"
NOTES="${NOTES//./}"
[ -f "$NOTES" ] || NOTES="docs/RELEASE.md"
```

with:

```bash
NOTES="$(node scripts/resolve-release-notes.js "$TAG")"
```

- [ ] **Step 3: Add workflow integration assertions**

Assert that `.github/workflows/release.yml` invokes the resolver and no longer contains `${NOTES//./}`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test tests/ci-engine-release.test.js`

Expected: all tests pass with exit code 0.

- [ ] **Step 5: Commit the implementation**

```powershell
git add -- scripts/resolve-release-notes.js .github/workflows/release.yml tests/ci-engine-release.test.js
git commit -m "fix: 正确选择版本发布说明"
```

### Task 3: Verify v0.5.0 release-note accuracy

**Files:**
- Modify if required: `docs/release-notes-050.md`

- [ ] **Step 1: Cross-check user-facing claims against tagged code**

Inspect `git log --oneline v0.4.1..v0.5.0` and relevant diffs for KGMA, PDF to Word, PDF to Excel, video codecs, `.mmp4`, update visibility, macOS/Win7 updater behavior, and Store-only capability filtering.

- [ ] **Step 2: Keep claims channel-specific**

Retain the six verified user-facing additions/fixes. Add a concise channel section for macOS/Win7 automatic-update disabling and Store encrypted-audio filtering only if those facts are not already clear.

- [ ] **Step 3: Run documentation checks**

Run: `rg -n "v0\.3\.5|v0\.3\.4|Submission 2|release-notes-050md" docs/release-notes-050.md`

Expected: no stale-version or malformed-path matches.

### Task 4: Full verification and review

**Files:**
- Verify all changed files

- [ ] **Step 1: Run complete tests**

Run: `npm test`

Expected: exit code 0 with no real failures.

- [ ] **Step 2: Run release-specific and repository checks**

```powershell
node scripts/resolve-release-notes.js v0.5.0
git diff --check
git status -sb
```

Expected resolver output: `docs/release-notes-050.md`; diff check exits 0; status contains only intended changes.

- [ ] **Step 3: Request independent code review**

Review the implementation against the design and this plan. Resolve every Critical or Important finding before publishing.

### Task 5: Correct GitHub and publish the code fix

**Files:**
- Remote Release: `v0.5.0`
- Branch: `codex/fix-release-notes-path`

- [ ] **Step 1: Snapshot current Release identity and assets**

Run `gh release view v0.5.0 --repo LaoFeng-mouse/flyingmouse-format --json tagName,isDraft,isPrerelease,publishedAt,url,assets,body` and retain asset names, sizes, and digests for comparison.

- [ ] **Step 2: Update only the Release body**

Run `gh release edit v0.5.0 --repo LaoFeng-mouse/flyingmouse-format --notes-file docs/release-notes-050.md`.

- [ ] **Step 3: Re-read the Release**

Confirm the body begins with `## FlyingMouse Format v0.5.0`, the Release remains public/Latest/non-prerelease, and all asset names, sizes, and digests are unchanged.

- [ ] **Step 4: Push the branch and open a draft PR**

Push `codex/fix-release-notes-path` and open a draft PR to `main` describing the root cause, regression test, and verification evidence.
