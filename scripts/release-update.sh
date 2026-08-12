#!/usr/bin/env bash
# ============================================================
# 飞鼠格式 v0.3.6+ 半自动发布脚本（Windows NSIS 自动更新闭环）
# 功能：打包 → 上传 exe+latest.yml+.blockmap 到 GitHub Release → 设为 Latest
# 用法：
#   bash scripts/release-update.sh            # 发布当前版本（版本号从 package.json 读）
#   bash scripts/release-update.sh --check    # 只检查环境，不打包不发布
# 说明：
#   - win7/macOS 包需 CI workflow 构建下载，本脚本只处理 Windows x64 自动更新资产
#   - 不会 force 覆盖历史 tag；tag 已存在且指向非当前 HEAD 时报错退出
#   - 需要 gh 已登录（gh auth status）且 git 工作树干净
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."

log() { echo "[release] $*"; }
die() { echo "[release] ERROR: $*" >&2; exit 1; }

CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then CHECK_ONLY=1; fi

# ---------- 1. 环境检查 ----------
command -v node >/dev/null || die "node 不在 PATH（需 D:\\Program Files\\nodejs）"
command -v gh >/dev/null || die "gh CLI 未安装"
gh auth status >/dev/null 2>&1 || die "gh 未登录"
[[ -d node_modules/electron-updater ]] || die "缺少 electron-updater 依赖，先 npm install"

VERSION=$(node -p "require('./package.json').version")
log "当前版本: v$VERSION"

# ---------- 2. 工作树检查 ----------
if [[ $CHECK_ONLY -eq 0 ]]; then
  DIRTY=$(git status --porcelain | grep -v '^??' || true)
  if [[ -n "$DIRTY" ]]; then
    die "工作树有未提交修改，先提交再发布：\n$DIRTY"
  fi
fi

# ---------- 3. tag 检查 ----------
TAG="v$VERSION"
HEAD=$(git rev-parse HEAD)
TAG_COMMIT=$(git rev-parse "$TAG" 2>/dev/null || echo "")
if [[ -n "$TAG_COMMIT" && "$TAG_COMMIT" != "$HEAD" ]]; then
  die "tag $TAG 已存在但指向 $TAG_COMMIT（当前 HEAD=$HEAD）。如需修正请手动处理，脚本不会覆盖历史标签。"
fi
log "tag $TAG 将指向 $HEAD"

if [[ $CHECK_ONLY -eq 1 ]]; then
  log "环境检查通过（--check，未打包未发布）"
  exit 0
fi

# ---------- 4. 打包 ----------
log "开始打包 npm run dist（NSIS + APPX，约 10 分钟）..."
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist

# ---------- 5. 产物校验 ----------
EXE="dist/FlyingMouse Format-Setup-${VERSION}-x64.exe"
[[ -f "$EXE" ]] || die "未找到安装包: $EXE"
[[ -f dist/latest.yml ]] || die "未找到 latest.yml"
BLOCKMAP=$(ls dist/*.blockmap 2>/dev/null | head -1)
[[ -n "$BLOCKMAP" ]] || die "未找到 .blockmap"

LATEST_VER=$(grep '^version:' dist/latest.yml | head -1 | awk '{print $2}')
[[ "$LATEST_VER" == "$VERSION" ]] || die "latest.yml 版本不匹配: $LATEST_VER != $VERSION"
log "产物 OK: $EXE / latest.yml(v$LATEST_VER) / $(basename "$BLOCKMAP")"

# ---------- 6. tag + Release ----------
if [[ -z "$TAG_COMMIT" ]]; then
  log "创建并推送 tag $TAG"
  git tag "$TAG"
  git -c http.proxy=http://127.0.0.1:7897 push origin "$TAG"
fi

NOTES="## FlyingMouse Format v$VERSION

（发布说明请在此填写，或用 --notes-file 传入）
- Windows x64 安装包 + 自动更新（latest.yml/blockmap）
- win7/macOS 包由 CI 构建后另行上传"

if gh release view "$TAG" >/dev/null 2>&1; then
  log "Release $TAG 已存在，跳过创建"
else
  log "创建 Release $TAG（draft）"
  gh release create "$TAG" --draft --title "FlyingMouse Format v$VERSION" --notes "$NOTES"
fi

# ---------- 7. 上传资产 ----------
log "上传安装包 + latest.yml + blockmap"
SAFE_EXE="FlyingMouse-Format-Setup-${VERSION}-x64.exe"
cp "$EXE" "/tmp/${SAFE_EXE}"
cp dist/latest.yml /tmp/release-latest.yml
cp "$BLOCKMAP" "/tmp/${SAFE_EXE}.blockmap"
gh release upload "$TAG" "/tmp/${SAFE_EXE}" /tmp/release-latest.yml "/tmp/${SAFE_EXE}.blockmap" --clobber

# ---------- 8. 公开并设 Latest ----------
log "公开 Release 并设为 Latest"
gh release edit "$TAG" --draft=false --latest

# ---------- 9. 回读验证 ----------
log "==== 回读验证 ===="
gh release view "$TAG" --json isDraft,isPrerelease,assets --jq '{isDraft, isPrerelease, assets: [.assets[].name]}'
gh release list --limit 1
log "完成。自动更新元数据已就位：老用户打开软件即会收到 v$VERSION 更新提示。"
