import {invokeLogged} from "./apiCore.ts";

/** Localized tray-menu labels sent with every `set_tray_enabled` call — the
 *  translations live in the frontend, so the Rust-built menu is rebuilt with
 *  fresh labels on language change. */
export interface TrayLabels {
    show: string;
    quit: string;
}

/** Enable/disable the system-tray icon ("close to tray"). Idempotent:
 *  enabling rebuilds the tray (applying fresh labels), disabling removes it
 *  and shows the main window again if it was hidden in the tray. */
export function setTrayEnabled(enabled: boolean, labels: TrayLabels): Promise<void> {
    return invokeLogged<void>("set_tray_enabled", {enabled, labels}, {
        message: "Failed to update system tray",
    });
}
