# 配置参考 Configuration Reference

> <a href="./Configuration_zh.md">简体中文</a> | <a href="./Configuration.md">English</a>

Lumina Terminal 的全部设置都保存在一个 JSON 文件（`config.json`）中。设置界面（`Ctrl/Cmd + ,`）能修改其中大部分；本文同时列出**仅能通过编辑 config.json 修改**的字段（标注「无 UI」），以及由程序自动写入、一般不需要手动改的字段（标注「运行时写入」）。

> 编辑 config.json 前**先完全退出 Lumina**：应用运行期间会随时把内存中的配置写回该文件（例如移动窗口、打开配置文件时），手动修改会被覆盖。

## 目录

- [1. 配置文件位置](#1-配置文件位置)
- [2. 文件结构](#2-文件结构)
- [3. 全局设置 GlobalConfig](#3-全局设置-globalconfig)
- [4. 配置文件 Profile（profiles）](#4-配置文件-profileprofiles)
- [5. 渲染选项 TerminalRenderOptions](#5-渲染选项-terminalrenderoptions)
- [6. 主题文件（themePath / theme）](#6-主题文件themepath--theme)
- [7. 快捷键（bindings）](#7-快捷键bindings)
- [8. 命令图标规则（commandIcons）](#8-命令图标规则commandicons)
- [9. 封装为应用（profiles[].launcher）](#9-封装为应用profileslauncher)
- [10. 完整示例](#10-完整示例)
- [11. 相关文件](#11-相关文件)

---

## 1. 配置文件位置

| 系统 | 路径 |
|------|------|
| Linux | `~/.local/share/com.iewnfod.lumina-terminal/config.json` |
| macOS | `~/Library/Application Support/com.iewnfod.lumina-terminal/config.json` |
| Windows | `%APPDATA%\com.iewnfod.lumina-terminal\config.json` |

也可以在应用内查看/打开：**设置 → General → 开发者 → Config File Path**。

## 2. 文件结构

config.json 顶层只有一个键 `"config"`，所有设置都嵌在它下面（这是插件商店格式，不是笔误）：

```json
{
    "config": {
        "language": "zh-cn",
        "profiles": [],
        "themeMode": "terminal"
    }
}
```

- 加载时，文件中出现的键会覆盖内置默认值；没写的键用默认值。删掉某个键即可恢复其默认值。
- 手动添加未知键没有副作用，但也不会生效。

## 3. 全局设置 GlobalConfig

### 基础

| 键 | 类型 | 默认值 | UI 位置 | 说明 |
|----|------|--------|---------|------|
| `language` | `"en-us" \| "zh-cn"` | `"en-us"` | 设置 → General → 基础 | 界面语言。 |
| `autoUpdateOnStartup` | boolean | `true` | 设置 → General → 基础 | 启动时自动检查更新。 |

### 外观

| 键 | 类型 | 默认值 | UI 位置 | 说明 |
|----|------|--------|---------|------|
| `themeMode` | `"system" \| "terminal" \| "light" \| "dark"` | `"terminal"` | 设置 → General → 外观 | 应用亮/暗**渲染**的判定方式（文字、图标、玻璃材质、弹层），见下文说明。 |
| `enableColorSpread` | boolean | `false` | 设置 → General → 外观 | 颜色扩散：开启后，全屏 TUI 的单一背景色会「铺满」整个窗口边框（侧边栏、标题栏、窗口背景跟随）；关闭则窗口 chrome 保持终端主题的背景色（取样仍在后台进行，用于终端内部的无缝填充，只是不再向外传播）。 |
| `edgeBackgroundCoverage` | number | `0.9` | **无 UI** | 边缘取样时，一种颜色至少要占外圈取样格子的多少比例才算「TUI 背景」（其余格子视为贴边字符而忽略）。取值 `(0, 1]`；`1` 恢复严格的「全部格子同色」行为。非法值回落到默认。 |

**`themeMode` 取值说明**（背景色始终跟随终端 / 全屏 TUI，此键只控制界面元素的亮暗渲染）：

- `"system"` —— 跟随操作系统的亮暗偏好。
- `"terminal"` —— 从终端背景色推导（历史默认行为）。
- `"light"` / `"dark"` —— 强制亮色 / 暗色。强制时全屏 TUI 也不能把窗口「染」成另一种亮暗。

### 窗口

| 键 | 类型 | 默认值 | UI 位置 | 说明 |
|----|------|--------|---------|------|
| `rememberWindowPosition` | boolean | `false` | 设置 → General → 窗口 | 启动时恢复主窗口上次的屏幕位置（仅主窗口；撕脱出的新窗口由撕脱动作定位）。Wayland 下不支持，UI 中置灰。 |
| `rememberWindowSize` | boolean | `false` | 设置 → General → 窗口 | 启动时恢复主窗口上次的大小。 |
| `rememberedWindowPosition` | `{x, y}` | — | **运行时写入** | 主窗口上次位置（物理像素）。`rememberWindowPosition` 开启时由移动监听写入，启动时读取一次。 |
| `rememberedWindowSize` | `{width, height}` | — | **运行时写入** | 主窗口上次大小（物理像素），同上。 |

### 标签页

| 键 | 类型 | 默认值 | UI 位置 | 说明 |
|----|------|--------|---------|------|
| `showTabBar` | boolean | `false` | 设置 → General → 标签页 | 是否显示侧边栏标签列表（也可用快捷键或 `--sidebar` 启动参数临时切换）。 |
| `closeWindowOnLastTab` | boolean | `true` | 设置 → General → 标签页 | 关闭最后一个标签时是否关闭窗口。设为 `false` 时保留空窗口并显示配置文件快捷启动页（Empty State）。 |
| `inheritWorkingDirectory` | boolean | `false` | 设置 → General → 行为 | 开启后，新建标签继承**当前活动终端**的工作目录（而非配置文件默认目录），在多个 shell/配置间切换不用重新 `cd`。只影响新建标签；窗口的第一个标签没有可继承的活动终端，仍用配置文件默认值。 |

### 会话（退出保存 / 启动恢复）

| 键 | 类型 | 默认值 | UI 位置 | 说明 |
|----|------|--------|---------|------|
| `sessionSaveMode` | `"never" \| "always" \| "ask"` | `"ask"` | 设置 → General → 会话 | 退出时如何处理打开的标签页，见下文说明。 |
| `sessionSaveScrollback` | boolean | `false` | 设置 → General → 会话 | 保存会话时同时序列化每个终端的回滚缓冲，恢复时回放。会显著增大 session.json，谨慎开启。只在真正发生保存时被读取（`always`，或 `ask` 且用户选了保存）。 |
| `loadDefaultProfileOnStartup` | boolean | `true` | 设置 → General → 会话 | 启动时没有可恢复内容时，是否用默认配置文件开一个标签。只在 `sessionSaveMode: "never"` 时生效；开启保存后，启动总是先尝试恢复会话（首次运行则播种默认标签）。 |

**`sessionSaveMode` 取值说明**：

- `"never"` —— 从不保存。
- `"always"` —— 关窗时总是保存全部终端标签，下次启动恢复。
- `"ask"` —— 每次关窗时弹窗询问；对话框里的「记住这次选择」会把此值改写为 `always` 或 `never`。

保存的会话存在独立的 `session.json` 中（见[相关文件](#11-相关文件)），不写入 config.json。

### 行为

| 键 | 类型 | 默认值 | UI 位置 | 说明 |
|----|------|--------|---------|------|
| `imeDuplicateInputFix` | boolean | `true` | 设置 → General → 行为 | 输入法重复输入修复：在终端的隐藏输入框上安装守卫，归一化 WebKitGTK/IBus 没有配对 compositionstart 的提交，避免 Linux 上中文等 IME 输入重复。该守卫在每次此类提交时重写输入框，低速机器上可能略微影响 IME 跟手度——觉得输入法变慢可以关掉（关掉后 Linux/WebKitGTK 上可能重新出现重复输入）。 |
| `autoProxy` | boolean | `true` | 设置 → General → 行为 | 自动同步代理：监听系统代理（GNOME gsettings / KDE kioslaverc / macOS scutil / Windows 注册表），把 `http_proxy`、`HTTPS_PROXY` 等环境变量同步进每个运行中的 bash/zsh/fish 标签——由 shell 集成的 precmd 钩子在每次出提示符前静默应用，无需重启。只会撤销 Lumina 自己注入的值，手动 export 的代理不会被碰。nu/pwsh/SSH 等没有集成的 shell 不受影响。关闭时停止监听并删除钩子的 env 文件，运行中的 shell 会去掉（且仅去掉）Lumina 注入的值。 |

### AI / MCP

| 键 | 类型 | 默认值 | UI 位置 | 说明 |
|----|------|--------|---------|------|
| `enableMcp` | boolean | `false` | 设置 → General → 开发者 | 在 `127.0.0.1` 启动一个**只读**的 MCP（Model Context Protocol）HTTP 服务器，本地 AI 客户端可读取：打开的标签、前台命令、实时 cwd、最近输出。刻意不提供任何写入 PTY 的工具。 |
| `mcpPort` | number | `28700` | 设置 → General → 开发者 | MCP 服务器端口（仅回环）。改动后需把服务器关开一次才生效。 |

### 高级（无 UI，只能改 config.json）

| 键 | 类型 | 默认值 | 说明 |
|----|------|--------|------|
| `edgeBackgroundCoverage` | number | `0.9` | 见「外观」一节。 |
| `emptyStateMaxProfiles` | number | `0`（不限制） | 空窗口快捷启动页最多显示多少个配置文件（按最近打开排序，未打开过的按配置顺序排在最后）。`0` 或不设置 = 全部显示。 |
| `profileLastOpened` | `Record<name, 时间戳ms>` | — | **运行时写入**。每个配置文件「最近一次打开」的时间，用于空窗口快捷启动页按新近排序。删除无碍（仅丢失排序信息）。 |

### 已废弃

| 键 | 说明 |
|----|------|
| `copyWithCtrl` | 旧版「Ctrl+C 复制」开关，已被可自定义的 `copy` 快捷键动作取代。应用启动时会一次性把 `true` 迁移成普通 Ctrl+C 上的 `copy` 绑定并删除此字段。**不要再手动写这个键。** |

## 4. 配置文件 Profile（profiles）

`profiles` 是一个数组，每项描述一种终端配置（shell、外观、启动行为）。渲染类字段逐键继承 `globalProfile`（见[渲染选项](#5-渲染选项-terminalrenderoptions)）。

| 键 | 类型 | 默认值 | 说明 |
|----|------|--------|------|
| `name` | string | （必填） | 配置文件名，需唯一；也是空状态快捷启动、MCP、启动器等处的标识。 |
| `type` | `"local" \| "remote"` | `"local"` | 本地 shell 或 SSH 远程。 |
| `exePath` | string | local 必填 | 本地 shell 可执行文件路径（如 `/bin/zsh`）。remote 类型留空。 |
| `cwd` | string | 未设置 = 家目录 | 启动目录。 |
| `default` | boolean | `false` | 默认配置文件。建议只有一个为 `true`；第一个创建的配置文件会自动设为默认。 |
| `startupCommand` | string | 空 = 交互 shell | 启动后执行的命令（如 `"vim"`）。本地按 `<exe> --login -i -c "<cmd>"` 执行（命令结束 shell 一并退出）；SSH 配置则作为远程命令传给远端（`ssh user@host <cmd>`）。 |
| `keepAfterExit` | `"exit" \| "shell" \| "freeze"` | `"exit"` | `startupCommand` 执行完之后怎么办，见下表。仅在设置了 `startupCommand` 时有意义。 |
| `ssh` | object | — | remote 类型的连接参数，见下表。 |
| `launcher` | object | — | 「封装为应用」配置，见[第 9 节](#9-封装为应用profileslauncher)。对象存在即启用该功能。 |
| （渲染选项） | — | — | 所有[渲染选项](#5-渲染选项-terminalrenderoptions)（rows/cols/字体/主题/padding/webgl 等）都可以写在单个 profile 上，覆盖 `globalProfile`。 |

**`keepAfterExit` 取值说明**：

- `"exit"`（默认）—— 命令结束 shell 一起退出，标签关闭。适合单次启动型（vim / opencode）。
- `"shell"` —— 命令结束后 `exec` 进交互 shell：既能看输出又能继续用，标签随这个 shell 退出才关闭。
- `"freeze"` —— 命令 + shell 自然退出，但前端不自动关标签，输出冻结在屏幕上供阅读（只读，PTY 已结束），由用户手动关闭。

**`ssh` 对象**：

| 键 | 类型 | 默认值 | 说明 |
|----|------|--------|------|
| `host` | string | （必填） | 主机名 / IP。 |
| `port` | number | `22` | 端口。 |
| `user` | string | 当前用户 | 登录用户。 |
| `identityFile` | string | — | 私钥路径（传给 `ssh -i`）。 |

UI 里可以从 `~/.ssh/config` 导入主机（设置 → 配置文件 → 新建远程配置文件 → Import from .ssh/config）。

## 5. 渲染选项 TerminalRenderOptions

`globalProfile`（设置 → 全局配置）和每个 `profiles[]` 条目共用同一套字段：

**继承规则**：profile 中出现的键逐个覆盖 `globalProfile` 的同名键，没出现的键用全局值；两者都没写则用内置默认。终端配色（`theme`）的合并较特殊，见[主题文件](#6-主题文件themepath--theme)。

### Lumina 扩展选项

| 键 | 类型 | 默认值 | UI 位置 | 说明 |
|----|------|--------|---------|------|
| `rows` / `cols` | number | — | 设置 → 全局配置 / 配置文件 | 初始行数/列数。仅主窗口的首个标签会用它决定 OS 窗口初始大小；之后由窗口/终端自由缩放。 |
| `padding` | number 或 object | — | 设置 → 全局配置 / 配置文件 | 终端内边距（px）。数字 = 四边相同；对象形式 `{x, y, left, right, top, bottom}` 可分别指定（`x` 是左右、`y` 是上下，更细的键优先）。注意：为了不让首尾单元格被圆角裁掉，实际内边距有下限（左 ≥ 7，其余 ≥ 5）；窗口最大化时还会加上系统的安全边距。UI 只能编辑数字形式，对象形式需改 config.json。 |
| `webgl` | boolean | `false` | 渲染设置 | 使用 WebGL 加速渲染。 |
| `graphemeClusters` | boolean | `false` | 渲染设置 | 实验性：按字素簇测量宽度，复杂 emoji（ZWJ 序列、组合字符）不再错位，CPU 占用更高。开启后取代 Unicode 11 宽度表。 |
| `ligatures` | boolean | `false` | 渲染设置 | 编程连字。后端读取 `fontFamily` 指定字体的 GSUB 表做精确连字（Fira Code 的 `www`、`//` 等）；找不到字体文件时回退到内置的约 50 条常见连字。需要配合连字字体（Fira Code、JetBrains Mono…）。 |
| `fontStyle` | `"normal" \| "italic"` | `"normal"` | 渲染设置 | 字体样式。 |
| `themePath` | string | — | 渲染设置 | 主题 JSON 文件路径，见[主题文件](#6-主题文件themepath--theme)。 |
| `theme` | object | — | **无 UI** | 内联主题（partial ITheme），与主题文件同格式，优先级高于 `themePath`。 |

### xterm.js 透传选项

`TerminalRenderOptions` 直接扩展了 xterm.js 的 `ITerminalOptions`，因此下表选项（以及其它未列出的 xterm.js 选项）都可以直接写在 `globalProfile` 或 profile 上。默认值均为 xterm.js 内建默认。

| 键 | 类型 | xterm 默认值 | 说明 |
|----|------|--------------|------|
| `fontFamily` | string | 平台等宽字体栈 | 字体族，如 `"JetBrains Mono"`。连字功能读取它定位字体文件。 |
| `fontSize` | number | `15` | 字号（px）。 |
| `fontWeight` | `"normal" \| "bold" \| "100"…\|"900"` | `"normal"` | 常规字重。 |
| `fontWeightBold` | 同上 | `"bold"` | 粗体字重。 |
| `letterSpacing` | number | `0` | 字间距（整像素）。 |
| `lineHeight` | number | `1.0` | 行高倍数。 |
| `scrollback` | number | `1000` | 回滚行数。会话保存了历史时（`sessionSaveScrollback`），它也是恢复时回放的量。 |
| `cursorStyle` | `"block" \| "underline" \| "bar"` | `"block"` | 光标形状。 |
| `cursorBlink` | boolean | `false` | 光标闪烁。 |
| `cursorWidth` | number | `1` | `bar` 光标的宽度（px）。 |
| `cursorInactiveStyle` | `"outline" \| "block" \| "bar" \| "underline" \| "none"` | `"outline"` | 失焦时光标样式。 |
| `customGlyphs` | boolean | `true` | 制表符/框线字符用内置字形绘制（连线性更好），而非字体原生字形。 |
| `drawBoldTextInBrightColors` | boolean | `true` | 粗体文字用高亮色绘制。 |
| `minimumContrastRatio` | number | `1` | 最小对比度；大于 1 时会动态调亮/调暗前景色保证可读。 |
| `allowTransparency` | boolean | `false` | 允许半透明背景色。需在 `open()` 前设置，且影响性能。 |
| `altClickMovesCursor` | boolean | `true` | Alt+点击移动提示符光标到点击处。 |
| `convertEol` | boolean | `false` | 把 `\n` 当 `\r\n`（一般交由 PTY termios 处理，勿轻易开启）。 |
| `fastScrollSensitivity` | number | `5` | 按住 Alt 滚轮的加速倍数。 |
| `scrollSensitivity` | number | `1` | 滚轮速度倍率。 |
| `smoothScrollDuration` | number | `0` | 平滑滚动时长（ms），`0` 关闭。 |
| `tabStopWidth` | number | `8` | 制表位宽度。 |
| `wordSeparator` | string | 常见标点集合 | 双击选词的分隔符。 |
| `scrollOnUserInput` | boolean | `true` | 用户输入时滚回底部。 |
| `scrollOnEraseInDisplay` | boolean | `false` | 收到 `ED` 清屏序列时滚动。 |
| `rightClickSelectsWord` | boolean | `false` | 右键选中光标下的词（macOS 应用惯例）。 |
| `rescaleOverlappingGlyphs` | boolean | `false` | 自动缩放重叠字形。 |
| `reflowCursorLine` | boolean | `false` | 窗口缩放时重排光标所在行（shell 通常自己处理）。 |
| `screenReaderMode` | boolean | `false` | 屏幕阅读器支持（NVDA/VoiceOver）。 |
| `disableStdin` | boolean | `false` | 禁用键盘输入。 |
| `ignoreBracketedPasteMode` | boolean | `false` | 忽略 bracketed paste 模式。 |
| `macOptionIsMeta` | boolean | `false` | macOS 上 Option 当 Meta。 |
| `macOptionClickForcesSelection` | boolean | `false` | macOS 上 Option+点击强制框选。 |

## 6. 主题文件（themePath / theme）

**路径解析**：`themePath` 优先按**应用数据目录的相对路径**解析（如 `themes/my-theme.json` → `<应用数据目录>/themes/my-theme.json`），不存在再按原样（绝对路径）尝试。主题文件是 JSON，包含下表键的任意子集：

```json
{
    "background": "#1e1e2e",
    "foreground": "#cdd6f4",
    "cursor": "#f5e0dc",
    "selectionBackground": "rgba(180, 190, 254, 0.3)",
    "red": "#f38ba8",
    "brightBlue": "#89b4fa"
}
```

**合并顺序**（后者覆盖前者，均可只写部分键）：

1. 内置兜底主题 —— 亮色系统用 GitHub Light，暗色（及未决）用经典黑底；
2. `globalProfile` 的 `themePath` / `theme`（有全局配置时）；
3. profile 自己的 `themePath`；
4. profile 自己的内联 `theme`。

**可用颜色键**：

| 类别 | 键 |
|------|----|
| 基础 | `background` `foreground` `cursor` `cursorAccent` |
| 选区 | `selectionBackground` `selectionForeground` `selectionInactiveBackground` |
| 滚动条 | `scrollbarSliderBackground` `scrollbarSliderHoverBackground` `scrollbarSliderActive` |
| 标准 16 色 | `black` `red` `green` `yellow` `blue` `magenta` `cyan` `white` |
| 高亮 16 色 | `brightBlack` `brightRed` `brightGreen` `brightYellow` `brightBlue` `brightMagenta` `brightCyan` `brightWhite` |
| 扩展 | `extendedAnsi`（256 色数组） |

颜色格式：`#rgb` / `#rrggbb` 十六进制；选区键也接受 `rgba(...)` 半透明。

## 7. 快捷键（bindings）

`bindings` 是一个数组，每项一个快捷键：

```json
{
    "key": "t",
    "with": ["CtrlOrCommand"],
    "action": "newTab"
}
```

| 字段 | 说明 |
|------|------|
| `key` | 键盘事件 `key` 值。单字符键不区分大小写（`"p"` 能匹配 Shift+p 产生的 `"P"`）。 |
| `with` | 修饰键数组：`"ctrl"` `"shift"` `"alt"` `"command"`（macOS Cmd）`"CtrlOrCommand"`（macOS 上是 Cmd、其它平台是 Ctrl）。UI 里录入至少要一个修饰键，手改配置也建议保留。 |
| `action` | 动作名，见下表。 |
| `args` | 可选参数对象，见下表。 |

**合并规则**：`bindings` 未设置或为空数组 = 全部默认快捷键。设置了则：你的条目**按「动作 + 参数」覆盖同动作的默认条目**，未覆盖的默认条目保留（例如自定义 `newTab` 后默认的 `Ctrl/Cmd+T` 被替换，但 `toTab` 各条仍有效）。恢复默认：删掉 `bindings` 字段。

**动作列表**：

| 动作 | 参数 | 说明 |
|------|------|------|
| `newTab` | `{profileName: "名称"}`（可选） | 新建标签；带 `profileName` 用指定配置，不带用默认配置。 |
| `closeTab` | — | 关闭当前标签。 |
| `toTab` | `{index: "0"…}` | 按序号切换标签；`"last"` 表示最后一个。 |
| `toggleSidebar` | — | 显示/隐藏侧边栏。 |
| `tearOffTab` | — | 把当前标签撕脱为独立窗口（保留进程与回滚输出）。 |
| `search` | — | 终端内搜索（Ctrl+F 那个）。 |
| `copy` | — | 复制当前选区。特殊：**没有选区时按键直接落回 shell**——所以把复制绑到 Ctrl+C 也不会破坏 SIGINT。 |
| `paste` | — | 粘贴剪贴板到终端。 |
| `selectAll` | — | 全选终端缓冲。 |
| `openSettings` | — | 打开设置。 |
| `openConfigFile` | — | 用系统编辑器打开 config.json。 |
| `openCommandPalette` | — | 打开命令面板。 |

**默认快捷键**：

| 快捷键 | 动作 |
|--------|------|
| `Ctrl/Cmd + T` | 新建标签（默认配置） |
| `Ctrl/Cmd + W` | 关闭当前标签 |
| `Ctrl/Cmd + ,` | 打开设置 |
| `Ctrl/Cmd + Shift + P` | 命令面板 |
| `Ctrl/Cmd + 1…8` | 切到第 1…8 个标签 |
| `Ctrl/Cmd + 9` | 切到最后一个标签 |
| `Ctrl/Cmd + Shift + L` | 撕脱当前标签 |
| `Ctrl/Cmd + F` | 终端内搜索 |
| `Ctrl/Cmd + Shift + C` | 复制选区 |
| `Ctrl/Cmd + Shift + A` | 全选 |
| `Ctrl/Cmd + Shift + V` | 粘贴 |

> 纯 `Ctrl/Cmd + V` 被刻意不拦截：保持 readline 引用插入与系统粘贴的原生行为。

## 8. 命令图标规则（commandIcons）

标签图标默认跟随正在运行的前台命令（内置映射：`opencode`、`vim`/`nvim`/`neovim`、`claude` → 对应应用图标；`sudo`/`env`/`watch` 等包装命令会被跳过，取真实命令）。`commandIcons` 数组允许你自定义规则，**在内置表之前依次评估，先命中先赢**，可以覆盖内置图标：

```json
{
    "commandIcons": [
        { "match": "cargo", "icon": "custom:rust.png" },
        { "match": "^git\\s+push", "isRegex": true, "icon": "neovim" }
    ]
}
```

| 字段 | 说明 |
|------|------|
| `match` | `isRegex` 为 `false`（默认）时是**命令名**（basename），与整条命令行的第一个非包装 token 精确比较（大小写不敏感、去掉 `.exe`）；为 `true` 时是 **JavaScript 正则源码**，对整条原始命令行测试，参数也能参与匹配（如 `^git\s+push`）。 |
| `isRegex` | boolean，默认 `false`。 |
| `icon` | 图标 id：内置应用图标（当前有 `opencode` `vim` `neovim` `claudecode`）或 `custom:<文件名>` —— 通过设置 → 命令图标 →「导入图片…」导入的图片（存放在应用数据目录的 `command-icons/` 下）。 |

UI：**设置 → 命令图标**，支持实时测试预览；保存时会清理未被任何规则引用的导入图片。

## 9. 封装为应用（profiles[].launcher）

给某个 profile 加上 `launcher` 对象即启用「封装为应用」：每次保存配置时，应用会在系统对应位置生成一个启动器（Linux `.desktop` / macOS `.app` / Windows 开始菜单快捷方式），点击即用该 profile 独立开窗（内部走 `--profile` 等启动参数）。profile 被删除后，其启动器在下次保存时自动清理。

| 键 | 类型 | 默认值 | 说明 |
|----|------|--------|------|
| `title` | string | profile 名 | 启动器显示名 + 窗口标题。 |
| `workingDirectory` | string | profile 的 `cwd` | 覆盖启动目录。 |
| `sidebar` | `"show" \| "hide"` | `"hide"` | 启动窗口的侧边栏可见性。 |
| `icon` | string | 自动 | 图标：默认按 `startupCommand` 自动推导（`lib/appIcon.ts` 的映射），推导不出用应用自身图标；也可写内置图标 id 或 `custom:<文件名>`。 |

UI：**设置 → 配置文件 → 选中一个 profile → 封装为应用**，可直接查看生成位置并打开所在文件夹。

## 10. 完整示例

下面是一份覆盖大部分字段的 config.json（实际文件里没用的键可以不写）：

```json
{
    "config": {
        "language": "zh-cn",

        "themeMode": "system",
        "enableColorSpread": true,
        "edgeBackgroundCoverage": 0.95,

        "showTabBar": true,
        "closeWindowOnLastTab": false,
        "inheritWorkingDirectory": true,

        "rememberWindowPosition": true,
        "rememberWindowSize": true,

        "sessionSaveMode": "always",
        "sessionSaveScrollback": false,
        "loadDefaultProfileOnStartup": true,

        "imeDuplicateInputFix": true,
        "autoProxy": true,
        "autoUpdateOnStartup": true,

        "enableMcp": true,
        "mcpPort": 28700,

        "emptyStateMaxProfiles": 6,

        "globalProfile": {
            "fontFamily": "JetBrains Mono",
            "fontSize": 14,
            "ligatures": true,
            "webgl": true,
            "scrollback": 10000,
            "cursorBlink": true,
            "cursorStyle": "bar",
            "padding": 10,
            "themePath": "themes/catppuccin-mocha.json"
        },

        "profiles": [
            {
                "name": "zsh",
                "exePath": "/bin/zsh",
                "cwd": "/home/user",
                "default": true,
                "padding": { "x": 12, "y": 8 }
            },
            {
                "name": "dev server",
                "exePath": "/bin/bash",
                "startupCommand": "npm run dev",
                "keepAfterExit": "freeze",
                "fontSize": 13
            },
            {
                "name": "my server",
                "type": "remote",
                "ssh": {
                    "host": "203.0.113.10",
                    "port": 22,
                    "user": "root",
                    "identityFile": "/home/user/.ssh/id_ed25519"
                }
            },
            {
                "name": "opencode",
                "exePath": "/bin/zsh",
                "startupCommand": "opencode",
                "launcher": {
                    "title": "OpenCode",
                    "sidebar": "hide",
                    "icon": "opencode"
                }
            }
        ],

        "bindings": [
            { "key": "t", "with": ["CtrlOrCommand"], "action": "newTab" },
            { "key": "1", "with": ["CtrlOrCommand", "shift"], "action": "toTab", "args": { "index": "0" } }
        ],

        "commandIcons": [
            { "match": "bottom", "icon": "custom:lazydocker.png" }
        ]
    }
}
```

## 11. 相关文件

| 文件 / 目录 | 说明 |
|-------------|------|
| `config.json` | 本文所述的全部配置。 |
| `session.json` | 保存的终端会话（标签列表 + 可选回滚输出），由 `sessionSaveMode` 控制，与 config.json 分离。 |
| `themes/` | `themePath` 推荐存放主题 JSON 的目录（应用数据目录下，相对路径解析的第一优先位置）。 |
| `command-icons/` | 通过设置导入的自定义命令图标 / 启动器图标。 |
| launchers | 「封装为应用」的产物：Linux `~/.local/share/applications/`（`lumina-` 前缀）、macOS `~/Applications/`、Windows 开始菜单 `Programs/Lumina/` 目录。 |

应用数据目录即[第 1 节](#1-配置文件位置)中 config.json 所在目录。
