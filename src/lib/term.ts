import {TerminalProfile, TerminalRenderOptions} from "../types/terminal.ts";
import {ITheme} from "@xterm/xterm";
import {
    DEFAULT_TERMINAL_THEME,
    GITHUB_LIGHT_TERMINAL_THEME,
    TERMINAL_CORNER_CONTENT_INSET,
    TERMINAL_LEFT_CONTENT_INSET,
} from "../constants.ts";
import {invoke} from "@tauri-apps/api/core";
import {appDataDir, join} from "@tauri-apps/api/path";
import {stat} from "@tauri-apps/plugin-fs";
import {error} from "@tauri-apps/plugin-log";

export function parseProfilePadding(profile: TerminalProfile, paddingOffset: number) {
    let paddingLeft = 0, paddingRight = 0, paddingTop = 0, paddingBottom = 0;
    if (profile.padding) {
        if (typeof profile.padding === "number") {
            paddingLeft = profile.padding; paddingRight = profile.padding;
            paddingTop = profile.padding; paddingBottom = profile.padding;
        } else {
            // x, y
            paddingLeft = profile.padding.x ?? paddingLeft; paddingRight = profile.padding.x ?? paddingRight;
            paddingTop = profile.padding.y ?? paddingTop; paddingBottom = profile.padding.y ?? paddingBottom;
            // left, right, top, bottom
            paddingLeft = profile.padding.left ?? paddingLeft;
            paddingRight = profile.padding.right ?? paddingRight;
            paddingTop = profile.padding.top ?? paddingTop;
            paddingBottom = profile.padding.bottom ?? paddingBottom;
        }
    }
    // The terminal surface is clipped to a 14px rounded rectangle. A zero
    // profile padding would put the first/last cells inside those clipped
    // corners, so preserve a small content-safe inset on every side. The first
    // column gets a little more room for prompts/cursors. Profile padding
    // remains the total requested padding: values above the minimum win rather
    // than having another hidden inset added to them.
    paddingLeft = Math.max(paddingLeft, TERMINAL_LEFT_CONTENT_INSET) + paddingOffset;
    paddingRight = Math.max(paddingRight, TERMINAL_CORNER_CONTENT_INSET) + paddingOffset;
    paddingTop = Math.max(paddingTop, TERMINAL_CORNER_CONTENT_INSET) + paddingOffset;
    paddingBottom = Math.max(paddingBottom, TERMINAL_CORNER_CONTENT_INSET) + paddingOffset;
    return {
        left: paddingLeft,
        right: paddingRight,
        top: paddingTop,
        bottom: paddingBottom,
    };
}

/** OS light/dark preference used to pick the fallback terminal palette when a
 *  profile has no themePath and no inline theme. `null`/undefined = unresolved,
 *  treated as dark (matches useSystemTheme's convention for unknown/未决). */
export type SystemTheme = "light" | "dark" | null;

// Theme-file reading used to cost up to 4 serial IPC round-trips per call
// (appDataDir → join → path_exist → read_file), and the same file was read
// again by useEffectiveTheme on every profile/config change. The caches below
// cut a warm read to a single stat IPC; the stat's mtime still validates the
// entry, so editing the theme file externally keeps working (the next
// re-resolve sees a new mtime and re-reads).
/** Resolved app data dir — fixed for the session, fetched once. */
let appDataDirPromise: Promise<string> | null = null;
/** themePath → joined absolute path (the join is an IPC; memoized per path). */
const themeFullPathCache = new Map<string, string>();
/** Absolute path → parsed theme JSON + the mtime it was read at. */
const themeFileCache = new Map<string, {mtimeSec: number | null; json: Record<string, unknown> | null}>();

/**
 * Read + parse a theme file (JSON), trying the app-data-relative path first
 * and the raw configured path second (absolute / cwd-relative). Returns the
 * parsed object, or null when no candidate exists / the file is unreadable /
 * the JSON is invalid (the error is logged). Cached per file, validated
 * against the file's mtime.
 */
async function readThemeFile(themePath: string): Promise<Record<string, unknown> | null> {
    appDataDirPromise ??= appDataDir();
    let fullPath = themeFullPathCache.get(themePath);
    if (fullPath === undefined) {
        fullPath = await join(await appDataDirPromise, themePath);
        themeFullPathCache.set(themePath, fullPath);
    }
    for (const path of [fullPath, themePath]) {
        const info = await stat(path).catch(() => null);
        if (!info?.isFile) continue;
        const mtimeSec = info.mtime ? Math.floor(info.mtime.getTime() / 1000) : null;
        const cached = themeFileCache.get(path);
        if (cached && cached.mtimeSec === mtimeSec) return cached.json;
        const text = await invoke<string>("read_file", {path});
        let json: Record<string, unknown> | null = null;
        if (text) {
            try {
                json = JSON.parse(text) as Record<string, unknown>;
            } catch (e) {
                error(`Failed to parse theme at ${path}: ${e}`).catch(() => {});
            }
        }
        themeFileCache.set(path, {mtimeSec, json});
        return json;
    }
    return null;
}

export async function parseProfileTheme(profile: TerminalRenderOptions, defaultTheme?: ITheme, systemTheme?: SystemTheme) {
    // 起始兜底配色：显式 defaultTheme > 按 systemTheme 在亮/暗间选择。
    // dark 与未决(null)都走原黑底，保持向后兼容且与 useSystemTheme 约定一致。
    let theme: ITheme = defaultTheme ?? (systemTheme === "light" ? GITHUB_LIGHT_TERMINAL_THEME : DEFAULT_TERMINAL_THEME);
    if (profile.themePath) {
        const parsed = await readThemeFile(profile.themePath);
        if (parsed) {
            theme = {...theme, ...parsed};
        }
    }
    if (profile.theme) {
        theme = {...theme, ...profile.theme};
    }
    return theme;
}

export async function parseProfile(profile: TerminalProfile, globalProfile?: TerminalRenderOptions, systemTheme?: SystemTheme): Promise<TerminalProfile> {
    const cleanGlobal = globalProfile ? Object.fromEntries(Object.entries(globalProfile).filter(([_, v]) => v !== undefined)) : {};
    const cleanProfile = Object.fromEntries(Object.entries(profile).filter(([_, v]) => v !== undefined));
    const p = {...cleanGlobal, ...cleanProfile} as TerminalProfile;
    if (globalProfile) {
        let globalTheme = await parseProfileTheme(globalProfile, undefined, systemTheme);
        p.theme = await parseProfileTheme(profile, globalTheme, systemTheme);
    } else {
        p.theme = await parseProfileTheme(p, undefined, systemTheme);
    }
    delete p.themePath;
    return p;
}
