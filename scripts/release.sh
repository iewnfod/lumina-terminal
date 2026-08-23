#!/usr/bin/env bash
#
# release.sh — Lumina Terminal 一键发布脚本
#
# 用法:
#   ./scripts/release.sh 0.2.2            完整发布(推荐)
#   ./scripts/release.sh                  自动推断版本号并发布(feat → minor, fix → patch)
#   ./scripts/release.sh 0.2.2 --dry-run  演练:只打印将要执行的命令,不实际执行
#   ./scripts/release.sh --notes-only     只生成 Release Note(不 bump / 不发布)
#   ./scripts/release.sh --publish        用已生成的 notes.md 创建 GitHub Release
#
# 完整发布流程:
#   1. 检查工作区干净
#   2. 确定版本号并 bump(bump-version.sh 同步四处:package.json / Cargo.toml /
#      tauri.conf.json / Cargo.lock,并跑 cargo test 把关)
#   3. commit + tag + push(直连失败自动走代理)
#   4. 按 docs/RELEASE_PROMPT.md 用 AI 生成 Release Note(claude CLI)
#   5. 创建 GitHub Release → 触发 release.yml 自动构建 + AUR 推送
#
# 依赖:
#   - bump-version.sh(同目录)
#   - claude CLI(生成 Release Note;没有则只生成任务文件)
#   - gh CLI(建 Release;没有则提示手动,不影响前面步骤)
#
# 注意:Release Note 的 Prompt 每次运行从 docs/RELEASE_PROMPT.md 读取,不硬编码。

set -euo pipefail

# 脚本在 scripts/ 下,仓库根目录是它的上一级
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROMPT_FILE="docs/RELEASE_PROMPT.md"
NOTES_FILE="notes.md"
REMOTE_BRANCH="master"
PROXY="http://127.0.0.1:7890"

MODE="full"
DRY_RUN=0
VERSION=""

# ---- 输出工具 --------------------------------------------------------------
C_RESET=$'\033[0m'; BOLD=$'\033[1m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_CYAN=$'\033[36m'; C_YELLOW=$'\033[33m'
log()  { printf "%s▸%s %s\n" "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf "%s✓%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
die()  { printf "%s✗%s %s%s%s\n" "$C_RED" "$C_RESET" "$C_RED" "$*" "$C_RESET" 1>&2; exit 1; }

# 在 dry-run 模式下只打印,否则执行
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf "  %s[dry-run]%s %s\n" "$C_YELLOW" "$C_RESET" "$*"
  else
    "$@"
  fi
}

# ---- 参数解析 --------------------------------------------------------------
parse_args() {
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      --notes-only) MODE="notes-only" ;;
      --publish) MODE="publish" ;;
      --help|-h)
        sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
      -*) die "未知参数: $arg(用 --help 查看用法)" ;;
      *) [ -z "$VERSION" ] && VERSION="$arg" || die "多余参数: $arg" ;;
    esac
  done
}

# ---- 版本工具 --------------------------------------------------------------
# 从 commit 历史推断下一个版本(semver:feat → minor,纯 fix → patch)
infer_version() {
  local prev cur ma mi pa
  prev="$(git tag --sort=-creatordate | head -1 || true)"
  [ -n "$prev" ] || die "没有历史 tag,无法推断版本,请显式指定 ./scripts/release.sh <version>"
  cur="${prev#v}"
  IFS='.' read -r ma mi pa <<< "$cur"
  if git log "$prev..HEAD" --oneline 2>/dev/null | grep -qE '^[0-9a-f]+ feat'; then
    echo "$ma.$((mi + 1)).0"
  else
    echo "$ma.$mi.$((pa + 1))"
  fi
}

check_clean() {
  [ -z "$(git status --porcelain)" ] || die "工作区有未提交改动,先提交或 stash: git status"
  ok "工作区干净"
}

# ---- 发布步骤 --------------------------------------------------------------
do_bump() {
  log "bump 版本: $CURRENT → $VERSION"
  run scripts/bump-version.sh "$VERSION"
}

