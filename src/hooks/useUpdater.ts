import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
    checkForUpdate,
    downloadAndInstall,
    type DownloadProgress,
    type UpdateInfo,
    type UpdateStatus,
} from "../lib/updater.ts";
import {
    setStartupUpdate,
    getStartupUpdate,
    subscribe,
    type StartupUpdateState,
} from "../lib/updateAvailable.ts";
import { info as logInfo, error as logError } from "@tauri-apps/plugin-log";

export interface UpdaterState {
    status: UpdateStatus;
    info: UpdateInfo | null;
    progress: DownloadProgress | null;
    error: string | null;
    /** Re-run the update check. No-op while a check/transfer is in flight. */
    check: () => void;
    /** Download, install, and relaunch the pending update. */
    install: () => void;
}

/** Map the persisted store state to the (info, error) the UI renders. */
function deriveFromStore(
    s: StartupUpdateState,
): { info: UpdateInfo | null; error: string | null } {
    if (!s) return { info: null, error: null };
    if (s.status === "available") return { info: s.info, error: null };
    if (s.status === "error") return { info: null, error: s.error };
    return { info: null, error: null }; // upToDate
}

/** Apply a finished check's result to local state + the shared store. */
function commitResult(
    res: { status: "available"; info?: UpdateInfo }
    | { status: "upToDate" }
    | { status: "error"; error: string },
    setStatus: (s: UpdateStatus) => void,
    setInfo: (i: UpdateInfo | null) => void,
    setError: (e: string | null) => void,
) {
    if (res.status === "available") {
        const info = res.info ?? null;
        setStatus("available");
        setInfo(info);
        setError(null);
        setStartupUpdate(info ? { status: "available", info } : null);
    } else if (res.status === "upToDate") {
        setStatus("upToDate");
        setInfo(null);
        setError(null);
        setStartupUpdate({ status: "upToDate" });
    } else {
        setStatus("error");
        setInfo(null);
        setError(res.error);
        setStartupUpdate({ status: "error", error: res.error });
    }
}

/**
 * React state machine for the update cycle, for use in the About page.
 *
 * The last check result (startup or manual) is mirrored into the shared store,
 * so it survives the About tab being unmounted/remounted: check once, and
 * re-entering About still shows that result instead of "idle".
 *
 * Implementation note: the in-flight lock is a ref (not state), so toggling it
 * never recreates the callbacks and never gates the store→state sync effect —
 * that combination previously deadlocked the status at "checking".
 */
export function useUpdater(): UpdaterState {
    const storeState = useSyncExternalStore(subscribe, getStartupUpdate);
    const { info: storeInfo, error: storeError } = deriveFromStore(storeState);

    // Initial status mirrors whatever the last check concluded, so the UI
    // shows it immediately on (re)mount.
    const [status, setStatus] = useState<UpdateStatus>(
        storeState?.status ?? "idle",
    );
    const [info, setInfo] = useState<UpdateInfo | null>(storeInfo);
    const [progress, setProgress] = useState<DownloadProgress | null>(null);
    const [error, setError] = useState<string | null>(storeError);

    // In-flight lock kept in a ref: avoids putting it in callback deps and
    // avoids gating the store-sync effect (which caused the "stuck checking"
    // bug). Cleared when an operation settles.
    const inFlight = useRef(false);

    // Re-sync from the store when it changes externally (e.g. the startup
    // check resolving). We DO sync even while in-flight for check results —
    // check()/install() set terminal state directly, so this is mainly for
    // startup-driven changes the user didn't initiate.
    useEffect(() => {
        setStatus(storeState?.status ?? "idle");
        setInfo(storeInfo);
        setError(storeError);
        setProgress(null);
    }, [storeState, storeInfo, storeError]);

    const check = useCallback(() => {
        if (inFlight.current) return;
        inFlight.current = true;
        setStatus("checking");
        setError(null);
        logInfo("[updater][useUpdater] manual check() invoked").catch(() => {});
        checkForUpdate().then((res) => {
            logInfo(`[updater][useUpdater] check() resolved: ${res.status}`).catch(() => {});
            if (res.status === "error") {
                logError(`[updater][useUpdater] check error: ${res.error}`).catch(() => {});
            }
            commitResult(res, setStatus, setInfo, setError);
        // checkForUpdate is never-throw by contract, but a stray rejection
        // (or a logging failure bubbling out) must not wedge inFlight forever
        // — that would silently disable every future check/install.
        }).catch((e: unknown) => {
            setStatus("error");
            setError(String(e));
            logError(`[updater][useUpdater] check() rejected unexpectedly: ${e}`).catch(() => {});
        }).finally(() => {
            inFlight.current = false;
        });
    }, []);

    const install = useCallback(() => {
        if (inFlight.current) return;
        inFlight.current = true;
        setStatus("downloading");
        setError(null);
        setProgress(null);
        downloadAndInstall((p) => {
            setProgress(p);
            if (p.fraction === undefined || p.fraction >= 1) {
                // download finished → installer takes over
                setStatus("installing");
            }
        })
            .then(() => {
                inFlight.current = false;
            })
            .catch((e) => {
                inFlight.current = false;
                setError(e instanceof Error ? e.message : String(e));
                setStatus("error");
                logError(`[updater][useUpdater] install error: ${e instanceof Error ? e.message : String(e)}`).catch(() => {});
            });
    }, []);

    return { status, info, progress, error, check, install };
}
