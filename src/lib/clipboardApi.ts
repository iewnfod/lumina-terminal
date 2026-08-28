import {readText} from "@tauri-apps/plugin-clipboard-manager";
import {warn} from "@tauri-apps/plugin-log";

/**
 * Clipboard-plugin wrappers (sibling to terminalApi.ts, per AGENTS.md §3.2).
 *
 * Only the READ side lives here: `navigator.clipboard.readText` is unreliable
 * in the Tauri webviews (WKWebView on macOS rejects it outright, WebKitGTK is
 * inconsistent), so reads go through tauri-plugin-clipboard-manager. Writes
 * keep using `navigator.clipboard.writeText`, which works everywhere the app
 * ships and already backs the copy action (lib/bindings.ts) and the settings
 * copy buttons.
 */

/**
 * Read the system clipboard as plain text, logging failures per §3.6. Never
 * rejects: resolves to "" when the clipboard is empty or unreadable, so a
 * caller can simply no-op on a falsy value.
 */
export function readClipboardText(): Promise<string> {
    return readText().then(
        (text) => text ?? "",
        (e: unknown) => {
            warn(`Failed to read clipboard: ${e}`).catch(() => {});
            return "";
        },
    );
}
