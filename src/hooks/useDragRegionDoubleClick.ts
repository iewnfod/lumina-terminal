import {useEffect} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {error, info} from "@tauri-apps/plugin-log";
import {isDragRegionDoubleClick} from "../lib/dragRegionDoubleClick.ts";

/**
 * Double-click any window drag region (title bar, sidebar header, empty
 * state) to toggle maximize/restore. Mounted once per window at the App root,
 * so tear-off windows get the behavior too via their own webview.
 *
 * Tauri's injected drag-region script already attempts this, but its
 * `internal_toggle_maximize` path is unreliable on some platforms
 * (tauri#11945, wry#622), so Lumina owns the behavior: a capture-phase
 * mousedown listener sees the second click of a double-click before the
 * built-in bubble-phase script runs, suppresses it with
 * `stopImmediatePropagation` (otherwise both would toggle and cancel out),
 * then toggles explicitly via `maximize()`/`unmaximize()` — the same calls
 * the title-bar buttons use, which are known to work. Single-click dragging
 * is untouched: `detail === 1` mousedowns still fall through to the built-in
 * `start_dragging`.
 *
 * The resizable guard mirrors `internal_toggle_maximize`, so the fixed-size
 * welcome wizard (which locks resizable) never toggles.
 */
export function useDragRegionDoubleClick() {
    useEffect(() => {
        const toggleMaximize = () => {
            const win = getCurrentWindow();
            win.isResizable()
                .then((resizable) => {
                    if (!resizable) return null;
                    return win.isMaximized().then((maximized) =>
                        maximized
                            ? win.unmaximize().then(() => "unmaximized" as const)
                            : win.maximize().then(() => "maximized" as const),
                    );
                })
                .then((outcome) => {
                    if (outcome) {
                        info(`Window ${outcome} via drag-region double-click`).catch(() => {});
                    }
                })
                .catch((e) => {
                    error(`Drag-region double-click toggle failed: ${e}`).catch(() => {});
                });
        };

        const onMouseDown = (e: MouseEvent) => {
            if (!isDragRegionDoubleClick(e)) return;
            // Runs in the capture phase, i.e. before Tauri's bubble-phase
            // drag-region listener — claiming the event stops the built-in
            // script from toggling as well (the two would cancel out), and
            // prevents the text cursor just like its own handler does.
            e.preventDefault();
            e.stopImmediatePropagation();
            toggleMaximize();
        };

        document.addEventListener("mousedown", onMouseDown, {capture: true});
        return () => document.removeEventListener("mousedown", onMouseDown, {capture: true});
    }, []);
}
