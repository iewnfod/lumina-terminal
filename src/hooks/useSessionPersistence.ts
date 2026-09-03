import {useCallback, useEffect, useRef, useState} from "react";
import {getCurrentWindow, type CloseRequestedEvent} from "@tauri-apps/api/window";
import {error, info, warn} from "@tauri-apps/plugin-log";
import {GlobalConfig} from "../types/config.ts";
import {TerminalProfile} from "../types/terminal.ts";
import {clearSession, loadSession, saveSession, type SavedSession, type SavedTab} from "../lib/session.ts";
import {getTerminalCwd} from "../lib/terminalApi.ts";
import {SETTINGS_TAB_ID, ABOUT_TAB_ID} from "../constants.ts";
import {useTauriSubscription} from "./useTauriListen.ts";

/** Refs passed in from useTerminalManager so the close handler reads live
 *  state without re-deriving (the handler is registered once on mount). */
interface PersistenceRefs {
    config: GlobalConfig;
    updateConfig: (partial: Partial<GlobalConfig>) => void;
    idsRef: React.MutableRefObject<string[]>;
    terminalsRef: React.MutableRefObject<Record<string, TerminalProfile>>;
    currentIdRef: React.MutableRefObject<string | null>;
    serializeFns: React.MutableRefObject<Map<string, () => string>>;
}

/**
 * Tab-session persistence — save open tabs on window close, load them back on
 * startup. Pure-frontend (no Rust): the close is intercepted with Tauri's
 * `onCloseRequested` (currently the only close hook in the app), state is
 * persisted via the LazyStore in lib/session.ts.
 *
 * The save side runs in EVERY window. Each window writes the same `session`
 * key, so when several windows close in sequence the last writer wins — this
 * matches the "restore what the user last had open" intent without any
 * cross-window coordination.
 *
 * The restore side only runs in the main window: tear-off windows seed their
 * single tab from their stashed payload (see useTearoffSession) and must NOT
 * also pull in a stale saved session. The caller (useTerminalManager) gates
 * restore on `tearoff === "no"`.
 */
