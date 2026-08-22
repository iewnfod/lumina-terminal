/**
 * Custom command-icon domain API (sibling to terminalApi.ts / mcpApi.ts):
 * invoke wrappers for importing/pruning user icon files, plus webview URL
 * resolution for `custom:` icon ids. Icons are stored by the backend under
 * `<app data dir>/command-icons/` (src-tauri/src/command_icons.rs) and served
 * through the asset protocol, whose scope is limited to that directory
 * (tauri.conf.json).
 */
import {convertFileSrc, invoke} from "@tauri-apps/api/core";
import {appDataDir, join} from "@tauri-apps/api/path";
import {error} from "@tauri-apps/plugin-log";

/** Directory (under the app data dir) the backend stores imported icons in.
 *  Mirrors COMMAND_ICONS_DIR in src-tauri/src/command_icons.rs. */
const COMMAND_ICONS_DIR = "command-icons";

/** Copy a user-picked SVG/PNG into the app's icon storage. Returns the stored
 *  file name to embed in a `custom:` icon id (lib/appIcon.ts). Rejects on
 *  unsupported format / oversize file / IO failure. */
export function importCommandIcon(src: string): Promise<string> {
    return invoke<string>("import_command_icon", {src}).catch((e) => {
        error(`Failed to import command icon: ${e}`).catch(() => {});
        throw e;
    });
}

/** Delete stored icon files whose names are not in `keep` (the names the
 *  saved rules still reference). Call after committing rule changes. */
export function pruneCommandIcons(keep: string[]): Promise<void> {
    return invoke<void>("prune_command_icons", {keep}).catch((e) => {
        error(`Failed to prune command icons: ${e}`).catch(() => {});
        throw e;
    });
}

/** List all stored icon file names (sorted). The settings picker offers every
 *  stored icon, so a rule can be switched away and back without re-importing;
 *  files only disappear when a save prunes the unreferenced ones. */
export function listCommandIcons(): Promise<string[]> {
    return invoke<string[]>("list_command_icons").catch((e) => {
        error(`Failed to list command icons: ${e}`).catch(() => {});
        throw e;
    });
}

// URL resolution is async (appDataDir + convertFileSrc), but AppIcon renders
// synchronously and re-renders often — so resolved URLs are cached per file
// name at module level. The first resolve of a given icon lands a frame late,
// every later render is instant.
const urlCache = new Map<string, string>();
let dirPromise: Promise<string> | null = null;

async function iconsDir(): Promise<string> {
    dirPromise ??= join(await appDataDir(), COMMAND_ICONS_DIR);
    return dirPromise;
}

/** Synchronous cache peek — returns the webview URL for a stored icon file if
 *  it was resolved before, else null (caller falls back to the async path). */
export function peekCustomIconSrc(name: string): string | null {
    return urlCache.get(name) ?? null;
}

/** Resolve the webview URL for a stored icon file (asset protocol). Cached. */
export async function customIconSrc(name: string): Promise<string> {
    const cached = urlCache.get(name);
    if (cached) return cached;
    const url = convertFileSrc(await join(await iconsDir(), name));
    urlCache.set(name, url);
    return url;
}
