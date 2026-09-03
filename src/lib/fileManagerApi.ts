/**
 * File-manager domain API (sibling to terminalApi.ts): the backend's
 * reveal-in-file-manager command (src-tauri/src/file_manager.rs) — opens a
 * directory, or reveals a file selected inside its parent, in the per-OS
 * file manager (xdg-open / Finder / Explorer).
 */
import {invokeLogged} from "./apiCore.ts";

/** Reveal `path` in the system file manager. Rejects (after logging) when
 *  the path doesn't exist or the spawn fails. */
export function openInFileManager(path: string): Promise<void> {
    return invokeLogged<void>("open_in_file_manager", {path}, {
        message: `Failed to open ${path} in the file manager`,
    });
}