export function useSessionPersistence(refs: PersistenceRefs) {
    // ---- Restore side: one-shot load on mount ----
    // undefined = loading, null = nothing saved, object = pending restore.
    const [restoreTabs, setRestoreTabs] = useState<SavedSession | null | undefined>(undefined);

    useEffect(() => {
        let cancelled = false;
        loadSession()
            .then((s) => {
                if (cancelled) return;
                // Consume immediately so a crash mid-restore or a mode change
                // doesn't restore stale data on the NEXT launch. Whether a new
                // session gets saved this run is decided at close time.
                if (s) {
                    setRestoreTabs(s);
                    clearSession();
                } else {
                    setRestoreTabs(null);
                }
            })
            .catch((e) => {
                if (cancelled) return;
                error(`Session restore load failed: ${e}`).catch(() => {});
                setRestoreTabs(null);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    /** Called by useTerminalManager once restore has seeded (or decided not
     *  to). Clears the pending restore so the seeding effect can't re-fire. */
    const markRestored = useRef<() => void>(() => {});
    markRestored.current = () => setRestoreTabs(null);

    // ---- Save side: intercept window close ----
    // "Ask" mode opens a dialog and resolves the decision. The handler is
    // async; we preventDefault to keep the window alive while writing the
    // store, then destroy() (force-close, does not re-emit closeRequested).
    const [dialog, setDialog] = useState<{open: boolean; count: number}>({open: false, count: 0});
    // The dialog resolves with BOTH the decision and the "remember" flag so
    // the close handler can apply the mode rewrite (awaited) before destroy.
    const pendingResolve = useRef<((result: {decision: "save" | "nosave"; remember: boolean}) => void) | null>(null);

    // resolveDialog is what SessionSaveDialog calls on a button press. It just
    // closes the dialog and forwards the result to the awaited promise; the
    // mode-rewrite happens in the close handler so it can be awaited durably.
    const resolveDialogImpl = useRef<(decision: "save" | "nosave", remember: boolean) => void>(() => {});
    resolveDialogImpl.current = (decision, remember) => {
        setDialog({open: false, count: 0});
        const r = pendingResolve.current;
        pendingResolve.current = null;
        r?.({decision, remember});
    };

    // Keep the latest config/refs in a ref so the once-registered close
    // handler always sees current values (it captures `refs` at mount).
    const refsRef = useRef(refs);
    refsRef.current = refs;

    // Re-entrancy guard: if close fires again while we're mid-handle (e.g.
    // the OS re-sends), don't run the save twice.
    const handlingRef = useRef(false);
    // Set once we've finished the async save/clear/ask work and are ready
    // to tear down. The NEXT closeRequested (re-emitted by our own close())
    // sees this and returns WITHOUT calling preventDefault, letting the
    // system close the window. Using close() (not destroy()) avoids needing
    // the core:window:allow-destroy capability.
    const finalizingRef = useRef(false);

    const handleCloseRequested = async (event: CloseRequestedEvent) => {
        // Second pass: we re-requested close after our work finished. Let it
        // through this time (no preventDefault) so the window actually closes.
        if (finalizingRef.current) {
            finalizingRef.current = false;
            return;
        }
        if (handlingRef.current) return;
        handlingRef.current = true;
        try {
            const r = refsRef.current;
            // Save ALL tabs (terminal + chrome: Settings/About) in tab-bar
            // order, not just terminal tabs — the user expects their whole
            // tab layout restored. A chrome tab id is one of the sentinels;
            // everything else in `ids` that has a profile is a terminal tab.
            const allIds = r.idsRef.current;
            const isChrome = (id: string) => id === SETTINGS_TAB_ID || id === ABOUT_TAB_ID;
            const mode = r.config.sessionSaveMode ?? "ask";

            let decision: "save" | "nosave";
            let remember = false;
            if (allIds.length === 0) {
                // No tabs open: both dialog choices would come down to
                // "clear the session", so skip the prompt entirely.
                decision = "nosave";
            } else if (mode === "always") {
                decision = "save";
            } else if (mode === "ask") {
                // Open the dialog, await the user's choice. preventDefault
                // keeps the window alive until we finish (save + remember).
                event.preventDefault();
                const result = await new Promise<{decision: "save" | "nosave"; remember: boolean}>((resolve) => {
                    pendingResolve.current = resolve;
                    // Count is the user-facing tab count (everything open).
                    setDialog({open: true, count: allIds.length});
                });
                decision = result.decision;
                remember = result.remember;
            } else {
                decision = "nosave";
            }

            if (allIds.length === 0 || decision === "nosave") {
                // Clear any previously-saved session so a stale one isn't
                // restored next launch.
                await clearSession();
            } else {
                // (save path): preventDefault not yet called for "always"
                // mode — call it now so the window survives the store write.
                event.preventDefault();
                const saveScrollback = r.config.sessionSaveScrollback === true;
                const tabs = await Promise.all(
                    allIds.map(async (id): Promise<SavedTab> => {
                        // Chrome tabs (Settings/About): no PTY, no profile —
                        // store just the sentinel id and restore as chrome.
                        if (isChrome(id)) {
                            return {kind: "chrome", chromeId: id};
                        }
                        const p = r.terminalsRef.current[id];
                        // Capture the LIVE cwd (where the user cd'd to), not
                        // the profile's static default. Fall back to the
                        // profile cwd if the read fails (unsupported OS,
                        // process gone).
                        let cwd = p.cwd ?? "";
                        try {
                            cwd = (await getTerminalCwd(id)) ?? cwd;
                        } catch (e) {
                            warn(`Session save: live cwd read failed for ${id}, using profile cwd: ${e}`);
                        }
                        const tab: SavedTab = {kind: "terminal", profileName: p.name, cwd};
                        if (saveScrollback) {
                            tab.scrollback = r.serializeFns.current.get(id)?.() ?? "";
                        }
                        return tab;
                    }),
                );
                // Index of the active tab in the saved list — clamped on
                // restore. -1 (no active id / id not found) → undefined.
                const activeIdx = r.currentIdRef.current
                    ? allIds.indexOf(r.currentIdRef.current)
                    : -1;
                await saveSession({
                    version: 1,
                    savedAt: Date.now(),
                    activeIndex: activeIdx >= 0 ? activeIdx : undefined,
                    tabs,
                });
            }

            // "Remember this choice" rewrites the mode so future closes
            // skip the dialog. Await durability BEFORE closing so the
            // rewrite survives the window teardown.
            if (remember) {
                const newMode = decision === "save" ? "always" : "never";
                await r.updateConfig({sessionSaveMode: newMode});
                info(`Session save mode remembered as "${newMode}"`);
            }

            // If we preventDefault'd (ask-mode or save path), the original
            // close was canceled — re-request it. close() re-emits
            // closeRequested; the finalizing flag (checked above) lets
            // that second pass through without preventDefault. On the
            // nosave/empty path we never preventDefault'd, so the original
            // close is already proceeding — do nothing.
            if (event.isPreventDefault()) {
                finalizingRef.current = true;
                getCurrentWindow().close().catch((e) =>
                    error(`Session save: failed to re-close window: ${e}`).catch(() => {})
                );
            }
        } catch (e) {
            error(`Session save handler failed: ${e}`).catch(() => {});
            // Best-effort: don't trap the user in an un-closable window.
            // Flip finalizing and re-request close so the second pass lets
            // it through (this only helps if we'd preventDefault'd; if not,
            // the original close is already in flight).
            finalizingRef.current = true;
            getCurrentWindow().close().catch(() => {});
        } finally {
            handlingRef.current = false;
        }
    };

    const subscribeClose = useCallback(
        (handler: (event: CloseRequestedEvent) => void) => getCurrentWindow().onCloseRequested(handler),
        [],
    );
    useTauriSubscription(subscribeClose, handleCloseRequested, "close-requested handler");

    return {
        restoreTabs,
        markRestored: () => markRestored.current(),
        dialog,
        resolveDialog: (decision: "save" | "nosave", remember: boolean) =>
            resolveDialogImpl.current(decision, remember),
    };
}
