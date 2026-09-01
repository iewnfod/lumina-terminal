# Configuration Reference

> <a href="./Configuration_zh.md">简体中文</a> | <a href="./Configuration.md">English</a>

All Lumina Terminal settings live in a single JSON file (`config.json`). The in-app Settings UI (`Ctrl/Cmd + ,`) covers most of them; this reference also lists fields that are **config-file-only** (marked *no UI*) and fields the app writes itself at runtime (marked *runtime-written*) that you normally shouldn't touch.

> **Quit Lumina completely before editing config.json.** While the app is running it writes its in-memory config back to the file at any time (e.g. when you move the window or open a profile), which would overwrite your manual edits.

## Contents

- [1. Config file location](#1-config-file-location)
- [2. File structure](#2-file-structure)
- [3. Global settings (GlobalConfig)](#3-global-settings-globalconfig)
- [4. Profiles (profiles)](#4-profiles-profiles)
- [5. Render options (TerminalRenderOptions)](#5-render-options-terminalrenderoptions)
- [6. Theme files (themePath / theme)](#6-theme-files-themepath--theme)
- [7. Key bindings (bindings)](#7-key-bindings-bindings)
- [8. Command icon rules (commandIcons)](#8-command-icon-rules-commandicons)
- [9. Wrap as App (profiles[].launcher)](#9-wrap-as-app-profileslauncher)
- [10. Full example](#10-full-example)
- [11. Related files](#11-related-files)

---

## 1. Config file location

| OS | Path |
|----|------|
| Linux | `~/.local/share/com.iewnfod.lumina-terminal/config.json` |
| macOS | `~/Library/Application Support/com.iewnfod.lumina-terminal/config.json` |
| Windows | `%APPDATA%\com.iewnfod.lumina-terminal\config.json` |

You can also see/open it in-app: **Settings → General → Developer → Config File Path**.

## 2. File structure

The file has a single top-level key `"config"` and every setting is nested under it (this is the plugin-store format, not a typo):

```json
{
    "config": {
        "language": "en-us",
        "profiles": [],
        "themeMode": "terminal"
    }
}
```

- On load, keys present in the file override the built-in defaults; missing keys fall back to their defaults. Deleting a key restores its default.
- Unknown keys are harmless but have no effect.

## 3. Global settings (GlobalConfig)

### Basics

| Key | Type | Default | UI location | Description |
|-----|------|---------|-------------|-------------|
| `language` | `"en-us" \| "zh-cn"` | `"en-us"` | Settings → General → Basics | UI language. |
| `autoUpdateOnStartup` | boolean | `true` | Settings → General → Basics | Check for updates on launch. |

### Appearance

| Key | Type | Default | UI location | Description |
|-----|------|---------|-------------|-------------|
| `themeMode` | `"system" \| "terminal" \| "light" \| "dark"` | `"terminal"` | Settings → General → Appearance | How the app's light/dark *rendering* is decided (text, icons, glass, overlays). See below. |
| `enableColorSpread` | boolean | `false` | Settings → General → Appearance | Color spread: when on, a fullscreen TUI's uniform background color "spreads" across the whole window chrome (sidebar, title bar, window background follow it); when off, the chrome keeps the terminal theme's background (edge sampling still runs in the background for the terminal's own seam-free interior fill — it just stops propagating outward). |
| `edgeBackgroundCoverage` | number | `0.9` | **no UI** | Minimum share of the sampled outer edge cells one color must cover to be treated as the TUI background (remaining cells are edge-touching characters and are ignored). Valid range `(0, 1]`; `1` restores strict all-cells-uniform behavior. Invalid values fall back to the default. |

**`themeMode` values** (the background *color* always follows the terminal / fullscreen TUI; this key only controls light/dark rendering of chrome):

- `"system"` — follow the OS light/dark preference.
- `"terminal"` — derive from the terminal background color (legacy default).
- `"light"` / `"dark"` — force light / dark. When forced, even a fullscreen TUI cannot flip the window's appearance.

### Window

| Key | Type | Default | UI location | Description |
|-----|------|---------|-------------|-------------|
| `rememberWindowPosition` | boolean | `false` | Settings → General → Window | Restore the main window's last position on startup (main window only; tear-off windows are positioned by their spawner). Not supported on Wayland; the toggle is grayed out there. |
| `rememberWindowSize` | boolean | `false` | Settings → General → Window | Restore the main window's last size on startup. |
| `rememberedWindowPosition` | `{x, y}` | — | **runtime-written** | Last main-window position (physical pixels). Written by the move listener while `rememberWindowPosition` is on; read once at startup. |
| `rememberedWindowSize` | `{width, height}` | — | **runtime-written** | Last main-window size (physical pixels), same as above. |

### Tabs

| Key | Type | Default | UI location | Description |
|-----|------|---------|-------------|-------------|
| `showTabBar` | boolean | `false` | Settings → General → Tabs | Show the sidebar tab list (also toggleable via shortcut or the `--sidebar` launch flag). |
| `closeWindowOnLastTab` | boolean | `true` | Settings → General → Tabs | Close the window when the last tab closes. Set `false` to keep an empty window showing the profile quick-launch page (empty state). |
| `inheritWorkingDirectory` | boolean | `false` | Settings → General → Behavior | New tabs inherit the **active** terminal's current working directory instead of the profile default, so you can hop between shells/profiles without re-`cd`-ing. Only affects newly created tabs; a window's first tab has no active terminal to inherit from and uses the profile default. |

### Sessions (save on exit / restore on launch)

| Key | Type | Default | UI location | Description |
|-----|------|---------|-------------|-------------|
| `sessionSaveMode` | `"never" \| "always" \| "ask"` | `"ask"` | Settings → General → Sessions | What happens to open tabs when you quit. See below. |
| `sessionSaveScrollback` | boolean | `false` | Settings → General → Sessions | Also serialize each terminal's scrollback into the saved session and replay it on restore. Can make session.json large. Only consulted when a save actually happens (`always`, or `ask` + user picks Save). |
| `loadDefaultProfileOnStartup` | boolean | `true` | Settings → General → Sessions | Open a default-profile tab when starting with nothing to restore. Only applies when `sessionSaveMode` is `"never"`; with saving on, launches always try to restore a saved session first (first run seeds a default tab). |

**`sessionSaveMode` values**:

- `"never"` — never persist.
- `"always"` — always save every terminal tab on window close and restore on next launch.
- `"ask"` — prompt on close; the dialog's "remember this choice" rewrites this value to `always` or `never`.

Saved sessions live in a separate `session.json` (see [Related files](#11-related-files)), never in config.json.

### Behavior

| Key | Type | Default | UI location | Description |
|-----|------|---------|-------------|-------------|
| `imeDuplicateInputFix` | boolean | `true` | Settings → General → Behavior | IME duplicate-input fix: installs a guard on each terminal's hidden textarea that normalizes WebKitGTK/IBus commits arriving without a matching compositionstart, preventing duplicated CJK/IME input on Linux. The guard rewrites the textarea on each such commit, which can cost IME responsiveness on slower machines — turn it off if IME input feels sluggish (Linux/WebKitGTK may then duplicate input again). |
| `autoProxy` | boolean | `true` | Settings → General → Behavior | Auto proxy sync: watches the system proxy (GNOME gsettings / KDE kioslaverc / macOS scutil / Windows registry) and keeps `http_proxy`, `HTTPS_PROXY`, … in sync inside every running bash/zsh/fish tab — applied silently by the shell-integration precmd hook before each prompt, no restart needed. Only values Lumina injected are ever unset; manually exported proxies are left alone. Shells without integration (nu/pwsh/SSH) are not touched. Turning it off stops the watcher and deletes the hooks' env file, so running shells drop (only) the values Lumina injected. |

### AI / MCP

| Key | Type | Default | UI location | Description |
|-----|------|---------|-------------|-------------|
| `enableMcp` | boolean | `false` | Settings → General → Developer | Run a **read-only** MCP (Model Context Protocol) HTTP server on `127.0.0.1` so a local AI client can see open tabs, the foreground command, the live cwd, and recent output. There is deliberately no tool that writes to the PTY. |
| `mcpPort` | number | `28700` | Settings → General → Developer | MCP server port (loopback only). Changing it applies after you toggle the server off and on. |

### Advanced (no UI — edit config.json)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `edgeBackgroundCoverage` | number | `0.9` | See Appearance above. |
| `emptyStateMaxProfiles` | number | `0` (unlimited) | Max profiles the empty-state quick-launch list shows (most recently opened first; never-opened profiles keep their config order at the end). `0`/unset = show all. |
| `profileLastOpened` | `Record<name, timestamp-ms>` | — | **runtime-written**. Per-profile "last opened" timestamps driving the empty-state recency sort. Safe to delete (only loses the sort order). |

### Deprecated

| Key | Description |
|-----|-------------|
| `copyWithCtrl` | Legacy "Ctrl+C copies" toggle, replaced by the user-bindable `copy` action. On startup a one-time migration converts `true` into a plain Ctrl+C `copy` binding and strips the field. **Do not write this key by hand.** |

## 4. Profiles (profiles)

`profiles` is an array; each entry describes one terminal configuration (shell, appearance, startup behavior). Render fields inherit from `globalProfile` key by key (see [Render options](#5-render-options-terminalrenderoptions)).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `name` | string | (required) | Profile name, must be unique; also used as the identifier by the empty-state quick launch, MCP, launchers, etc. |
| `type` | `"local" \| "remote"` | `"local"` | Local shell or SSH remote. |
| `exePath` | string | required for local | Path to the local shell executable (e.g. `/bin/zsh`). Leave empty for remote profiles. |
| `cwd` | string | unset = home directory | Startup directory. |
| `default` | boolean | `false` | The default profile. Keep exactly one `true`; the first profile you create is marked default automatically. |
| `startupCommand` | string | empty = interactive shell | Command to run on startup (e.g. `"vim"`). Locally executed as `<exe> --login -i -c "<cmd>"` (the shell exits when the command does); for SSH profiles it is passed to the remote host (`ssh user@host <cmd>`). |
| `keepAfterExit` | `"exit" \| "shell" \| "freeze"` | `"exit"` | What happens after `startupCommand` finishes — see below. Only meaningful when `startupCommand` is set. |
| `ssh` | object | — | Connection parameters for remote profiles — see below. |
| `launcher` | object | — | "Wrap as App" configuration, see [section 9](#9-wrap-as-app-profileslauncher). The object's presence enables the feature. |
| (render options) | — | — | Any [render option](#5-render-options-terminalrenderoptions) (rows/cols/font/theme/padding/webgl/…) can be set per profile, overriding `globalProfile`. |

**`keepAfterExit` values**:

- `"exit"` (default) — the shell exits with the command and the tab closes. Ideal for single-shot launches (vim / opencode).
- `"shell"` — after the command, `exec` into an interactive shell: you can read the output AND keep working; the tab closes only when that shell exits.
- `"freeze"` — let the command + shell exit naturally, but the frontend suppresses the auto-close so the frozen output stays on screen for reading (read-only; the PTY is gone). Close it manually.

**`ssh` object**:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `host` | string | (required) | Hostname / IP. |
| `port` | number | `22` | Port. |
| `user` | string | current user | Login user. |
| `identityFile` | string | — | Private key path (passed as `ssh -i`). |

The UI can import hosts from `~/.ssh/config` (Settings → Profiles → New Remote Profile → Import from .ssh/config).

## 5. Render options (TerminalRenderOptions)

`globalProfile` (Settings → Global Profile) and each `profiles[]` entry share the same fields:

**Inheritance**: every key present on a profile overrides the same key on `globalProfile`; missing keys use the global value; keys set nowhere use the built-in default. The terminal color palette (`theme`) merges specially — see [Theme files](#6-theme-files-themepath--theme).

### Lumina-specific options

| Key | Type | Default | UI location | Description |
|-----|------|---------|-------------|-------------|
| `rows` / `cols` | number | — | Settings → Global Profile / Profiles | Initial rows/columns. Only the main window's first tab uses them to size the OS window; afterwards everything resizes freely. |
| `padding` | number or object | — | Settings → Global Profile / Profiles | Terminal inner padding (px). A number applies to all sides; the object form `{x, y, left, right, top, bottom}` sets sides individually (`x` = left/right, `y` = top/bottom; the finer keys win). Note: to keep the first/last cells clear of the rounded corners, actual padding has a floor (left ≥ 7, others ≥ 5); maximized windows add the system safe-area inset on top. The UI only edits the number form; use config.json for the object form. |
| `webgl` | boolean | `false` | Render Settings | Use the WebGL renderer for GPU-accelerated drawing. |
| `graphemeClusters` | boolean | `false` | Render Settings | Experimental: grapheme-cluster width rules, so complex emoji (ZWJ sequences, combining marks) measure correctly, at higher CPU cost. Supersedes the Unicode 11 width table when on. |
| `ligatures` | boolean | `false` | Render Settings | Programming ligatures. The backend reads the font file named by `fontFamily` and parses its GSUB table for precise, font-specific ligatures (Fira Code's `www`, `//`, …); falls back to a built-in list of ~50 common ligatures when the font can't be found. Pair with a ligature font (Fira Code, JetBrains Mono, …). |
| `fontStyle` | `"normal" \| "italic"` | `"normal"` | Render Settings | Font style. |
| `themePath` | string | — | Render Settings | Path to a theme JSON file — see [Theme files](#6-theme-files-themepath--theme). |
| `theme` | object | — | **no UI** | Inline theme (partial ITheme), same format as a theme file; takes precedence over `themePath`. |

### xterm.js passthrough options

`TerminalRenderOptions` extends xterm.js's `ITerminalOptions` directly, so every option below (and any other xterm.js option) can be written on `globalProfile` or a profile. Defaults are xterm.js built-ins.

| Key | Type | xterm default | Description |
|-----|------|---------------|-------------|
| `fontFamily` | string | platform monospace stack | Font family, e.g. `"JetBrains Mono"`. The ligature feature locates the font file through it. |
| `fontSize` | number | `15` | Font size (px). |
| `fontWeight` | `"normal" \| "bold" \| "100"…\|"900"` | `"normal"` | Weight for normal text. |
| `fontWeightBold` | same | `"bold"` | Weight for bold text. |
| `letterSpacing` | number | `0` | Letter spacing (whole pixels). |
| `lineHeight` | number | `1.0` | Line height multiplier. |
| `scrollback` | number | `1000` | Scrollback lines. With session scrollback saving (`sessionSaveScrollback`) this is also the amount replayed on restore. |
| `cursorStyle` | `"block" \| "underline" \| "bar"` | `"block"` | Cursor shape. |
| `cursorBlink` | boolean | `false` | Cursor blinking. |
| `cursorWidth` | number | `1` | Width of the `bar` cursor (px). |
| `cursorInactiveStyle` | `"outline" \| "block" \| "bar" \| "underline" \| "none"` | `"outline"` | Cursor style when unfocused. |
| `customGlyphs` | boolean | `true` | Draw built-in glyphs for block/box-drawing characters instead of font glyphs (better line continuity). |
| `drawBoldTextInBrightColors` | boolean | `true` | Render bold text in bright colors. |
| `minimumContrastRatio` | number | `1` | Minimum contrast ratio; > 1 dynamically adjusts foreground colors for readability. |
| `allowTransparency` | boolean | `false` | Allow non-opaque background colors. Must be set before `open()`; can hurt performance. |
| `altClickMovesCursor` | boolean | `true` | Alt+click moves the prompt cursor to the click position. |
| `convertEol` | boolean | `false` | Treat `\n` as `\r\n` (the PTY's termios normally handles this — don't enable casually). |
| `fastScrollSensitivity` | number | `5` | Fast-scroll multiplier while Alt is held. |
| `scrollSensitivity` | number | `1` | Mouse wheel scroll speed multiplier. |
| `smoothScrollDuration` | number | `0` | Smooth scroll duration (ms), `0` = off. |
| `tabStopWidth` | number | `8` | Tab stop width. |
| `wordSeparator` | string | common punctuation set | Characters that break double-click word selection. |
| `scrollOnUserInput` | boolean | `true` | Scroll to bottom on user input. |
| `scrollOnEraseInDisplay` | boolean | `false` | Scroll when receiving an `ED` (erase-in-display) sequence. |
| `rightClickSelectsWord` | boolean | `false` | Right-click selects the word under the cursor (macOS convention). |
| `rescaleOverlappingGlyphs` | boolean | `false` | Rescale overlapping glyphs. |
| `reflowCursorLine` | boolean | `false` | Reflow the cursor's line on resize (shells usually handle this themselves). |
| `screenReaderMode` | boolean | `false` | Screen reader support (NVDA/VoiceOver). |
| `disableStdin` | boolean | `false` | Disable keyboard input. |
| `ignoreBracketedPasteMode` | boolean | `false` | Ignore bracketed paste mode. |
| `macOptionIsMeta` | boolean | `false` | Treat Option as Meta on macOS. |
| `macOptionClickForcesSelection` | boolean | `false` | Option+click forces selection on macOS. |

## 6. Theme files (themePath / theme)

**Path resolution**: `themePath` is resolved **relative to the app data dir first** (`themes/my-theme.json` → `<app data dir>/themes/my-theme.json`), then tried as-given (absolute path). A theme file is JSON containing any subset of the keys below:

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

**Merge order** (later overrides earlier; all layers may be partial):

1. Built-in fallback — GitHub Light when the OS is light, the classic black theme otherwise (and when unresolved);
2. `globalProfile`'s `themePath` / `theme` (when a global profile exists);
3. the profile's own `themePath`;
4. the profile's own inline `theme`.

**Available color keys**:

| Category | Keys |
|----------|------|
| Basic | `background` `foreground` `cursor` `cursorAccent` |
| Selection | `selectionBackground` `selectionForeground` `selectionInactiveBackground` |
| Scrollbar | `scrollbarSliderBackground` `scrollbarSliderHoverBackground` `scrollbarSliderActive` |
| Standard 16 | `black` `red` `green` `yellow` `blue` `magenta` `cyan` `white` |
| Bright 16 | `brightBlack` `brightRed` `brightGreen` `brightYellow` `brightBlue` `brightMagenta` `brightCyan` `brightWhite` |
| Extended | `extendedAnsi` (256-color array) |

Color format: `#rgb` / `#rrggbb` hex; the selection keys also accept translucent `rgba(...)`.

## 7. Key bindings (bindings)

`bindings` is an array, one entry per shortcut:

```json
{
    "key": "t",
    "with": ["CtrlOrCommand"],
    "action": "newTab"
}
```

| Field | Description |
|-------|-------------|
| `key` | The keyboard event's `key` value. Single-character keys match case-insensitively (`"p"` matches the `"P"` produced by Shift+p). |
| `with` | Modifier array: `"ctrl"` `"shift"` `"alt"` `"command"` (macOS Cmd) `"CtrlOrCommand"` (Cmd on macOS, Ctrl elsewhere). The UI requires at least one modifier; keep at least one in hand-written entries too. |
| `action` | Action name — see below. |
| `args` | Optional argument object — see below. |

**Merge rule**: unset/empty `bindings` = all defaults. When set, your entries **replace the default entry with the same action + args**; defaults whose action is not covered remain active (e.g. a custom `newTab` replaces the default `Ctrl/Cmd+T`, but the `toTab` entries stay). Restore defaults by deleting the `bindings` field.

**Actions**:

| Action | Args | Description |
|--------|------|-------------|
| `newTab` | `{profileName: "name"}` (optional) | New tab; with `profileName` uses that profile, without uses the default. |
| `closeTab` | — | Close the current tab. |
| `toTab` | `{index: "0"…}` | Switch to tab by index; `"last"` for the last one. |
| `toggleSidebar` | — | Show/hide the sidebar. |
| `tearOffTab` | — | Tear the current tab into its own window (keeps the process and scrollback). |
| `search` | — | In-terminal search (the Ctrl+F bar). |
| `copy` | — | Copy the current selection. Special: **with no selection the key falls through to the shell** — so binding copy to Ctrl+C never breaks SIGINT. |
| `paste` | — | Paste the clipboard into the terminal. |
| `selectAll` | — | Select the whole terminal buffer. |
| `openSettings` | — | Open Settings. |
| `openConfigFile` | — | Open config.json with the system editor. |
| `openCommandPalette` | — | Open the command palette. |

**Default bindings**:

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + T` | New tab (default profile) |
| `Ctrl/Cmd + W` | Close current tab |
| `Ctrl/Cmd + ,` | Open Settings |
| `Ctrl/Cmd + Shift + P` | Command palette |
| `Ctrl/Cmd + 1…8` | Switch to tab 1…8 |
| `Ctrl/Cmd + 9` | Switch to last tab |
| `Ctrl/Cmd + Shift + L` | Tear off current tab |
| `Ctrl/Cmd + F` | Find in terminal |
| `Ctrl/Cmd + Shift + C` | Copy selection |
| `Ctrl/Cmd + Shift + A` | Select all |
| `Ctrl/Cmd + Shift + V` | Paste |

> Plain `Ctrl/Cmd + V` is deliberately not intercepted: quoted-insert in readline and the browser-native paste keep working as always.

## 8. Command icon rules (commandIcons)

The tab icon follows the running foreground command via a built-in mapping (`opencode`, `vim`/`nvim`/`neovim`, `claude` → their app icons; wrapper commands like `sudo`/`env`/`watch` are skipped to find the real command). The `commandIcons` array adds your own rules — **evaluated in order before the built-in table, first match wins**, so rules can override built-ins:

```json
{
    "commandIcons": [
        { "match": "cargo", "icon": "custom:rust.png" },
        { "match": "^git\\s+push", "isRegex": true, "icon": "neovim" }
    ]
}
```

| Field | Description |
|-------|-------------|
| `match` | When `isRegex` is `false` (default): a **command name** (basename) compared exactly against the first non-wrapper token of the command line (case-insensitive, `.exe` stripped). When `true`: a **JavaScript regex source** tested against the whole raw command line, so arguments can participate (`^git\s+push`). |
| `isRegex` | boolean, default `false`. |
| `icon` | Icon id: a built-in app icon (`opencode` `vim` `neovim` `claudecode` today) or `custom:<file>` — an image imported via Settings → Command Icons → "Import image…" (stored under the app data dir's `command-icons/`). |

UI: **Settings → Command Icons**, with a live test preview; saving prunes imported images no rule references.

## 9. Wrap as App (profiles[].launcher)

Adding a `launcher` object to a profile enables "Wrap as App": on every config save the app generates a desktop launcher (Linux `.desktop` / macOS `.app` / Windows Start-Menu shortcut) that opens the profile in its own window (via the app's `--profile` launch flags). Deleting a profile auto-prunes its launcher on the next save.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `title` | string | profile name | Launcher display name + window title. |
| `workingDirectory` | string | the profile's `cwd` | Overrides the startup directory. |
| `sidebar` | `"show" \| "hide"` | `"hide"` | Sidebar visibility of the launched window. |
| `icon` | string | auto | Icon: derived automatically from `startupCommand` (the `lib/appIcon.ts` mapping), falling back to the app's own icon; may also be a built-in icon id or `custom:<file>`. |

UI: **Settings → Profiles → pick a profile → Wrap as App**, including the generated launcher's location with a reveal button.

## 10. Full example

A config.json touching most fields (omit keys you don't need):

```json
{
    "config": {
        "language": "en-us",

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

## 11. Related files

| File / directory | Description |
|------------------|-------------|
| `config.json` | Everything documented here. |
| `session.json` | Saved terminal session (tab list + optional scrollback), driven by `sessionSaveMode`, kept separate from config.json. |
| `themes/` | Recommended home for theme JSON files (under the app data dir; the first location relative `themePath`s resolve against). |
| `command-icons/` | Imported custom command / launcher icons. |
| launchers | "Wrap as App" output: Linux `~/.local/share/applications/` (`lumina-` prefixed), macOS `~/Applications/`, Windows Start Menu `Programs/Lumina/`. |

The app data dir is the directory config.json lives in ([section 1](#1-config-file-location)).
