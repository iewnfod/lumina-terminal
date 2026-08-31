/**
 * File-manager domain API (sibling to terminalApi.ts): the backend's
 * reveal-in-file-manager command (src-tauri/src/file_manager.rs) — opens a
 * directory, or reveals a file selected inside its parent, in the per-OS
 * file manager (xdg-open / Finder / Explorer).
 */
import {invoke} from "@tauri-apps/api/core";
import {error} from "@tauri-apps/plugin-log";

/** Reveal `path` in the system file manager. Rejects (after logging) when
 *  the path doesn't exist or the spawn fails. */
export function openInFileManager(path: string): Promise<void> {
    return invoke<void>("open_in_file_manager", {path}).catch((e) => {
        error(`Failed to open ${path} in the file manager: ${e}`).catch(() => {});
        throw e;
    });
}
