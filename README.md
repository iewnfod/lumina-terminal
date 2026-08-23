<p align="center">
  <a href="./src/assets/icon.svg">
    <img src="./src/assets/icon.svg" width="120" height="120" alt="logo">
  </a>
  <h3 align="center">Lumina Terminal</h3>
</p>
<p align="center">
  <a href="./README_zh.md">简体中文</a> | English
</p>

A modern, cross-platform terminal emulator built with Tauri, React, and Xterm.js — featuring a sleek UI, command palette, and customizable profiles.

## Installation
* Arch Linux (with an AUR helper like `paru` or `yay`):
```shell
paru -S lumina-terminal-bin
# or: yay -S lumina-terminal-bin
```
* Other Linux / macOS: install with script
```shell
curl -fsSL https://raw.githubusercontent.com/iewnfod/lumina-terminal/master/install.sh | bash
```
* Windows: download installer from [releases](https://github.com/iewnfod/lumina-terminal/releases)

## Screenshots

### Terminal
<p align="center">
  <img src="./assets/terminal-en.png" alt="Terminal" width="800">
</p>

### Command Palette
<p align="center">
  <img src="./assets/command-palette-en.png" alt="Command Palette" width="800">
</p>

### Settings
<p align="center">
  <img src="./assets/settings-en.png" alt="Settings" width="800">
</p>

### Profile
<p align="center">
  <img src="./assets/profile-en.png" alt="Profile" width="800">
</p>

## Features

### Terminal
* Multi-tab terminal backed by [portable-pty](https://docs.rs/portable-pty/latest/portable_pty/) — each tab runs a real shell process
* **Tear off tabs** — move a tab into its own window (`Ctrl+Shift+L` / `Cmd+Shift+L`) while keeping the running process and scrollback alive
* **Find in terminal** (`Ctrl+F` / `Cmd+F`) — match-case / whole-word / regex with a live result counter, via [addon-search](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-search)
* Configurable shell per profile — PowerShell, WSL, Git Bash, or any executable
* Optional [WebGL renderer](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl) for GPU-accelerated rendering
* [Unicode 11 width rules](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-unicode11) + optional [grapheme-cluster](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-unicode-graphemes) rendering for correct emoji/symbol widths
* Optional [programming ligatures](https://github.com/princjef/font-ligatures) via the real OpenType GSUB table (Fira Code `www`/`//`, JetBrains Mono `==`, …)
* Chunked output batching — smoothly handles large text dumps without blocking the UI
* Drag and drop files into the terminal to insert their paths; auto-resize on window/container changes
* **MCP server (experimental)** — optionally expose terminal state (open tabs, running command, cwd, recent output) to local AI clients over a read-only loopback endpoint, via [rmcp](https://github.com/modelcontextprotocol/rust-sdk). Enable in Settings → Developer.
* **Auto proxy sync** — detect system proxy changes (GNOME `gsettings` / KDE `kioslaverc` / macOS `scutil` / Windows registry) and keep `http_proxy` / `HTTPS_PROXY` / `all_proxy` / `no_proxy` in sync inside already-running bash/zsh/fish tabs, applied silently by the shell-integration prompt hook — no restart, no visible keystrokes. Manually exported proxies are never touched. Toggle in Settings → General.

### User Interface
* **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`) — search and execute commands with keyboard navigation
* **Tab Bar** — sidebar with drag region and hover-close, toggleable via title bar or palette
* **Command icons** — the tab icon follows the running command (vim, neovim, opencode, Claude Code, …). User-defined rules: plain command names or regex matched against the whole command line, with built-in app icons or your own imported SVG/PNG. Configure in Settings → Command Icons.
* **Custom Title Bar** — window controls integrated with the terminal theme on Windows & Linux
* **Auto Theme** — UI light/dark mode syncs to the terminal background color
* **Color Spread** — a fullscreen TUI's uniform edge background fills the window chrome for an immersive look (toggleable)

### Keyboard Shortcuts
* Fully customizable keybindings stored in the config file. Defaults:
  * `Ctrl/Cmd+T` — New tab · `Ctrl/Cmd+W` — Close tab (closes the app from the empty state)
  * `Ctrl/Cmd+Shift+L` — Tear off tab · `Ctrl/Cmd+F` — Find
  * `Ctrl/Cmd+,` — Settings · `Ctrl/Cmd+Shift+P` — Command palette
  * `Ctrl/Cmd+1–9` — Switch to tab by index
* `Ctrl+C` / `Ctrl+Shift+C` swap (non-macOS) — copy with `Ctrl+C`, send SIGINT with `Ctrl+Shift+C`

### Profiles
* Multiple named profiles with per-profile shell, dimensions, font, theme, and startup command (e.g. `vim`, `opencode` — tab closes on exit; passed to the remote host for SSH profiles)
* Custom terminal themes via JSON files (xterm.js ITheme format) with live color preview

### i18n
* English · Simplified Chinese (简体中文)

### Welcome Wizard
* First-run onboarding: language → profile → confetti finish

## Command-line options

Lumina accepts Alacritty-style launch flags (with a Lumina-specific `--profile`). When any of these is given, a **single tab** is opened with the overrides and session restore is skipped.

| Flag | Description |
|------|-------------|
| `-e, --command <COMMAND>...` | Command + args to run on startup (must be the **last** flag — everything after it is the command). Runs through the profile's configured shell; the tab closes when the command exits unless `--hold` is given. |
| `--working-directory <DIR>` | Start the shell in this directory. |
| `-T, --title <TITLE>` | Set the window title. |
| `--hold` | Keep the terminal open (frozen, read-only) after the command exits. |
| `--profile <NAME>` | Open a configured profile by name; other flags layer on top. Falls back to the default if not found. *(Lumina-specific)* |
| `--version` / `--help` | Print version / usage and exit (no window). |

```shell
lumina-terminal -e nvim                         # run nvim; closes on :q
lumina-terminal --hold -e ls -la                # run ls -la, keep the output
lumina-terminal --working-directory ~/projects -e npm run dev
lumina-terminal --profile work                  # open the "work" profile
lumina-terminal --hold --profile dev -e cargo build
lumina-terminal -T "build log"                  # set the window title
```

## Performance

Lumina Terminal's rendering pipeline is tuned to stay smooth under heavy output — large `cat`, ANSI-dense TUIs, scrolling, and unicode — while keeping memory bounded via read backpressure.

Benchmarks below use [vtebench](https://github.com/alacritty/vtebench) (the same suite Alacritty uses), reporting **90th-percentile** sample latency (lower is better). Lumina is compared against three peers:
- [Alacritty](https://alacritty.org/) — native Rust + OpenGL, the performance ceiling for any terminal
- [Tabby](https://tabby.sh/) — Electron + xterm.js, a popular web-tech terminal
- VS Code integrated terminal — Electron + xterm.js, the most widely used web-tech terminal

| Benchmark | Lumina | Alacritty | Tabby | VS Code |
|-----------|-------:|----------:|------:|--------:|
| cursor_motion | 58ms | 9ms | 89ms | 165ms |
| light_cells | 41ms | 8ms | 60ms | 138ms |
| medium_cells | 4ms | 8ms | 73ms | 320ms |
| dense_cells | 135ms | 25ms | 247ms | 473ms |
| scrolling_fullscreen | 6ms | 10ms | 74ms | 139ms |
| scrolling | 257ms | 158ms | 198ms | 730ms |
| scrolling_top_region | 176ms | 172ms | 191ms | 1296ms |
| scrolling_bottom_region | 263ms | 128ms | 198ms | 1250ms |
| scrolling_top_small_region | 277ms | 138ms | 175ms | 1391ms |
| scrolling_bottom_small_region | 248ms | 190ms | 181ms | 1364ms |
| sync_medium_cells | 4ms | 9ms | 72ms | 164ms |
| unicode | 4ms | 7ms | 73ms | 56ms |

Lumina **matches or beats Alacritty** on several benchmarks (medium_cells, scrolling_fullscreen, sync_medium_cells, unicode) and **comfortably outperforms both Tabby and the VS Code integrated terminal** across the board — while running the same underlying web rendering stack.

For a pure rendering-stress test, [DOOM Fire](https://github.com/const-void/DOOM-fire-node) (a continuous full-screen ANSI animation) measures sustained frames per second (higher is better):

| | Lumina | Alacritty | Tabby | VS Code |
|---|-------:|----------:|------:|--------:|
| fps | ~420 | ~1800 | ~175 | ~60 |

Lumina sustains **~7× the framerate of Tabby and VS Code** under continuous heavy repaint.

> Tested on `AMD Ryzen™ AI 9 HX 370 w`, `NVIDIA GeForce RTX™ 5080 Laptop GPU`, Arch Linux.

## Development

```shell
git clone https://github.com/iewnfod/lumina-terminal.git
cd lumina-terminal
pnpm install
pnpm tauri dev
```

See [**CONTRIBUTING.md**](./CONTRIBUTING.md) for the development setup, app-icon guide, and code standards. The full architecture and contributor rules live in [AGENTS.md](./AGENTS.md).

## Technology Used
<!-- lumina:tech-stack — anchor parsed by the About page; keep on its own line -->

### Core
* [Tauri & Tauri Plugins](https://tauri.app/) — cross-platform desktop framework
* [Rust](https://rust-lang.org/) — backend language (PTY, MCP, filesystem)
* [portable-pty](https://docs.rs/portable-pty/latest/portable_pty/) — pseudo-terminal spawning and I/O

### Backend
* [clap](https://docs.rs/clap/) — command-line argument parsing
* [rmcp](https://github.com/modelcontextprotocol/rust-sdk) — Model Context Protocol server
* [axum](https://github.com/tokio-rs/axum) — modular web framework (MCP Streamable HTTP endpoint)
* [tokio](https://tokio.rs/) — async runtime
* [log](https://docs.rs/log/latest/log/) — structured logging

### Frontend
* [TypeScript](https://www.typescriptlang.org/) — typed frontend language
* [React](https://react.dev/) — UI component framework
* [HeroUI](https://heroui.com/) — React UI component library
* [Xterm.js & Addons](https://xtermjs.org/) — terminal renderer
* [Tailwind CSS](https://tailwindcss.com/) — utility-first styling
* [Lucide Icons](https://lucide.dev/) — icon set
* [Framer Motion](https://www.framer.com/motion/) — animation library
* [react-markdown](https://github.com/remarkjs/react-markdown) — markdown rendering

### Tooling
* [pnpm](https://pnpm.io/) — package manager
* [Vite](https://vite.dev/) — bundler and dev server

## License
[Mozilla Public License Version 2.0](./LICENSE)

## Publicity Community
* [LINUX DO](https://linux.do/)
