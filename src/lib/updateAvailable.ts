/**
 * Module-level store of the last update-check result.
 *
 * Both the startup check (useStartupUpdateCheck) and a manual check from the
 * About page (useUpdater) write here, so the result survives the About tab
 * being unmounted/remounted — the user checks once, and re-entering About
 * still shows that result instead of resetting to "idle".
 *
 * This is the only cross-hook coupling for the updater and is intentionally
 * tiny (no React here, per AGENTS.md layering). Implemented as a subscribable
 * store (useSyncExternalStore-compatible).
 */

import type { UpdateInfo } from "./updater.ts";

/** The outcome of the last check that should persist across remounts. */
export type StartupUpdateState =
    | { status: "available"; info: UpdateInfo }
    | { status: "upToDate" }
    | { status: "error"; error: string }
    | null; // no check has completed yet (idle)

let cached: StartupUpdateState = null;
const listeners = new Set<() => void>();

function sameState(a: StartupUpdateState, b: StartupUpdateState): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.status !== b.status) return false;
    if (a.status === "available" && b.status === "available") {
        return a.info.version === b.info.version;
    }
    if (a.status === "error" && b.status === "error") {
        return a.error === b.error;
    }
    return true; // both upToDate
}

function emit() {
    for (const l of listeners) l();
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Read the current cached result (for useSyncExternalStore's getSnapshot). */
export function getStartupUpdate(): StartupUpdateState {
    return cached;
}

/** Convenience: the cached UpdateInfo, if the last result was "available". */
export function getAvailableUpdateInfo(): UpdateInfo | null {
    return cached?.status === "available" ? cached.info : null;
}

/** Record the outcome of a check (startup or manual), or null to reset. */
export function setStartupUpdate(state: StartupUpdateState): void {
    if (sameState(cached, state)) return;
    cached = state;
    emit();
}