do_commit() {
  log "提交 + 打 tag"
  run git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock
  run git commit -m "update: v$VERSION"
  run git tag "v$VERSION"
}

do_push() {
  log "推送(直连失败自动走代理)"
  if [ "$DRY_RUN" = "1" ]; then
    run git push origin "$REMOTE_BRANCH" "v$VERSION"
    return
  fi
  if git push origin "$REMOTE_BRANCH" "v$VERSION" 2>/dev/null; then
    ok "推送成功(直连)"
  else
    log "直连失败,走代理重试..."
    git push -c http.proxy="$PROXY" origin "$REMOTE_BRANCH" "v$VERSION"
    ok "推送成功(代理)"
  fi
}

# ---- Release Note 生成 -----------------------------------------------------
# 每次运行读取 docs/RELEASE_PROMPT.md,交给 claude 在项目目录执行
generate_notes() {
  [ -f "$PROMPT_FILE" ] || die "缺少 $PROMPT_FILE(Release Note 的 Prompt 定义文件)"
  log "读取 $PROMPT_FILE 生成 Release Note"

  if [ "$DRY_RUN" = "1" ]; then
    run claude -p "\$(cat $PROMPT_FILE)" --output-format text "> $NOTES_FILE"
    return
  fi

  if command -v claude >/dev/null 2>&1; then
    # 读取 Prompt 文件(每次运行,不硬编码),追加一条 CLI 输出纪律:
    # 只输出 Release Note 正文,不要过程说明/分析/总结
    local prompt
    prompt="$(cat "$PROMPT_FILE")"
    prompt+="

---
IMPORTANT OUTPUT DISCIPLINE: Output ONLY the Release Note markdown itself. Do not include any preamble, scope analysis, progress notes, or trailing summary — nothing outside the note."
    claude -p "$prompt" --output-format text > "$NOTES_FILE"
    [ -s "$NOTES_FILE" ] || die "$NOTES_FILE 为空,AI 生成失败?"
    ok "已生成 $NOTES_FILE($(wc -l < "$NOTES_FILE") 行)"
  else
    cp "$PROMPT_FILE" /tmp/lumina-release-note-task.md
    die "未找到 claude CLI。请把 /tmp/lumina-release-note-task.md 交给 AI 生成 notes.md,然后运行 ./scripts/release.sh --publish"
  fi
}

# ---- 创建 GitHub Release ---------------------------------------------------
create_release() {
  local tag="v$VERSION"
  if [ "$DRY_RUN" = "1" ]; then
    run gh release create "$tag" --notes-file "$NOTES_FILE"
    return
  fi
  [ -f "$NOTES_FILE" ] || die "缺少 $NOTES_FILE,先运行 ./scripts/release.sh --notes-only 或完整发布"
  if gh auth status >/dev/null 2>&1; then
    gh release create "$tag" --notes-file "$NOTES_FILE"
    ok "Release $tag 已创建,CI 将自动构建并推送 AUR"
  else
    log "gh CLI 不可用,请在网页手动创建 Release:"
    echo "  https://github.com/iewnfod/lumina-terminal/releases/new?tag=$tag"
    echo "  Release Note 已就绪: $NOTES_FILE(直接粘贴)"
  fi
}

# ---- 主流程 ----------------------------------------------------------------
main() {
  parse_args "$@"

  case "$MODE" in
    notes-only)
      generate_notes
      exit 0
      ;;
    publish)
      [ -n "$VERSION" ] || VERSION="$(infer_version)"
      create_release
      exit 0
      ;;
  esac

  if [ "$DRY_RUN" != "1" ]; then
    check_clean
  else
    log "dry-run 模式,跳过工作区检查"
  fi
  CURRENT="$(scripts/bump-version.sh --show)"
  if [ -z "$VERSION" ]; then
    VERSION="$(infer_version)"
    log "未指定版本,按 commit 推断: $CURRENT → $VERSION"
  fi

  do_bump
  do_commit
  do_push
  generate_notes
  create_release

  echo
  ok "发布完成: v$VERSION"
  log "后续: CI(release.yml)自动构建各平台产物,完成后 aur-trigger.yml 自动推送 AUR"
}

main "$@"
