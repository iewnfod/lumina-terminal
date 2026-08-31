# 任务：为 Lumina Terminal 生成 Release Note

从 git tag `<上一个 tag>`（例如 v0.2.0）到当前 HEAD 生成一份 GitHub Release Note，遵循项目既定的标准格式。

## 步骤

1. 运行以下命令收集信息：
    - `git tag --sort=-creatordate` — 确认所有 tag，检查区间内是否存在中间 tag
    - `git log <上一个 tag>..HEAD --format="%h %s (%an)" --no-decorate` — 获取 commit 列表
    - 对语义不清晰的 commit，用 `git show <hash> --stat --format="%B"` 查看改动范围和详情
    - 对重大特性，可查看关键文件了解功能实际行为
2. 如果区间内有未发布的中间 tag（如测试版本），需特别处理：跳过该 tag 本身，但要说明跳过的原因
3. 分类所有 commit，并过滤噪音：
    - **跳过**：版本号 commit（`update: vX.Y.Z`）、纯 merge commit、测试性 docs（如 "test mark update"、"remove cat test content"）
    - **归入分类**：其余按功能、修复、性能、样式、杂项、文档归类
4. 将同一领域的多个 commit 合并为一条 bullet（例如同一功能的多个 fix 合并成一条）
5. 区分贡献者：主仓库提交不需要署名；PR 合并的提交在条目末尾标注 `(by @GitHub用户名)`

## 输出格式
```
### ✨ Features
- **加粗的功能名** — 详细说明，包含实际使用场景和关键细节

### ⚡ Performance
- 性能改进的具体数据或场景

### 🐛 Bug Fixes
- 修复内容及影响场景

### 🎨 Polish
- UI 样式和交互细节优化

### 🔧 Chores
- CI、构建、发布流程变更

**Full Changelog**: https://github.com/iewnfod/lumina-terminal/compare/${上个版本号}...${新的版本号}
```

## 写作规则

- 输出**英文**
- 每个 bullet 的第一句是完整句子，说明"改了什么、对用户意味着什么"
- 不逐条翻译 commit message，要按用户价值重组
- 修复类条目说明"之前的问题是什么"，特性类条目说明"现在能做什么"
- 技术细节（协议名、命令名、快捷键）保留原文，如 `Ctrl+Shift+F`、`~/.ssh/config`
- 每条 bullet 不宜超过 3 行

## 特殊场景

- **版本号不确定**：从 commit 历史推断下一个版本号（遵循 semver：新特性 → minor，纯修复 → patch）
- **区间包含跳过的 tag**（如测试版 v0.1.3）：在标题下加一行斜体说明 `*vX.Y.Z was an internal test build and has been skipped.*`
- **无新 commit**：明确回复"区间内没有新提交"

## 样例
一份合格的 Release Note 样例如下：
```markdown
### ✨ Features

- **Read-only MCP server** — Lumina can now run as a local MCP (Model Context Protocol) server over a Streamable HTTP endpoint on 127.0.0.1, giving AI agents a window into your terminal: list tabs, read recent output, and inspect the foreground command. Deliberately read-only by design — there is no tool that can write to your PTY, so agents can observe but never act on your terminal
- **Alacritty-style CLI arguments** — Launch Lumina with flags that shape the first tab: `--command vim`, `--working-directory ~/proj`, `--title dev`, `--hold`, `--profile main`. Combined with `--command` + `--hold`, this also makes Lumina usable as a quick launcher for single-command sessions
- **Empty state page** — Closing the last tab (with "keep window on last tab closed" enabled) now shows a centered quick-launch page listing your profiles with shell icons, the default profile's new-tab shortcut hint, and a full window drag region — instead of a blank void. Profile order and count limits are respected
- **Default light & dark terminal themes** — Each profile now gets coherent light/dark theme pairs out of the box, so toggling UI mode also gives the terminal a matching palette without manual theming
- **Tech stack modal** — The About page's technology list moved into a dedicated modal backed by a single `techStack.ts` data source shared with the README, so the two can no longer drift apart
- **WebKitGTK IME duplicate-input fix** — Fixed duplicated characters when typing through IBus/fcitx on Linux. The fix normalizes xterm's unmatched keyCode-229 IME fallback via an `imeCompositionGuard` (config-gated `imeDuplicateInputFix`, on by default), plus a local backport patch vendoring two upstream xterm.js IME fixes (#5439 + #5698) while staying pinned to stable 6.0.0 (by @Keyneswu)

### 🐛 Bug Fixes

- Fixed empty state page sizing so the main window matches the default profile's terminal dimensions
- Fixed shell exit-code / foreground-command tracking used by the MCP tools and command subtitle

### 📚 Docs

- Added community & publicity links to the README

**Full Changelog**: https://github.com/iewnfod/lumina-terminal/compare/v0.2.1...v0.2.2
```
