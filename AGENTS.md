# AGENTS.md

This document describes Lumina Terminal's architecture, design principles, and
the rules any AI (or human) contributor must follow so the codebase stays
high-cohesion / low-coupling and does not regress into duplication.

> Read this **before** making changes. If a change would violate a rule below,
> extract or refactor first rather than adding another copy.

---

## 1. Tech Stack

| Layer | Technology |
|-------|-----------|
| Shell / backend | Rust + Tauri v2 |
| PTY | `portable_pty` |
| Frontend | React 19 + TypeScript (strict) |
| Terminal renderer | xterm.js v6 (+ webgl, fit, web-links, image addons) |
| UI components | HeroUI (`@heroui/react`) |
| Styling | Tailwind CSS v4 |
| Build | Vite 7, `pnpm` |
| i18n | JSON files in `translations/` |

The backend (`src-tauri/`) is intentionally thin: it spawns/kills PTYs,
streams output via Tauri events, and exposes a few filesystem helpers. All UI
logic, state, and derivation live in the frontend.

`@xterm/xterm` stays on stable 6.0.0 plus a local backport patch
(`patches/@xterm__xterm@6.0.0.patch`, declared in `pnpm-workspace.yaml`) that
vendors two upstream IME fixes the WebKitGTK duplicate-input fix depends on
(xterm.js #5439 + #5698). See `patches/README.md`; drop the patch when the
next stable xterm release containing both ships.

---

## 2. Source Map

### Frontend (`src/`)

```
src/
├── App.tsx                  # Root: composes chrome (TabBar/TitleBar/Term) + non-terminal key dispatch.
│                            #   Tab lifecycle/state live in useTerminalManager; geometry in useWindowGeometry.
├── main.tsx                 # ReactDOM entry; wraps App in GlobalConfigProvider
├── constants.ts             # Default config, default bindings, tab-id sentinels
├── types/
│   ├── config.ts            # GlobalConfig, Binding, Actions, WithKeys
│   ├── cli.ts               # CliArgs — parsed launch flags (mirrors src-tauri/src/cli.rs CliArgs)
│   └── terminal.ts          # TerminalProfile (+ keepAfterExit: "exit"|"freeze"|"shell" — what
│                            #   happens after startupCommand finishes), TerminalRenderOptions, SSHConfig
│
├── lib/                     # Pure, framework-agnostic logic (NO React)
│   ├── platform.ts          # isMacOS() / isLinux()
│   ├── configFile.ts        # config.json path + openConfigFile()
│   ├── color.ts             # isColorDark, foregroundFor, adjustColor, visibleRed
│   ├── glass.ts             # glassSurface / glassBorder / elevationShadow — backdrop-filter material
│   │                        #   + Wayland/WebKitGTK opaque fallback (single source for the glass look)
│   ├── motion.ts            # framer-motion variants/transitions presets (one spring curve for all chrome)
│   ├── ssh.ts               # formatSshAddress / formatSshEntry
│   ├── term.ts              # parseProfile, parseProfileTheme, parseProfilePadding
│   ├── terminalApi.ts       # invoke wrappers: writeToTerminal, resizeTerminal, ...
│   ├── mcpApi.ts            # startMcpServer/stopMcpServer invoke wrappers (log-on-reject) — the
│   │                        #   read-only MCP server domain API (sibling to terminalApi.ts)
│   ├── proxyApi.ts          # startProxySync/stopProxySync invoke wrappers (log-on-reject) — the
│   │                        #   system-proxy watcher domain API (sibling to terminalApi.ts)
│   ├── cliApi.ts            # getCliArgs() wrapper — reads parsed launch flags (log-on-reject)
│   ├── clipboardApi.ts      # readClipboardText() — clipboard-plugin read wrapper (log-on-degrade);
│   │                        #   the only clipboard READ path (navigator.clipboard.readText is
│   │                        #   unusable in the Tauri webviews); writes stay on navigator.clipboard
│   ├── openerApi.ts         # openExternal — opener-plugin URL wrapper (log-on-reject); the one
│   │                        #   way external links reach the system browser (plain target="_blank"
│   │                        #   anchors are dead in the Tauri webview)
│   ├── appIcon.ts           # Command→tab-icon mapping: resolveAppFromCommand (wrapper-skipping)
│   │                        #   + getAppIcon(line, userRules?) — user rules (config commandIcons,
│   │                        #   plain basename or regex-vs-whole-line) run before the built-in
│   │                        #   APP_COMMANDS table. Also the custom:" icon id helpers. Single
│   │                        #   source of truth for which running command shows which app icon.
│   ├── commandIconApi.ts    # importCommandIcon/pruneCommandIcons/listCommandIcons invoke wrappers
│   │                        #   (log-on-reject) + cached asset-protocol URL resolution for custom:
│   │                        #   icon ids — the custom command-icon domain API (sibling to terminalApi.ts)
│   ├── shellIcon.ts         # getShellType(profile) → "bash"|"zsh"|"fish"|"nu"|"pwsh"|"ssh"|"default"
│   ├── bindings.ts          # parseBindings, matchBinding, loadBindings, useKeyboardBindings,
│   │                        #   exported actionSignature / keySignature. loadBindings dispatches
│   │                        #   the `copy` action itself (needs the live selection: with one it
│   │                        #   writes the clipboard, without it the key falls through to the
│   │                        #   shell so bound-to-Ctrl+C copy keeps SIGINT)
│   ├── edgeBackground.ts    # sampleEdgeBackground (xterm buffer edge inspection)
│   ├── tearoff.ts           # Tab tear-off: label mint/store/consume + WebviewWindow spawn
│   ├── session.ts           # Terminal-session persistence: SavedTab/SavedSession types +
│   │                        #   LazyStore("session.json") load/save/clear. Save-side re-spawn contract
│   │                        #   (profile name + live cwd + optional scrollback); restore re-parses against
│   │                        #   the current globalProfile. Pure logic — no React.
│   ├── tabDragOverlay.ts    # mountTabDragOverlay (transparent full-window layer keeping dragover alive over canvas)
│   ├── tabReorder.ts        # Sidebar drag-reorder math: dropTargetFor (pointer Y → gap index)
│   │                        #   + reorderByDrop (move item into gap; same ref when it's a no-op)
│   ├── chunkedWriter.ts     # ChunkedWriter — bounded-chunk feeder for term.write() (UTF-16-safe slicing)
│   ├── terminalGeometry.ts  # profileWindowSize — measure cell size + compute OS window size for rows/cols
│   ├── initialWindowSize.ts # Shared once-per-session lock for "size the main window to a terminal profile"
│   │                        #   on startup. Used by Term (terminal mounts first) and useEmptyStateWindowSize
│   │                        #   (app starts with no terminal) so exactly one sizes the window per session.
│   ├── imeCompositionGuard.ts # WebKitGTK/IBus normalization for xterm's unmatched keyCode-229 IME fallback
│   │                        #   (config-gated: global imeDuplicateInputFix, default on — see GeneralSettings)
│   ├── bindingsSettings.ts  # bindings-editor pure logic: actionLabel, detectConflicts, toDraft, …
│   └── FloatingFitAddon.ts  # xterm fit addon subclass (centered sub-cell fit)
│
├── hooks/                   # React hooks (start with `use`)
│   ├── config.tsx           # GlobalConfigProvider + useGlobalConfig (LazyStore-backed)
│   ├── i18n.tsx             # useI18n, languageNames, Languages type
│   ├── maximized.ts         # useMaximized (window resize → isMaximized)
│   ├── useAlwaysOnTop.ts    # useAlwaysOnTop() → {pinned, toggle}: per-window always-on-top
│   │                        #   (optimistic local state; no-op on Wayland, so the TitleBar
│   │                        #   pin button disables itself there)
│   ├── paddingOffset.ts     # usePaddingOffset(isMaximized) → platform/maximize padding
│   ├── surfaceColors.ts     # useSurfaceColors(bg) → derived border/overlay/glass/accent colors
│   ├── useGlass.ts          # useGlass() → {supportsGlass, blurPx}: platform backdrop-filter capability
│   │                        #   (disabled on Linux/WebKitGTK; module-cached like useShells)
│   ├── useSettingsDraft.ts  # useSettingsDraft(source, onCommit, deps) → {draft, isDirty, save, ...}
│   │                        #   shared draft+dirty+save logic for all settings panels
│   ├── useShells.ts         # useShells() — cached find_shells backend call
│   ├── useSshConfig.ts      # useSshConfig() — cached parse_ssh_config backend call
│   ├── useMcpServer.ts      # useMcpServerLifecycle() — drives the MCP HTTP server from config.enableMcp
│   │                        #   (called once at the app root, so the server follows the app lifecycle,
│   │                        #   not the settings panel); useMcpEndpoint() reactively reads the running
│   │                        #   server's URL+token (module-level singleton via useSyncExternalStore)
│   ├── useProxySync.ts      # useProxySync() — drives the system-proxy watcher from config.autoProxy
│   │                        #   (default on). Same app-lifecycle pattern as useMcpServerLifecycle;
│   │                        #   disabling stops the watcher and deletes the hooks' env-file so
│   │                        #   running shells drop (only) the values Lumina injected
│   ├── useCliArgs.ts        # useCliArgs() — cached get_cli_args; Alacritty-style launch flags,
│   │                        #   consumed by useTerminalManager's seed effect to shape the main
│   │                        #   window's first tab (--profile/--command/--working-directory/--hold/--title)
│   ├── useOutputMode.ts     # useOutputMode(id) → {markInteractive}: debounced LowLatency toggle
│   ├── useEffectiveTheme.ts # useEffectiveTheme(profile, currentId) → theme/bg/fg + HeroUI sync
│   ├── useTerminalManager.ts# useTerminalManager() — tab list/profiles/active id + create/close/reorder/
│   │                        #   tear-off + cross-window merge/hover listeners (extracted from App.tsx)
│   ├── useWindowGeometry.ts # useWindowGeometry(isMainWindow) — restore + persist window pos/size (Wayland-aware)
│   ├── useEmptyStateWindowSize.ts # useEmptyStateWindowSize(opts) — when the app starts with no terminal, size the
│   │                        #   main window to the default profile via profileWindowSize (same dummy-xterm measure
│   │                        #   + once-per-session lock Term uses), so the empty state isn't stuck at the OS size.
│   ├── useCommandPaletteActions.tsx # useCommandPaletteActions(opts) — build the palette action list (JSX)
│   ├── useKeyRecorder.ts    # useKeyRecorder(index, onRecord, onCancel) — global keydown capture for bindings editor
│   ├── useTearoffSession.ts # useTearoffSession() → {label, payload} | "no" | null (tab tear-off boot)
│   └── useSessionPersistence.ts # useSessionPersistence(refs) — the app's only window close hook
│                            #   (onCloseRequested): saves open tabs to session.json per sessionSaveMode,
│                            #   drives the "ask" dialog, and one-shot-loads a saved session on mount for
│                            #   useTerminalManager's seed effect to restore.
│
├── components/
│   ├── ui/                  # Shared design primitives (the visual system — one of each thing)
│   │   ├── IconButton.tsx   # Unified chrome button (replaces 3 prior button systems). Motion-aware.
│   │   ├── MaskedSurface.tsx    # SVG-mask wrapper: clips children to a rounded rect (corners cut
│   │   │                        #   away so the chrome beneath shows). Extensible to complex shapes.
│   │   ├── SettingsShell.tsx    # Settings page frame (scroll body + optional footer slot)
│   │   ├── SettingRow.tsx       # field / toggle / action / info row — kills the settings spacing drift
│   │   ├── SectionTitle.tsx     # <h2> heading + optional subtitle (consistent mb)
│   │   ├── SaveFooter.tsx       # Save (disabled-when-clean) + unsaved hint + trailing action slot
│   │   └── ExternalLink.tsx     # <a> that opens via lib/openerApi.ts — every plain external
│   │                            #   link goes through this (motion anchors call openExternal)
│   ├── Term.tsx             # Single xterm instance: addons, PTY lifecycle, edge bg polling
│   ├── SearchBar.tsx        # In-terminal search overlay (Ctrl+F): drives the headless
│   │                        #   @xterm/addon-search via a glass top slide-down bar (case /
│   │                        #   whole-word / regex toggles + result counter). Mounted in Term.
│   ├── TabBar.tsx           # Sidebar tab list. One HTML5 drag serves two outcomes: dropped
│   │                        #   inside the list it reorders (local preview order rearranged
│   │                        #   via lib/tabReorder.ts, rows glide with framer `layout`,
│   │                        #   committed on drop), released outside it tears off / merges.
│   ├── TitleBar.tsx         # Drag region + window controls (per-platform)
│   ├── CommandPalette.tsx   # Ctrl+Shift+P modal
│   ├── SessionSaveDialog.tsx # "Ask every time" close confirmation (Save / Don't Save + remember
│   │                        #   this choice). Driven by useSessionPersistence; glass Modal.
│   ├── ShellIcon.tsx        # Per-shell tab icon (bash/zsh/fish/nu/pwsh/ssh/default)
│   ├── AppIcon.tsx          # Per-command tab icon: branded app logos from assets/app-icons/
│   │                        #   (registry loaded via import.meta.glob) or custom: imported images
│   │                        #   (asset-protocol URL, resolved+cached via lib/commandIconApi.ts).
│   │                        # Rendered when the running command maps to an app (lib/appIcon.ts);
│   │                        # takes precedence over ShellIcon.
│   ├── ThemePreview.tsx     # 8-color ANSI swatch with tooltip
│   ├── EmptyState.tsx       # Profile quick-launch list shown in the main area when the last tab is
│   │                        #   closed while "keep window on last tab closed" is on (ids empty).
│   │                        #   Centered icon + heading + clickable profile rows (shell icon via
│   │                        #   getShellType/ShellIcon); the default profile shows its new-tab
│   │                        #   shortcut hint (findBinding/bindingToShortcut). Whole surface is a
│   │                        #   window drag region (data-tauri-drag-region).
│   └── settings/
│       ├── GeneralSettings.tsx
│       ├── GlobalProfileSettings.tsx
│       ├── ProfileSettings.tsx
│       ├── RenderSettings.tsx     # Shared render-option form (rows/cols/font/theme/webgl)
│       ├── BindingsSettings.tsx
│       ├── CommandIconSettings.tsx # User command→icon rules editor (config commandIcons): match
│       │                       #   input + regex toggle (live validation) + icon picker (built-ins
│       │                       #   + every stored imported SVG/PNG via list_command_icons) + live
│       │                       #   test preview. Saving prunes unreferenced icon files (the only
│       │                       #   cleanup moment) and re-lists.
│       ├── DeveloperSettings.tsx
│       ├── AddProfileModal.tsx
│       ├── ShellSelector.tsx      # Shared shell picker (dropdown + custom path + browse)
│       └── SshFields.tsx          # Shared SSH Host/Port/User/IdentityFile form
│
└── pages/
    ├── WelcomePage.tsx      # First-run wizard (3 steps)
    ├── SettingsPage.tsx     # Settings shell with inner sidebar
    └── AboutPage.tsx
```

### Backend (`src-tauri/src/`)

```
src-tauri/src/
├── main.rs        # entry, calls lib::run()
├── lib.rs         # Tauri builder: plugins, state, invoke_handler registration; parse_cli() at top
│                  #   of run() (handles --help/--version + exits before the window spawns)
├── cli.rs         # clap-based launch-flag parsing (Alacritty-style): CliArgs (-e/--command,
│                  #   --working-directory, -T/--title, --hold, --profile), CliState, parse_cli
│                  #   (filters macOS -psn_*), get_cli_args command — args are surfaced to the
│                  #   frontend, which decides how they shape the initial tab. `-e` gets a
│                  #   pre-clap argv split (split_command_region, tested via try_parse_cli):
│                  #   tokens after it are the command EXCEPT Lumina's own window-shaping
│                  #   flags, which still parse as flags (`-e nvim -T nvim` titles the window);
│                  #   `--` switches to verbatim capture (escape hatch for `-e -- ssh -T h`)
├── state.rs       # TerminalState (HashMap of PTY pairs + writers + force_low_latency flags
│                  #   + swappable output_channel for tab tear-off reattach)
├── terminal.rs    # start/reattach/kill/write/resize_terminal, set_output_mode commands;
│                  #   reader thread streams output over the entry's swappable Channel<String>
│                  #   with streaming-UTF-8 decoding + two-mode burst coalescing;
│                  #   reattach_terminal atomically swaps the channel for tab tear-off
├── command_tracker.rs # CommandInfo type + foreground_command() /proc + ps + privileged-name logic
├── command_icons.rs # User-imported command icon storage: import_command_icon (validate ext/size,
│                  #   copy into <app data dir>/command-icons with a content-hash name),
│                  #   list_command_icons (picker source — every stored icon, so a rule can be
│                  #   switched away and back), prune_command_icons (drop files no saved rule
│                  #   references — the ONLY cleanup moment); pure helpers (sanitize_stem, ext_of, …)
│                  #   parameterized by dir (tests/command_icons.rs)
├── shell_integration.rs # bash/zsh/fish OSC-1337 injection (precmd/preexec hooks for exit codes
│                  #   and command text) + the per-shell proxy-sync hooks whose env-file
│                  #   (proxy.env, same dir) is written by proxy.rs; hook sources are
│                  #   generated per launch with the env-file path baked in (real-shell
│                  #   lifecycle tests in tests/shell_hooks.rs)
├── proxy.rs        # System-proxy auto injection: ProxySnapshot + per-source parsers
│                  #   (gsettings list-recursively / KDE kioslaverc / scutil --proxy /
│                  #   reg query — pure & unit-tested) + the polling watcher thread and
│                  #   start/stop_proxy_sync commands. Publishes the shell hooks' env-file
│                  #   (KEY=value lines, absence = unset) atomically on change only; PAC
│                  #   modes are reported off (env vars cannot express them). Parsers are
│                  #   tested in tests/proxy.rs
├── mcp.rs         # Read-only MCP (Model Context Protocol) server: rmcp tool handlers
│                  #   (list_tabs/get_active_tab/get_tab/get_foreground_command/get_recent_output/
│                  #   get_terminal_cwd) reusing TerminalState + command_tracker + the per-tab
│                  #   recent_output ring buffer; Streamable HTTP endpoint on 127.0.0.1 via axum,
│                  #   config-driven start/stop (start_mcp_server/stop_mcp_server). Read-only by
│                  #   design — no PTY-write tool.
├── ssh.rs         # SshConfig/SshHostEntry types + parse_ssh_config (~/.ssh/config) →
│                  #   parse_ssh_config_content (pure content parser, tested in tests/ssh_config.rs)
├── shells.rs      # find_shells — PATH + known-dir shell discovery (Win MSYS2/Git, Unix homebrew);
│                  #   PATH scan extracted as scan_path_for (tested in tests/shells.rs)
├── system.rs      # is_wayland, is_debug, get_commit_hash, get_log_dir, open_devtools
├── install_source.rs # install_source — pacman/dpkg/rpm package-ownership detection;
│                  #   stdout parsers extracted pure (tested in tests/install_source.rs)
├── file_manager.rs # open_in_file_manager — xdg-open / open -R / explorer (per-OS)
├── fonts.rs       # find_font — CSS font-family → font file bytes for ligature parsing;
│                  #   first_concrete_family pure (tested in tests/fonts.rs)
└── utils.rs       # path_exist, read_file (tiny fs helpers; tested in tests/utils.rs)

tests/             # Backend integration tests (mandatory for backend work — see §3.7).
│                  #   Each file targets one src/ module against the lib crate
│                  #   (lumina_terminal_lib); run with
│                  #   `cargo test --manifest-path src-tauri/Cargo.toml`.
├── proxy.rs       # per-source proxy parsers + env-file render + real-gsettings e2e (self-skipping)
├── shell_hooks.rs # real bash/zsh/fish lifecycle of the generated proxy-sync hooks (self-skipping)
├── cli.rs         # launch-flag parsing + the macOS -psn_* argv filter + the `-e`
│                  #   command-region split (flags-after-command, `--` escape hatch)
├── ssh_config.rs  # ~/.ssh/config content parsing: wildcards, keyword case, invalid port
├── shells.rs      # scan_path_for over controlled temp dirs: hits, dedup, separators
├── state.rs       # RecentOutput 64 KiB UTF-8-safe tail + capped exit/command stores
├── mcp.rs         # strip_ansi: CSI/OSC/DCS removal, control chars, torn escapes
├── terminal.rs    # flush_utf8_pass (split multi-byte chars, malformed safety net)
│                  #   + process_cwd against this process's own /proc entry
├── command_tracker.rs # basename / privileged-name classification + real /proc & ps
│                  #   argv resolution against a live child (Unix-only file)
├── command_icons.rs # import (ext/size validation, hash-named dedup) + prune over temp dirs;
│                  #   sanitize_stem / ext_of pure helpers
├── install_source.rs # pacman/dpkg/rpm stdout sample shapes (hit and miss)
├── fonts.rs       # CSS font-family → first concrete family extraction
├── utils.rs       # path_exist / read_file over real temp files
└── file_manager.rs # nonexistent-path guard (rejected before any OS spawn)
```

---

## 3. Design Principles

### 3.1 Layering — one direction of dependency

```
types  ←  lib  ←  hooks  ←  components/pages  ←  App
```

- **`types/`** depends on nothing internal.
- **`lib/`** holds pure logic: no React, no JSX, no `useState`. The single
  exception is `lib/bindings.ts`, which exports `useKeyboardBindings` for
  convenience — do not add more React into `lib/`.
- **`hooks/`** may import `lib/` and `types/`, never `components/`.
- **`components/`** may import `hooks/`, `lib/`, `types/`.
- **`App.tsx`** wires everything; it may import from all layers.

Never invert an arrow. If a `lib/` function needs React, it belongs in `hooks/`.

### 3.2 Single Source of Truth (no duplication)

Before writing any new logic, check whether it already exists. Common
categories that tend to duplicate:

- **Platform checks** → use `lib/platform.ts` (`isMacOS`, `isLinux`). Do not
  call `@tauri-apps/plugin-os` directly in components.
- **Color math** → use `lib/color.ts`. Do not re-implement luminance / contrast.
- **Glass material / backdrop-filter** → use `lib/glass.ts` (`glassSurface`,
  `glassBorder`, `elevationShadow`) gated by `hooks/useGlass.ts`. Never write
  `backdrop-filter` inline in a component — the Wayland/WebKitGTK fallback
  lives in `glassSurface`, so bypassing it breaks Linux. Call `glassSurface`
  directly in the chrome container and spread the result onto its `style`.
- **Motion presets** → use `lib/motion.ts` (shared framer-motion variants).
  Do not invent per-component spring curves; reuse `springSoft`, `fadeSlideUp`,
  `whileHoverTap`, etc., so all chrome animates with one rhythm.
- **Chrome buttons** → use `components/ui/IconButton.tsx`. Do not hand-roll
  `<button>` + `onMouseEnter` background swapping (the old pattern that
  drifted across TitleBar/TabBar) — `IconButton` handles hover/active/focus
  declaratively and is motion-aware.
- **Settings layout** → use `components/ui/` primitives (`SettingsShell`,
  `SettingRow`, `SectionTitle`, `SaveFooter`) and `hooks/useSettingsDraft.ts`.
  Do not re-roll the page-shell / labeled-field / draft+isDirty pattern in a
  new settings panel — port it onto the shared primitives instead.
- **Backend `invoke` calls** → wrap new commands in `lib/terminalApi.ts` (or a
  sibling api module) and import the wrapper. Components should rarely call
  `invoke` directly; when they do (one-off commands like `path_exist`), it is
  acceptable, but if the same command appears twice, extract it.
- **Binding signatures** → `actionSignature` and `keySignature` are exported
  from `lib/bindings.ts`. The settings UI and the runtime matcher must share
  these so conflict detection stays in sync. Never re-define them.
- **SSH address formatting** → `lib/ssh.ts` (`formatSshAddress`).
- **SSH config fetching** → `hooks/useSshConfig.ts` (module-level cached). Do
  not call `invoke("parse_ssh_config")` directly.
- **Shell discovery** → `hooks/useShells.ts` (module-level cached). Do not call
  `invoke("find_shells")` directly.
- **Shell type / tab icon** → `lib/shellIcon.ts` (`getShellType`) is the single
  source for mapping a `TerminalProfile` to its icon category; `components/
  ShellIcon.tsx` renders it. Do not re-derive shell type from `exePath` in the
  TabBar or elsewhere.
- **Command → app icon** → `lib/appIcon.ts` (`getAppIcon`) is the single source
  for mapping a running command line to a tab icon (built-in table + user
  `commandIcons` rules, regex-vs-whole-line included); custom icons resolve
  through `lib/commandIconApi.ts`. Never match commands against icons anywhere
  else (TabBar, MCP, settings preview all go through `getAppIcon`).
- **Shared settings sub-forms** → `ShellSelector`, `SshFields`, `RenderSettings`.
  When a new settings page needs the same fields, reuse these components.

Rule of thumb: **if you are about to copy-paste >10 lines from another file,
stop and extract.**

### 3.3 State lives as high as needed, no higher

- Cross-cutting state (config, theme, window maximize) is computed once at the
  top (`App.tsx` or a provider) and passed down via props.
  - `isMaximized` — computed once in `App`, passed to `TitleBar` and
    `usePaddingOffset`. Components must NOT independently listen to window
    resize to derive maximize state.
  - `paddingOffset` — derived from `isMaximized`; computed in `App`, passed to
    each `Term` via prop. A `Term` must not call `usePaddingOffset` itself.
  - `effectiveTheme` / `bg` / `fg` — derived once in `useEffectiveTheme`,
    called from `App`. The HeroUI `dark`/`light` class sync happens there and
    only there.
  - `parsedBindings` — `useMemo` in `App`, passed to every `Term` as a prop.
    A `Term` must not call `parseBindings` itself.

- Local UI state (drafts, hover, modal open) stays in the component.

### 3.4 Naming conventions

- React hooks: file `hooks/useFoo.ts` or `hooks/foo.tsx` (if it provides JSX),
  export `useFoo`. Note: `getMaximized` was renamed to `useMaximized` — do not
  reintroduce non-`use`-prefixed hook names.
- Pure modules: `lib/foo.ts`, export named functions.
- Config sentinels (`SETTINGS_TAB_ID`, `ABOUT_TAB_ID`) live in `constants.ts`.

### 3.5 Keeping `App.tsx` lean

`App.tsx` orchestrates: terminal lifecycle, tab switching, command-palette
action list, and wiring props to children. It must NOT contain:

- Inline theme derivation logic → `useEffectiveTheme`.
- Inline `invoke` calls → `lib/terminalApi.ts`.
- Duplicate profile-lookup logic → use the `findProfile` helper.

If `App.tsx` grows past ~400 lines of real logic again, extract a hook
(e.g. `useTerminalManager`) rather than letting it balloon.

### 3.6 Logging conventions

The app has **one logger**: the Rust `tauri-plugin-log` writes to a rotating
log file in the app log dir, and its `Webview` target forwards the same stream
to the frontend. The frontend `@tauri-apps/plugin-log` (`info`/`debug`/`warn`/
`error`) feeds back into that same file, so logs from both layers end up in
**one place** — the file `DeveloperSettings` exposes via "Log Directory → Open".

**Rule: every async operation, backend call, and error path must log its
outcome.** Silent failures (`let _ =`, `.then()` with no `.catch`, `.catch(() => [])`)
are forbidden. When you add a new `invoke`/`listen`/async call, wire its failure
path to the logger.

#### Where each log belongs

| Layer | Mechanism |
|-------|-----------|
| Rust backend | `log::{debug, info, warn, error}` — already initialized in `lib.rs` (Info by default, Debug for `lumina_terminal_lib`). |
| Frontend | `import { debug, info, warn, error } from "@tauri-apps/plugin-log"`. **Never** use `console.log`/`console.error` — those do NOT reach the log file. |

#### Backend (Rust) rules

1. **Log before panicking.** Do NOT use bare `.expect("...")` — it bypasses the
   log framework, so the failure never reaches the file. Use the established
   pattern: `.unwrap_or_else(|e| { log::error!("...: {}", e); panic!("...: {}", e); })`.
2. **Panics are a last resort.** Prefer returning a `Result`/`Option` and
   logging at `warn!`/`error!`. Only panic for truly unrecoverable state
   (corrupted mutex, pty spawn failure).
3. **Every `#[tauri::command]` handler logs its error/edge paths.** A missing
   terminal, a failed read, or a rejected operation must produce a log line.
   Be consistent: `kill_terminal`, `write_to_terminal`, `resize_terminal`, and
   `set_output_mode` all `warn!` on a missing id — keep new handlers the same.
4. **Never drop a `Result` silently.** `let _ = foo();` hides failures. Use
   `if let Err(e) = foo() { log::warn!(...) }` (or `.unwrap_or_else` per rule 1
   when the failure is fatal).
5. **Log level by intent:**
   - `error!` — operation failed and could not recover (spawn, kill, emit exit).
   - `warn!` — operation failed but degraded gracefully (missing terminal, bad
     input, optional feature disabled).
   - `info!` — significant lifecycle event the user could correlate with
     behavior (app startup, terminal start/exit, child process exit).
   - `debug!` — diagnostic detail for development (thread start/stop, lock
     contention, speculative reads like theme probing).

#### Frontend (TypeScript/React) rules

1. **Use `@tauri-apps/plugin-log`, never `console.*`.** `console.log` only
   prints to the webview devtools, not the file users actually open.
2. **Every `invoke()` / `listen()` / fire-and-forget promise needs a failure
   path.** `.then()` with no `.catch` swallows rejections silently. Attach a
   `.catch((e) => error(\`...\`).catch(() => {}))`.
3. **Backend `invoke` calls go through `lib/terminalApi.ts`** (or a sibling
   `lib/<domain>Api.ts`). These wrappers centralize the log-on-reject logic via
   `invokeWithLog`, so new commands get error logging for free. Do not call
   `invoke("...")` directly in a component — and never add a second parallel
   invoke helper; extend the existing one.
4. **Guard logger calls themselves.** The plugin-log functions return promises
   that can reject; chain `.catch(() => {})` so a logging failure never breaks
   app flow. The `invokeWithLog` helper shows the pattern.
5. **Log level mirrors the backend:** `error` for unrecoverable, `warn` for
   degraded fallbacks, `info` for lifecycle, `debug` for detail. Reserve `info`
   for events a user could correlate with what they did (tab opened, settings
   saved), not for routine internal transitions.
6. **Do not log on hot paths.** Edge-background polling, per-keystroke writes,
   and per-tick reader flushes are too frequent to log per iteration. Log the
   lifecycle (start/stop, first failure) once, not every cycle.

#### What to log vs. what not to log

- **Always log:** backend command failures, PTY spawn/kill, listener
  registration failures, config load/save failures, promise rejections that
  would otherwise vanish, panics (before they happen).
- **Never log:** routine success of hot operations, raw user keystrokes/output
  (privacy + volume), per-render state, unmodified values passed through.

### 3.7 Backend tests are mandatory (`src-tauri/tests/`)

Every backend change ships with tests. Integration tests live in
`src-tauri/tests/<module>.rs`, one file per `src/` module, and target the lib
crate (`lumina_terminal_lib`). CI (`.github/workflows/ci-backend.yml`) runs the
whole suite with `cargo test` on all three desktop platforms alongside
`cargo check`, so an untested regression fails the build.

- **Test the logic, not the Tauri plumbing.** If a `#[tauri::command]` handler
  contains parse/compute logic, extract it into a named `pub fn` with explicit
  inputs and test THAT; the command wrapper stays a thin shell. Established
  examples to follow: `proxy`'s per-source parsers, `ssh::parse_ssh_config_content`,
  `shells::scan_path_for`, `terminal::flush_utf8_pass`,
  `install_source::{pacman,dpkg,rpm}_owner_package`, `mcp::strip_ansi`,
  `fonts::first_concrete_family`.
- **Modules are `pub` in `lib.rs` for exactly this purpose** (the crate is not
  consumed as a library otherwise). Keep the `pub` surface to what tests need.
- **No env-var mutation in tests.** Tests run in parallel threads of one
  process, so `std::env::set_var` races. Parameterize the code instead
  (that's why `scan_path_for` takes the PATH value rather than reading it).
- **Platform-dependent tests self-skip** — gate with `#![cfg(unix)]` /
  `#[cfg(target_os = ...)]`, or print a skip notice and return when an
  external dependency is absent (see `tests/proxy.rs`' gsettings e2e and
  `tests/shell_hooks.rs`). A test must never fail on an unrelated platform.
- **Sample-output parsers** (proxy sources, package managers) are tested
  against captured real stdout strings — both the hit and the miss shapes.
- **Real-process tests are allowed** where they're read-only and cheap
  (`tests/command_tracker.rs` spawns a `sleep` child and reads its /proc/ps
  entry). Mind the fork→execve race: poll briefly instead of reading once.
- **Verify locally** with `cargo test --manifest-path src-tauri/Cargo.toml`
  before committing. A backend change without a matching test addition (new
  test file, or new cases in the module's existing file) is incomplete.

---

## 4. Rules for AI Contributors

1. **Do not duplicate.** Search the codebase for existing logic before writing
   new. Grep for function names, `invoke("...")` strings, and UI patterns.
2. **Respect the layering.** Put pure logic in `lib/`, React-aware logic in
   `hooks/`, JSX in `components/`. Do not import `components/` from `lib/` or
   `hooks/`.
3. **One source of truth per concern.** If you add a new backend command,
   wrap it in `lib/terminalApi.ts` (or a new `lib/<domain>Api.ts`) and import
   the wrapper everywhere. If you add a new derived value shared across
   components, make it a hook in `hooks/`.
4. **Every async operation and error path must log.** See §3.6 for the full
   rules. In short: never use bare `.expect()`/`console.*` or a `.then()` with
   no `.catch` — log via the plugin logger before panicking and on every
   rejection. New `invoke` commands go through the `invokeWithLog` wrapper so
   they get error logging for free.
5. **Props over re-derivation.** If a value is already computed in a parent
   (theme, maximize, padding, parsed bindings), pass it down. Do not
   re-compute it in the child.
6. **No dead code.** If you remove the last consumer of a file, delete the
   file. Do not leave unused components (the old `ResizeHandle.tsx` was dead
   for a long time before removal).
7. **Keep `lib/` React-free** (except the existing `useKeyboardBindings`
   exception). Pure functions are easier to test and reuse.
8. **Match existing style.** Tabs for indentation, double quotes for JSX
  attribute strings where the file already uses them, `import ... from
  "...ts"` with explicit extensions (bundler resolution). Follow the
  surrounding code's conventions.
9. **Verify with `pnpm build`** after changes. The tsconfig is strict
   (`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`) —
   unused imports/vars will fail the build. Use this as a guardrail.
10. **Behavior-preserving refactors only** unless explicitly asked. Keep
   props, command names, and event names (`term-write-${id}`, `term-exit-${id}`)
   stable — the Rust backend and frontend are coupled by these strings.
11. **Document significant new modules** here in §2 (Source Map) so the next
    contributor knows they exist.
12. If you add new dependencies, add them into README with a link to its
    official website or repo.
13. **Keep all README languages in sync.** The README exists in two languages:
    `README.md` (English) and `README_zh.md` (Simplified Chinese). Any change
    to one — features, dependencies, structure, wording — MUST be mirrored in
    the other in the same change. Never update only one.
14. You must follow [editorconfig](./.editorconfig) to make sure the code style
    is maintained.
15. **Backend changes ship with tests** in `src-tauri/tests/` — a new command,
    parser, or behavior change is incomplete without test coverage, and CI
    runs the full suite on every push. See §3.7 for the conventions (pure-fn
    extraction, self-skipping platform tests, no env mutation).

---

## 5. When You're Unsure

- **Where does X belong?** Check §2 and §3.1. Pure logic → `lib/`; React-aware
  → `hooks/`; JSX → `components/`.
- **Is this a duplicate?** Grep. If a function with the same purpose exists,
  reuse it; if the signatures differ slightly, generalize the existing one
  rather than adding a parallel one.
- **Should this be shared state?** If two components need the same derived
  value, compute once at their nearest common ancestor and pass via props.
- **Can I change a backend command/event name?** Only if you update both
  `src-tauri/src/` and `src/` together. These are coupled by string.
- **Where does a log/error go?** See §3.6. Rust → `log::{debug,info,warn,error}`;
  frontend → `@tauri-apps/plugin-log` (`never console.*`). Log before panicking,
  and attach `.catch` to every promise — never leave a silent `let _ =` or
  bare `.then()`.
