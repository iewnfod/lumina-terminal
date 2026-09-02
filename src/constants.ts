import {ITheme} from "@xterm/xterm";
import {Binding, GlobalConfig} from "./types/config.ts";
import {IImageAddonOptions} from "@xterm/addon-image";

export const DEFAULT_TERMINAL_THEME: ITheme = {
    background: "#000000",
    foreground: "#ffffff",
    cursor: "#ffffff",
    cursorAccent: "#000000",
    selectionBackground: "rgba(255, 255, 255, 0.3)",

    // 标准 16 色 ANSI 工具盘
    black: "#000000",
    red: "#cd0000",
    green: "#00cd00",
    yellow: "#cdcd00",
    blue: "#0000ee",
    magenta: "#cd00cd",
    cyan: "#00cdcd",
    white: "#e5e5e5",

    // Bright (高亮) 16 色 ANSI
    brightBlack: "#7f7f7f",
    brightRed: "#ff0000",
    brightGreen: "#00ff00",
    brightYellow: "#ffff00",
    brightBlue: "#5c5cff",
    brightMagenta: "#ff00ff",
    brightCyan: "#00ffff",
    brightWhite: "#ffffff",
};

/** 兜底终端配色（亮色）— GitHub Light。
 *  与 {@link DEFAULT_TERMINAL_THEME}（暗色）成对：当一个 profile 既无
 *  themePath 又无内联 theme 时，按系统明暗在这两者间选择（亮 → 本配色，
 *  暗/未决 → DEFAULT_TERMINAL_THEME）。取自用户 themes/github_light.json。 */
export const GITHUB_LIGHT_TERMINAL_THEME: ITheme = {
    background: "#ffffff",
    foreground: "#24292f",
    cursor: "#24292f",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(36, 41, 47, 0.3)",

    // 标准 16 色 ANSI 工具盘
    black: "#24292e",
    red: "#d73a49",
    green: "#28a745",
    yellow: "#dbab09",
    blue: "#0366d6",
    magenta: "#5a32a3",
    cyan: "#0598bc",
    white: "#6a737d",

    // Bright (高亮) 16 色 ANSI
    brightBlack: "#959da5",
    brightRed: "#cb2431",
    brightGreen: "#22863a",
    brightYellow: "#b08800",
    brightBlue: "#005cc5",
    brightMagenta: "#5a32a3",
    brightCyan: "#3192aa",
    brightWhite: "#d1d5da",
};

/** The user's config file: a plain TOML document (root table IS the config,
 *  no wrapper key) in the app data dir. Read/written via plugin-fs by
 *  lib/configFile.ts. The legacy config.json is parsed and migrated on
 *  first read when this file is absent. */
export const CONFIG_SAVE_PATH = "config.toml";

/** Pre-TOML config file (a plugin-store JSON). Still parsed for migration
 *  (both its `{"config": {...}}` wrapper shape and a plain JSON root); see
 *  lib/configFormat.ts + lib/configFile.ts. */
export const LEGACY_CONFIG_SAVE_PATH = "config.json";

/** What the legacy config.json is renamed to after a successful migration,
 *  so nothing is lost and the retired file is obvious. */
export const LEGACY_CONFIG_BACKUP_PATH = "config.json.bak";

/** LazyStore file holding the last-saved terminal session (one key "session").
 * Written on window close when sessionSaveMode != "never"; read once at startup
 * to restore tabs. Kept separate from config.toml so session data never
 * pollutes the user's app config. See lib/session.ts. */
export const SESSION_STORE_PATH = "session.json";

/** Shared height for the custom chrome and the macOS traffic-light safe area. */
export const CHROME_TITLE_BAR_HEIGHT = 36;

/** Minimum inset keeping xterm cells clear of the 14px rounded surface corners. */
export const TERMINAL_CORNER_CONTENT_INSET = 5;

/** Extra leading inset keeping the first terminal column clear and readable. */
export const TERMINAL_LEFT_CONTENT_INSET = 7;

