import {TerminalProfile, TerminalRenderOptions} from "./terminal.ts";
import {Languages} from "../hooks/i18n.tsx";

export type Actions = "newTab" | "openConfigFile" | "closeTab" | "openCommandPalette" | "openSettings" | "toTab" | "toggleSidebar" | "tearOffTab" | "search";
export type WithKeys = "ctrl" | "shift" | "alt" | "command" | "CtrlOrCommand";

export interface Binding {
    key: string;
    with: WithKeys[];
    action: Actions;
    args?: Record<string, string>;
}

export interface GlobalConfig {
    language: Languages;
    profiles: TerminalProfile[];
    globalProfile?: TerminalRenderOptions;
    showTabBar?: boolean;
    bindings?: Binding[];
    closeWindowOnLastTab?: boolean;
    copyWithCtrl?: boolean;
    /** When true (default), a fullscreen TUI's uniform edge background "spreads"
     *  across the whole window chrome. When false, the app keeps the terminal
     *  theme's background and the sampling/polling is disabled. */
    enableColorSpread?: boolean;
    /** How the app's light/dark appearance is decided. This controls only the
     *  light/dark *rendering* of chrome (text, icons, glass, overlays); the
     *  background *color* still follows the terminal / fullscreen TUI.
     *  - "system"   → follow the OS light/dark preference
     *  - "terminal" → derive from the terminal background color (legacy)
     *  - "light"    → always light
     *  - "dark"     → always dark
     *  Default "terminal" preserves existing behavior. */
    themeMode?: "system" | "terminal" | "light" | "dark";
    autoUpdateOnStartup?: boolean;
    /** When true, a new terminal tab inherits the ACTIVE terminal's current
     * working directory as its startup cwd (instead of the profile default).
     * Lets users hop between shells/profiles without re-`cd`'ing. Off by
     * default. Only affects newly created tabs; the initial tab of a window
     * has no active terminal to inherit from and uses the profile default. */
    inheritWorkingDirectory?: boolean;
    /** When true (default), install the IME duplicate-input guard on each
     *  terminal's hidden textarea (lib/imeCompositionGuard.ts). The guard
     *  normalizes WebKitGTK/IBus commits that arrive without a matching
     *  compositionstart so committed text is sent exactly once. It rewrites
     *  the textarea on each such commit, which can cost IME responsiveness on
     *  slower machines — turn it off to restore raw xterm behavior (IME input
     *  on Linux/WebKitGTK may then duplicate again). */
    imeDuplicateInputFix?: boolean;
    /** When true, restore the main window to its last position on startup
     * (main window only; tear-off windows are positioned by their spawner). */
    rememberWindowPosition?: boolean;
    /** When true, restore the main window to its last size on startup. */
    rememberWindowSize?: boolean;
    /** Persisted main-window outer position in physical pixels. Written by
     * the runtime move listener while rememberWindowPosition is on; read once
     * at startup to restore. */
    rememberedWindowPosition?: {x: number; y: number};
    /** Persisted main-window inner size in physical pixels. Written by the
     * runtime resize listener while rememberWindowSize is on; read once at
     * startup to restore. */
    rememberedWindowSize?: {width: number; height: number};
    /** Whether to save open terminal tabs on exit and restore them on the next
     * launch. See lib/session.ts for the saved-session file.
     *  - "never"  → never persist
     *  - "always" → always save every terminal tab on window close
     *  - "ask"    → prompt the user on close (default; the dialog may rewrite
     *               this to always/never via "remember this choice") */
    sessionSaveMode?: "never" | "always" | "ask";
    /** When true, also serialize each terminal's scrollback into the saved
     * session and replay it on restore. Off by default — scrollback can make
     * the session file large. Only consulted when a save actually happens
     * (mode "always", or "ask" + user picks Save). */
    sessionSaveScrollback?: boolean;
    /** When true (default), open a tab with the default profile when Lumina
     * starts with nothing to restore. Only consulted when `sessionSaveMode` is
     * "never" — with saving on, launches restore a saved session (or seed a
     * default tab on first run) regardless of this flag. When false, a "never"-
     * mode launch starts with no tabs (the empty state takes over). */
    loadDefaultProfileOnStartup?: boolean;
    /** Per-profile "last opened" timestamps (ms since epoch), keyed by profile
     * name. Recorded each time a terminal is opened with that profile and used
     * to sort the empty-state quick-launch list by recency. Grows as profiles
     * are opened; entries for deleted profiles are harmless dead keys. */
    profileLastOpened?: Record<string, number>;
    /** Max number of profiles the empty-state quick-launch list shows (the most
     * recently opened first). An uncommon setting — no UI; edit config.json to
     * change. 0/undefined/unset → show all. */
    emptyStateMaxProfiles?: number;
    /** When true (default), watch the system proxy (GNOME gsettings / KDE
     *  kioslaverc / macOS scutil / Windows registry) and keep proxy env vars
     *  (http_proxy, HTTPS_PROXY, …) in sync inside every running bash/zsh/fish
     *  tab — applied silently by the shell-integration precmd hook before each
     *  prompt, with no restart. Only values Lumina injected are ever unset;
     *  manually exported proxies are left alone. Shells without integration
     *  (nu/pwsh/SSH) are not touched. */
    autoProxy?: boolean;
    /** When true, run a read-only MCP (Model Context Protocol) HTTP server on
     *  127.0.0.1 so a local AI client can see open tabs, the running command,
     *  the live cwd, and recent terminal output. Off by default. The server
     *  is read-only — there is deliberately no tool to write to the PTY. */
    enableMcp?: boolean;
    /** Port for the MCP server (loopback only). Defaults to 28700 when unset.
     *  Only consulted when the server (re)starts. */
    mcpPort?: number;
}
