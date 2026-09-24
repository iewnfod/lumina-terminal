import { useEffect } from "react";
import { checkForUpdate } from "../lib/updater.ts";
import { setStartupUpdate } from "../lib/updateAvailable.ts";
import { info, debug } from "@tauri-apps/plugin-log";

/**
 * Check for an update once on startup, when `enabled` is true.
 *
 * Only checks — never downloads or installs. The result is written to the
 * module-level store in `lib/updateAvailable.ts` so the About page (or any
 * other UI) can read it without re-checking, and it survives tab remounts.
 * Re-checks when `enabled` flips from false to true.
 *
 * Pass `false` to skip (e.g. the user disabled auto-check in settings).
 */
export function useStartupUpdateCheck(enabled: boolean): void {
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;

        info("Checking for updates on startup...");
        checkForUpdate().then((res) => {
            if (cancelled) return;
            if (res.status === "available") {
                setStartupUpdate(
                    res.info ? { status: "available", info: res.info } : null,
                );
                info(`Update available: v${res.info?.version ?? "?"}`);
            } else if (res.status === "error") {
                setStartupUpdate({ status: "error", error: res.error });
                debug(`Startup update check failed: ${res.error}`);
            } else {
                setStartupUpdate({ status: "upToDate" });
            }
        });

        return () => {
            cancelled = true;
        };
    }, [enabled]);
}