export const DEFAULT_BINDINGS: Binding[] = [
    {
        key: "t",
        with: ["CtrlOrCommand"],
        action: "newTab",
    },
    {
        key: "w",
        with: ["CtrlOrCommand"],
        action: "closeTab",
    },
    {
        key: ",",
        with: ["CtrlOrCommand"],
        action: "openSettings",
    },
    {
        key: "P",
        with: ["CtrlOrCommand", "shift"],
        action: "openCommandPalette",
    },
    {
        key: "1",
        with: ["CtrlOrCommand"],
        action: "toTab",
        args: { index: "0" },
    },
    {
        key: "2",
        with: ["CtrlOrCommand"],
        action: "toTab",
        args: { index: "1" },
    },
    {
        key: "3",
        with: ["CtrlOrCommand"],
        action: "toTab",
        args: { index: "2" },
    },
    {
        key: "4",
        with: ["CtrlOrCommand"],
        action: "toTab",
        args: { index: "3" },
    },
    {
        key: "5",
        with: ["CtrlOrCommand"],
        action: "toTab",
        args: { index: "4" },
    },
    {
        key: "6",
        with: ["CtrlOrCommand"],
        action: "toTab",
        args: { index: "5" },
    },
    {
        key: "7",
        with: ["CtrlOrCommand"],
        action: "toTab",
        args: { index: "6" },
    },
    {
        key: "8",
        with: ["CtrlOrCommand"],
        action: "toTab",
        args: { index: "7" },
    },
    {
        key: "9",
        with: ["CtrlOrCommand"],
        action: "toTab",
        args: { index: "last" },
    },
    {
        key: "L",
        with: ["CtrlOrCommand", "shift"],
        action: "tearOffTab",
    },
    {
        key: "f",
        with: ["CtrlOrCommand"],
        action: "search",
    },
    // Copy the current selection. With no selection the key falls through to
    // the shell (lib/bindings.ts), so plain Ctrl+C stays SIGINT-safe even when
    // the user rebinds copy onto it.
    {
        key: "C",
        with: ["CtrlOrCommand", "shift"],
        action: "copy",
    },
    {
        key: "A",
        with: ["CtrlOrCommand", "shift"],
        action: "selectAll",
    },
    // Paste the clipboard into the terminal. Plain Ctrl+V is deliberately NOT
    // bound: it stays unintercepted (quoted-insert in readline, and the
    // browser-native paste event keeps working as it always has).
    {
        key: "V",
        with: ["CtrlOrCommand", "shift"],
        action: "paste",
    },
];

export const DEFAULT_CONFIG: GlobalConfig = {
    language: 'en-us',
    profiles: [],
    showTabBar: false,
    enableColorSpread: false,
    themeMode: "terminal",
    autoUpdateOnStartup: true,
    inheritWorkingDirectory: false,
    imeDuplicateInputFix: true,
    rememberWindowPosition: false,
    rememberWindowSize: false,
    sessionSaveMode: "ask",
    sessionSaveScrollback: false,
    loadDefaultProfileOnStartup: true,
    autoProxy: true,
    enableMcp: false,
};

/** Default loopback port for the read-only MCP server. */
export const MCP_DEFAULT_PORT = 28700;

export const SETTINGS_TAB_ID = "__lum__settings__";

export const ABOUT_TAB_ID = "__lum__about__";

export const IMAGE_ADDON_SETTINGS: IImageAddonOptions = {
    enableSizeReports: true,    // whether to enable CSI t reports (see below)
    pixelLimit: 16777216,       // max. pixel size of a single image
    sixelSupport: true,         // enable sixel support
    sixelScrolling: true,       // whether to scroll on image output
    sixelPaletteLimit: 4096,    // initial sixel palette size
    sixelSizeLimit: 33554432,   // size limit of a single sixel sequence
    storageLimit: 128,          // FIFO storage limit in MB
    showPlaceholder: true,      // whether to show a placeholder for evicted images
    iipSupport: true,           // enable iTerm IIP support
    iipSizeLimit: 33554432,     // size limit of a single IIP sequence
}
