import {useEffect} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {useGlobalConfig} from "./config.tsx";
import {useI18n} from "./i18n.tsx";
import {setTrayEnabled} from "../lib/trayApi.ts";

/**
 * Drive the system-tray lifecycle from `config.closeToTray`. Call this ONCE,
 * at the app root (App.tsx), so the tray follows the app lifecycle — not the
 * settings panel's mount/unmount (same pattern as useMcpServerLifecycle /
 * useProxySync). With the tray on, closing the main window hides it instead
 * of exiting (the close interception lives in useSessionPersistence).
 *
 * Only the MAIN window drives the tray: tear-off windows mount their own app
 * root too, and concurrent calls from them would race rebuilds for nothing.
 *
 * Re-runs on language change as well — the menu labels are localized here
 * (translations live in the frontend; the backend rebuilds the menu with
 * whatever labels it receives). setTrayEnabled is idempotent, so the effect
 * simply always syncs the desired state.
 */
export function useTrayLifecycle() {
    const {config} = useGlobalConfig();
    const t = useI18n();
    const isMainWindow = getCurrentWindow().label === "main";
    const enabled = config.closeToTray === true;

    useEffect(() => {
        if (!isMainWindow) return;
        setTrayEnabled(enabled, {show: t["Show Lumina"], quit: t["Quit"]}).catch(() => {
            // Already logged by invokeLogged (lib/apiCore.ts); swallow so the
            // rejection never surfaces as an unhandled one.
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isMainWindow, enabled, t]);
}
