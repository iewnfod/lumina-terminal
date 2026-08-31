import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {TerminalProfile, CurrentCommand} from "../types/terminal.ts";
import {parseProfile} from "../lib/term.ts";
import {reorderByDrop} from "../lib/tabReorder.ts";
import {killTerminal, getTerminalCwd, setActiveTab} from "../lib/terminalApi.ts";
import {info, debug, error, warn} from "@tauri-apps/plugin-log";
import {SETTINGS_TAB_ID, ABOUT_TAB_ID} from "../constants.ts";
import {
    consumeTearoff,
    createTearoffWindow,
    DRAG_HOVER_EVENT,
    MERGE_ACK_EVENT,
    MERGE_TAB_EVENT,
    newTearoffLabel,
    stashTearoff,
    type TabDragHover,
    type TearoffPayload,
} from "../lib/tearoff.ts";
import {emitTo, listen} from "@tauri-apps/api/event";
import {useTearoffSession} from "./useTearoffSession.ts";
import {useCliArgs} from "./useCliArgs.ts";
import {useGlobalConfig} from "./config.tsx";
import {useSessionPersistence} from "./useSessionPersistence.ts";
import {useSystemTheme} from "./useSystemTheme.ts";
import type {SavedSession} from "../lib/session.ts";

/**
 * Owns the terminal-tab lifecycle: the id list, profile map, active id,
 * per-tab running-command map, reattach-mode tabs, and the close-on-last-tab
 * rule. Exposes the create/close/switch/toTab/tear-off operations and the
 * cross-window merge/hover listeners.
 *
 * Extracted from App.tsx so App orchestrates chrome instead of babysitting
 * state. The refs (serializeFns, mergeTargetRef, dragScreenPosRef) are
 * returned so TabBar / Term can read + mutate them without re-deriving state.
 */
export interface TerminalManager {
    ids: string[];
    terminals: Record<string, TerminalProfile>;
    currentId: string | null;
    commands: Record<string, CurrentCommand | null>;
    /** Brand text for the sidebar's top-left. Set to the launch `-T/--title`
     *  on the main window; undefined otherwise (→ TabBar shows "Lumina"). */
    brandTitle: string | undefined;
    reattachTabs: Record<string, {ptyId: string; scrollback: string}>;
    /** Per-tab scrollback to replay on a fresh-start (session restore), keyed
     *  by tab id. Term reads [id] via its initialScrollback prop. */
    initialScrollbackTabs: Record<string, string>;
    serializeFns: React.MutableRefObject<Map<string, () => string>>;
    mergeTargetRef: React.MutableRefObject<TabDragHover | null>;
    dragScreenPosRef: React.MutableRefObject<{x: number; y: number} | null>;
    newTerminal: (profile: TerminalProfile) => Promise<void>;
    closeTerminal: (id: string) => void;
    switchTab: (id: string) => void;
    toTab: (index: number) => void;
    /** Move tab `id` so it sits immediately before `beforeId`, or to the end
     *  when `beforeId` is null. Takes a neighbor id rather than an index so a
     *  caller working off the rendered tab list can never land on the wrong
     *  slot of `ids`. Drives sidebar drag-reordering. */
    reorderTabs: (id: string, beforeId: string | null) => void;
    tearOffTab: (id: string, opts?: {mergeTarget?: string; position?: {x: number; y: number}}) => Promise<void>;
    setCommandsFor: (id: string, cmd: CurrentCommand | null) => void;
    /** Add a chrome-only tab (Settings/About — no PTY). If already present,
     *  just activates it. Centralized so App's open* handlers share one path. */
    openChromeTab: (id: string) => void;
    // True once the initial-tab seeding effect has run for this window. The ref
    // guards the seed effect itself; `initialized` (state) mirrors it so React
    // consumers re-render when seeding completes (e.g. the empty state and its
    // window sizer, which must wait for the seed decision before acting — a ref
    // alone wouldn't trigger the render they need).
    isInitialized: React.MutableRefObject<boolean>;
    initialized: boolean;
    /** "Ask every time" close dialog state + resolver. App renders
     *  SessionSaveDialog from these. */
    sessionDialog: {
        open: boolean;
        count: number;
        resolve: (decision: "save" | "nosave", remember: boolean) => void;
    };
}

export function useTerminalManager(): TerminalManager {
    const {config, updateConfig} = useGlobalConfig();
    const tearoff = useTearoffSession();
    // OS light/dark preference drives the fallback terminal palette (a bare
    // profile with no themePath/inline theme): light → GitHub Light, dark/未决
    // → legacy black. Passed into parseProfile so new tabs pick it up at create
    // time. Existing tabs keep their baked-in palette (same as themePath).
    const systemTheme = useSystemTheme();
    // Parsed launch flags (Alacritty-style), parsed once on the backend.
    // `undefined` while the first fetch is in flight; the seed effect waits on
    // it before deciding the main window's initial tab. Process-global, so the
    // value is shared by every window — only the main window consumes it.
    const cliArgs = useCliArgs();

    const [ids, setIds] = useState<string[]>([]);
    const [terminals, setTerminals] = useState<Record<string, TerminalProfile>>({});
    const [currentId, setCurrentId] = useState<string | null>(null);
    const serializeFns = useRef<Map<string, () => string>>(new Map());
    const [reattachTabs, setReattachTabs] = useState<Record<string, {ptyId: string; scrollback: string}>>({});
    // Per-tab scrollback to replay on a FRESH-start (session restore), keyed by
    // tab id. Distinct from reattachTabs (which replay on REATTACH to a live
    // PTY). Consumed by Term via the initialScrollback prop; a tab id is
    // present in at most one of the two maps.
    const [initialScrollbackTabs, setInitialScrollbackTabs] = useState<Record<string, string>>({});
    const mergeTargetRef = useRef<TabDragHover | null>(null);
    const dragScreenPosRef = useRef<{x: number; y: number} | null>(null);
    const [commands, setCommands] = useState<Record<string, CurrentCommand | null>>({});
    const isInitialized = useRef<boolean>(false);
    // Reactive mirror of isInitialized, so consumers re-render when seeding
    // finishes. Set wherever the ref is set.
    const [initialized, setInitialized] = useState(false);
    const closeOnLastTabRef = useRef(config.closeWindowOnLastTab);
    closeOnLastTabRef.current = config.closeWindowOnLastTab;

    // Mirror of config.profileLastOpened in a ref so newTerminal can record a
    // profile's open time without a stale closure across rapid successive opens
    // (the ref is updated immediately on each open, ahead of the config write).
    const profileLastOpenedRef = useRef<Record<string, number>>(config.profileLastOpened ?? {});
    useEffect(() => {
        profileLastOpenedRef.current = config.profileLastOpened ?? {};
    }, [config.profileLastOpened]);

    const idsRef = useRef(ids);
    idsRef.current = ids;
    const currentIdRef = useRef(currentId);
    currentIdRef.current = currentId;
    // Mirror the focused terminal to the backend so the read-only MCP server
    // can answer `get_active_tab`. The frontend tab list is the source of
    // truth; this is a best-effort cache (failures are logged, not blocking).
    // Settings/About ids aren't in the backend's PTY map, so they naturally
    // resolve to "no active terminal" on the MCP side.
    useEffect(() => {
        setActiveTab(currentId);
    }, [currentId]);
    const terminalsRef = useRef(terminals);
    terminalsRef.current = terminals;

    const defaultProfile = useMemo(() => {
        return config.profiles.find(p => p.default) || config.profiles[0];
    }, [config.profiles]);

    // Session persistence: close-time save hook + one-shot startup restore
    // load + the "ask" dialog state. Passed the manager's refs so the close
    // handler reads live state without re-deriving. restoreTabs is consumed
    // by the seed effect below; markRestored clears it once tabs are seeded.
    const session = useSessionPersistence({
        config,
        updateConfig,
        idsRef,
        terminalsRef,
        currentIdRef,
        serializeFns,
    });

    /** Synchronous core: mint a fresh id, register an already-resolved
     *  profile, append to the tab list. Returns the new id WITHOUT touching
     *  currentId. Shared by newTerminal (user/manual) and session restore
     *  (batch insert + single setCurrentId at the end). */
    const addTerminal = useCallback((resolvedProfile: TerminalProfile): string => {
        const id = crypto.randomUUID();
        setTerminals((prevState) => ({...prevState, [id]: resolvedProfile}));
        setIds((prevState) => [...prevState, id]);
        return id;
    }, []);

    const newTerminal = useCallback(async (profile: TerminalProfile) => {
        let p = await parseProfile(profile, config.globalProfile, systemTheme);
        // "Inherit working directory" (optional, off by default): the new tab
        // starts in the ACTIVE terminal's current directory instead of the
        // profile default. Queries the backend shell cwd. Async, so any
        // failure (source gone, platform unsupported → null/rejection) falls
        // back to the profile cwd untouched; getTerminalCwd already logs
        // rejections via invokeWithLog.
        const sourceId = currentIdRef.current;
        if (config.inheritWorkingDirectory && sourceId && sourceId in terminalsRef.current) {
            try {
                const cwd = await getTerminalCwd(sourceId);
                if (cwd) p = {...p, cwd};
            } catch (e) {
                debug(`Inherit cwd failed for ${profile.name}, using profile default: ${e}`);
            }
        }
        const id = addTerminal(p);
        setCurrentId(id);
        info(`New terminal: profile=${profile.name} id=${id}`);
        // Record this profile as just-opened so the empty-state quick-launch
        // list can sort by recency. Update the ref immediately to stay correct
        // across rapid successive opens, then persist. updateConfig handles its
        // own error logging and never rejects, so fire-and-forget is safe.
        const nextLastOpened = {...profileLastOpenedRef.current, [profile.name]: Date.now()};
        profileLastOpenedRef.current = nextLastOpened;
        updateConfig({profileLastOpened: nextLastOpened});
    }, [config, addTerminal, systemTheme, updateConfig]);

    const closeTerminal = useCallback((id: string) => {
        debug(`closeTerminal called for id=${id}`);
        const currentIds = idsRef.current;
        const currentActiveId = currentIdRef.current;

        // Settings tab: no PTY process, just remove from list
        if (id === SETTINGS_TAB_ID || id === ABOUT_TAB_ID) {
            info("Closing settings/about tab");
            const newIds = currentIds.filter((i) => i !== id);
            let newCurrentId = currentActiveId;
            if (currentActiveId === id) {
                if (newIds.length > 0) {
                    newCurrentId = newIds[newIds.length - 1];
                } else if (closeOnLastTabRef.current !== false) {
                    info("No tabs left, closing window");
                    getCurrentWindow().close().catch((e) =>
                        error(`Failed to close window on last tab: ${e}`)
                    );
                    return;
                } else {
                    // Keep the window open: no tabs remain, so clear the active
                    // id. Must be null (not the closed id) so the empty state
                    // renders and App-level key bindings stay live.
                    newCurrentId = null;
                }
            }
            setIds(newIds);
            setCurrentId(newCurrentId);
            return;
        }
        // Kill the PTY process on the backend
        killTerminal(id).catch((e) =>
            error(`Failed to kill terminal: ${e}`)
        );

        // Compute new ID list
        const newIds = currentIds.filter((i) => i !== id);

        // Determine which tab should become active
        let newCurrentId = currentActiveId;
        if (currentActiveId === id) {
            if (newIds.length > 0) {
                const idx = currentIds.indexOf(id);
                newCurrentId = newIds[Math.min(idx, newIds.length - 1)];
            } else if (closeOnLastTabRef.current !== false) {
                // No tabs left, close the window (default behavior)
                info("No tabs left after close, closing window");
                getCurrentWindow().close().catch((e) =>
                    error(`Failed to close window on last tab: ${e}`)
                );
                return;
            } else {
                // closeWindowOnLastTab is off: keep the window open with no
                // active tab. currentId MUST be null (not the closed id) so the
                // empty state renders and App-level key bindings stay live.
                newCurrentId = null;
            }
        }

        setTerminals((prevState) => {
            const newState = {...prevState};
            delete newState[id];
            return newState;
        });
        setIds(newIds);
        setCurrentId(newCurrentId);
        info(`Terminal closed: id=${id}, remaining=${newIds.length}`);
    }, []);

    const switchTab = useCallback((id: string) => {
        debug(`Switch tab to ${id}`);
        setCurrentId(id);
    }, []);

    /**
     * Tear a terminal tab off — either into a NEW window (default) or by
     * MERGING into another existing Lumina window (`opts.mergeTarget` = that
     * window's label). Captures scrollback, stashes the payload, then:
     *   - new window: spawns a hidden WebviewWindow and detaches the tab here.
     *   - merge: emits MERGE_TAB to the target, waits for MERGE_ACK, then
     *     detaches. The PTY is never killed — the target reattaches to it.
     * Any failure is logged; the tab stays put if stashing or (for merge) the
     * ack times out.
     */
    const tearOffTab = useCallback(async (id: string, opts?: {mergeTarget?: string; position?: {x: number; y: number}}) => {
        const profile = terminals[id];
        if (!profile) {
            warn(`tearOffTab: no profile for id=${id} (not a terminal tab)`);
            return;
        }
        const scrollback = serializeFns.current.get(id)?.() ?? "";

        // Shared detach: remove the tab from this window without killing the
        // PTY. Index-aware active-tab fallback mirrors closeTerminal.
        const detachTab = () => {
            const currentIds = idsRef.current;
            const currentActiveId = currentIdRef.current;
            const newIds = currentIds.filter((i) => i !== id);
            let newCurrentId = currentActiveId;
            if (currentActiveId === id) {
                if (newIds.length > 0) {
                    const idx = currentIds.indexOf(id);
                    newCurrentId = newIds[Math.min(idx, newIds.length - 1)];
                } else if (closeOnLastTabRef.current !== false) {
                    info("No tabs left after detach, closing source window");
                    getCurrentWindow().close().catch((e) =>
                        error(`Failed to close source window after detach: ${e}`)
                    );
                } else {
                    // Keep the source window open: no tabs remain, so clear the
                    // active id (null, not the detached id) for the empty state.
                    newCurrentId = null;
                }
            }
            setTerminals((prevState) => {
                const newState = {...prevState};
                delete newState[id];
                return newState;
            });
            setIds(newIds);
            setCurrentId(newCurrentId);
            setReattachTabs((prev) => {
                if (!(id in prev)) return prev;
                const next = {...prev};
                delete next[id];
                return next;
            });
            info(`Tab id=${id} detached from source window (PTY kept alive)`);
        };

        const target = opts?.mergeTarget;
        if (target) {
            // ---- Merge into an existing window ----
            // Use a fresh stash key (NOT a window label) since the target
            // window already has its own label.
            const stashKey = newTearoffLabel();
            info(`Merging tab id=${id} into window ${target} (stashKey=${stashKey})`);
            try {
                await stashTearoff(stashKey, {profile, ptyId: id, scrollback});
            } catch (e) {
                error(`tearOffTab merge: stash failed for ${stashKey}, aborting: ${e}`).catch(() => {});
                return;
            }
            const sourceLabel = getCurrentWindow().label;
            // Correct ordering for a reliable ack handshake:
            //   1. await listen() so the handler is registered before we emit
            //      (a fast target would otherwise ack before we listen).
            //   2. emitTo target.
            //   3. race the ack against a 3s timeout.
            //   4. unlisten (whether acked or timed out).
            let ackResolve!: (v: boolean) => void;
            const ackPromise = new Promise<boolean>((resolve) => {
                ackResolve = resolve;
            });
            let ackUnlisten: (() => void) | undefined;
            try {
                ackUnlisten = await listen(MERGE_ACK_EVENT, (event) => {
                    const payload = event.payload as {stashKey?: string} | null;
                    if (payload?.stashKey === stashKey) {
                        info(`Merge acked by ${target}`);
                        ackResolve(true);
                    }
                });
            } catch (e) {
                error(`Failed to listen for ${MERGE_ACK_EVENT}: ${e}`).catch(() => {});
                return;
            }
            emitTo(target, MERGE_TAB_EVENT, {stashKey, sourceLabel}).catch((e) =>
                error(`Failed to emit ${MERGE_TAB_EVENT} to ${target}: ${e}`).catch(() => {})
            );
            const acked = await Promise.race([
                ackPromise,
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
            ]);
            ackUnlisten();
            if (!acked) {
                warn(`Merge ack timed out for ${stashKey} into ${target}; keeping tab`);
                return;
            }
            detachTab();
            return;
        }

        // ---- New window (existing path) ----
        const label = newTearoffLabel();
        info(`Tearing off tab id=${id} into new window ${label}`);
        try {
            await stashTearoff(label, {profile, ptyId: id, scrollback});
        } catch (e) {
            error(`tearOffTab: stash failed for ${label}, aborting: ${e}`).catch(() => {});
            return;
        }
        const sourceInnerSize = {
            width: window.innerWidth,
            height: window.innerHeight,
        };
        try {
            await createTearoffWindow(label, sourceInnerSize, opts?.position);
        } catch (e) {
            error(`tearOffTab: window creation failed for ${label}: ${e}`).catch(() => {});
            // Leave the tab in place — the new window never came up.
            return;
        }
        detachTab();
    }, [terminals]);

    const toTab = useCallback((index: number) => {
        if (ids.length === 0) return;
        const idx = index < 0 ? ids.length - 1 : Math.min(index, ids.length - 1);
        setCurrentId(ids[idx]);
    }, [ids]);

    const reorderTabs = useCallback((id: string, beforeId: string | null) => {
        const current = idsRef.current;
        const from = current.indexOf(id);
        if (from < 0) {
            warn(`reorderTabs: unknown tab id=${id}`);
            return;
        }
        const insertIndex = beforeId === null ? current.length : current.indexOf(beforeId);
        if (insertIndex < 0) {
            warn(`reorderTabs: unknown neighbor id=${beforeId}`);
            return;
        }
        const next = reorderByDrop(current, from, insertIndex);
        if (next === current) return; // dropped back into its own slot
        setIds(next);
        info(`Tab reordered: id=${id} ${from} → ${next.indexOf(id)}`);
    }, []);

    const openChromeTab = useCallback((id: string) => {
        setIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
        setCurrentId(id);
    }, []);

    const setCommandsFor = useCallback((id: string, cmd: CurrentCommand | null) => {
        setCommands((prev) =>
            prev[id] === cmd ? prev : { ...prev, [id]: cmd }
        );
    }, []);

    // Merge receiver: accept a tab dragged in from another Lumina window.
    // Runs in EVERY window (main + tear-off). Payload: {stashKey, sourceLabel}.
    // We consume the stashed {profile, ptyId, scrollback}, seed a reattach tab,
    // and ack so the source can remove the tab from its state. The PTY is not
    // killed on the source's side — our Term reattaches to the live process.
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let cancelled = false;

        listen(MERGE_TAB_EVENT, async (event) => {
            const payload = event.payload as {stashKey?: string; sourceLabel?: string} | null;
            const stashKey = payload?.stashKey;
            const sourceLabel = payload?.sourceLabel ?? "unknown";
            if (!stashKey) {
                warn(`Merge received with no stashKey from ${sourceLabel}`);
                return;
            }
            let loaded: TearoffPayload | null = null;
            try {
                loaded = await consumeTearoff(stashKey);
            } catch (e) {
                error(`Merge consume failed for ${stashKey}: ${e}`).catch(() => {});
            }
            // Always ack so the source isn't stuck waiting for the 3s timeout.
            // (Even on failure — the source keeps its tab; nothing is lost.)
            emitTo(sourceLabel, MERGE_ACK_EVENT, {stashKey}).catch((e) =>
                error(`Failed to ack merge ${stashKey} to ${sourceLabel}: ${e}`).catch(() => {})
            );
            if (!loaded) {
                error(`Merge received but stash empty for ${stashKey}; tab not seeded`).catch(() => {});
                return;
            }
            const {ptyId, profile: seedProfile, scrollback} = loaded;
            info(`Merge tab received: ptyId=${ptyId} from ${sourceLabel}`);
            setTerminals((s) => ({...s, [ptyId]: seedProfile}));
            setIds((s) => (s.includes(ptyId) ? s : [...s, ptyId]));
            setReattachTabs((s) => ({...s, [ptyId]: {ptyId, scrollback}}));
            setCurrentId(ptyId);
        }).then((cleanup) => {
            if (cancelled) {
                cleanup();
            } else {
                unlisten = cleanup;
            }
        }).catch((e) => {
            error(`Failed to listen for ${MERGE_TAB_EVENT}: ${e}`);
        });

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, []);

    // Track which other window the cursor is hovering during a drag FROM this
    // window. TabBar's dragend reads mergeTargetRef to pick merge vs. cancel
    // vs. new-window (`merge` is true only over a foreign sidebar).
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let cancelled = false;
        listen<{label?: string; merge?: boolean}>(DRAG_HOVER_EVENT, (event) => {
            const label = event.payload?.label;
            if (label) {
                mergeTargetRef.current = {
                    label,
                    time: Date.now(),
                    // Default false so a stale payload shape never merges by accident.
                    merge: event.payload?.merge === true,
                };
            }
            // Ignore empty reports — the heartbeat model only relies on the
            // freshness of positive reports, so explicit leaves aren't needed.
        }).then((cleanup) => {
            if (cancelled) {
                cleanup();
            } else {
                unlisten = cleanup;
            }
        }).catch((e) => {
            error(`Failed to listen for ${DRAG_HOVER_EVENT}: ${e}`);
        });
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, []);

    // Initial tab seeding. Four cases:
    //   - tear-off window (tearoff carries payload): seed ONE reattach-mode
    //     terminal from the stashed profile + PTY id. Do NOT call startTerminal
    //     — the PTY is alive on the backend; Term's reattach path handles it.
    //   - main window with a saved session to restore (mode != "never" and
    //     restoreTabs loaded a non-empty session): map each SavedTab back to a
    //     profile by name, re-parse against the current globalProfile, and seed
    //     them in order (optionally replaying saved scrollback).
    //   - main window with configured profiles but no session: open the default.
    //   - main window with no profiles yet: WelcomePage handles onboarding.
    // `tearoff === null` / `session.restoreTabs === undefined` mean a probe is
    // still in flight — wait.
    useEffect(() => {
        if (isInitialized.current) return;
        if (tearoff === null) return; // tear-off probe in flight
        if (cliArgs === undefined) return; // CLI args probe in flight
        if (tearoff === "no") {
            // Main window: also wait for the session-restore probe to finish.
            if (session.restoreTabs === undefined) return;
            if (config.profiles.length && ids.length === 0) {
                isInitialized.current = true;
                setInitialized(true);
                getCurrentWindow().setResizable(true).catch((e) =>
                    error(`Failed to set window resizable: ${e}`)
                );
                // CLI launch args (Alacritty-style): if any shaping flag was
                // given (--profile/--command/--working-directory/--hold/--title),
                // open a SINGLE tab built from them and skip session restore —
                // the user explicitly asked for a specific launch. No args at
                // all falls through to the normal session-restore / default
                // path below, preserving today's behavior. (--sidebar is
                // deliberately excluded: it's a chrome-only override that App
                // applies without shaping the initial tab.)
                const hasLaunchArgs =
                    cliArgs.command.length > 0 ||
                    !!cliArgs.workingDirectory ||
                    cliArgs.hold ||
                    !!cliArgs.title ||
                    !!cliArgs.profile;
                if (hasLaunchArgs) {
                    session.markRestored();
                    // Base profile: --profile if it resolves, else default.
                    let base = defaultProfile;
                    if (cliArgs.profile) {
                        const found = config.profiles.find(p => p.name === cliArgs.profile);
                        if (found) {
                            base = found;
                        } else {
                            warn(`CLI --profile "${cliArgs.profile}" not found; using default profile`);
                        }
                    }
                    const p: TerminalProfile = {...base};
                    if (cliArgs.workingDirectory) p.cwd = cliArgs.workingDirectory;
                    if (cliArgs.command.length > 0) {
                        // -e runs through the configured shell (Lumina's
                        // startupCommand model). Without --hold the tab closes
                        // when the command exits (Alacritty-faithful); --hold
                        // freezes the output instead.
                        p.startupCommand = cliArgs.command.join(" ");
                        p.keepAfterExit = cliArgs.hold ? "freeze" : "exit";
                    } else if (cliArgs.hold) {
                        p.keepAfterExit = "freeze";
                    }
                    if (cliArgs.title) {
                        getCurrentWindow().setTitle(cliArgs.title).catch((e) =>
                            error(`Failed to set window title to "${cliArgs.title}": ${e}`).catch(() => {})
                        );
                    }
                    info(
                        `CLI launch: profile=${p.name} cwd=${p.cwd ?? "(default)"} ` +
                        `cmd=${p.startupCommand ?? "(none)"} hold=${cliArgs.hold}`,
                    );
                    newTerminal(p).catch((e) =>
                        error(`Failed to create CLI-launched terminal: ${e}`).catch(() => {})
                    );
                    return;
                }
                const saved = session.restoreTabs as SavedSession | null;
                const canRestore =
                    config.sessionSaveMode !== "never" &&
                    saved &&
                    saved.tabs.length > 0;
                if (canRestore && saved) {
                    // Map each saved tab back to a restorable entry. Terminal
                    // tabs are re-parsed against the CURRENT globalProfile so
                    // global render options (font/theme/…) changes still apply;
                    // a terminal tab whose profile was deleted/renamed is
                    // skipped + warned. Chrome tabs (Settings/About) restore
                    // directly via their sentinel id. Order is preserved so the
                    // restored tab bar matches what the user left.
                    type RestoredEntry =
                        | {kind: "terminal"; id: string; profile: TerminalProfile; scrollback?: string}
                        | {kind: "chrome"; id: string};
                    Promise.all(saved.tabs.map(async (tab): Promise<RestoredEntry | null> => {
                        if (tab.kind === "chrome") {
                            return {kind: "chrome", id: tab.chromeId};
                        }
                        const base = config.profiles.find(p => p.name === tab.profileName);
                        if (!base) {
                            warn(`Session restore: profile "${tab.profileName}" no longer exists; skipping tab`);
                            return null;
                        }
                        const resolved = await parseProfile(
                            tab.cwd ? {...base, cwd: tab.cwd} : base,
                            config.globalProfile,
                            systemTheme,
                        );
                        return {kind: "terminal", id: "", profile: resolved, scrollback: tab.scrollback};
                    })).then((entries) => {
                        const valid = entries.filter((e): e is RestoredEntry => e !== null);
                        if (valid.length === 0) {
                            info("Session restore yielded no valid tabs; opening default profile");
                            session.markRestored();
                            newTerminal(defaultProfile).catch((e) =>
                                error(`Failed to create initial terminal: ${e}`)
                            );
                            return;
                        }
                        // Apply in order: terminal tabs via addTerminal (mints a
                        // fresh id + registers the profile), chrome tabs via
                        // their sentinel id. Track each restored id at its
                        // original index so activeIndex focuses the right one.
                        const restoredIds: string[] = [];
                        for (const entry of valid) {
                            if (entry.kind === "terminal") {
                                const id = addTerminal(entry.profile);
                                entry.id = id;
                                restoredIds.push(id);
                                if (entry.scrollback) {
                                    setInitialScrollbackTabs((prev) => ({...prev, [id]: entry.scrollback!}));
                                }
                            } else {
                                // Chrome tab: ensure its sentinel id is in the
                                // list (de-duped). openChromeTab also activates,
                                // but we set currentId once at the end based on
                                // activeIndex, so just register the id here.
                                setIds((prev) => (prev.includes(entry.id) ? prev : [...prev, entry.id]));
                                restoredIds.push(entry.id);
                            }
                        }
                        // Focus the tab that was active at save time. activeIndex
                        // refers to the SAVED list; because we dropped skipped
                        // tabs, clamp it to the restored range. Missing/invalid
                        // → the last restored tab.
                        const focusIdx = saved.activeIndex != null
                            ? Math.min(Math.max(saved.activeIndex, 0), restoredIds.length - 1)
                            : restoredIds.length - 1;
                        setCurrentId(restoredIds[focusIdx] ?? null);
                        session.markRestored();
                        info(`Restored ${valid.length} tab(s) from saved session`);
                    }).catch((e) => {
                        error(`Session restore failed, falling back to default profile: ${e}`).catch(() => {});
                        session.markRestored();
                        newTerminal(defaultProfile).catch((err) =>
                            error(`Failed to create initial terminal: ${err}`)
                        );
                    });
                } else {
                    session.markRestored();
                    // When session saving is off, the "load default profile on
                    // startup" setting decides whether to seed a default tab or
                    // start empty (the empty state then takes over). With saving
                    // on but nothing to restore (e.g. first run), always seed a
                    // default tab — the setting is meaningless there.
                    const seedDefault = config.sessionSaveMode === "never"
                        ? config.loadDefaultProfileOnStartup !== false
                        : true;
                    if (seedDefault) {
                        newTerminal(defaultProfile).catch((e) =>
                            error(`Failed to create initial terminal: ${e}`)
                        );
                    }
                }
            }
            return;
        }
        // Tear-off window: seed exactly one tab whose id is the live PTY id.
        // The profile in the payload is already resolved (post parseProfile),
        // so we insert it directly without re-merging globalProfile.
        isInitialized.current = true;
        setInitialized(true);
        const {ptyId, profile: seedProfile} = tearoff.payload;
        getCurrentWindow().setResizable(true).catch((e) =>
            error(`Failed to set tear-off window resizable: ${e}`)
        );
        setTerminals({[ptyId]: seedProfile});
        setIds([ptyId]);
        setCurrentId(ptyId);
        setReattachTabs({[ptyId]: {ptyId, scrollback: tearoff.payload.scrollback}});
        info(`Tear-off window seeded with ptyId=${ptyId}`);
    }, [config, tearoff, cliArgs, defaultProfile, session, addTerminal, newTerminal, systemTheme]);

    // Brand text shown in the sidebar's top-left. `-T/--title` overrides the
    // default "Lumina" — but only on the main window, mirroring how the
    // setTitle() call above is scoped to the main window's seed path. Tear-off
    // windows keep "Lumina" (undefined here → TabBar falls back to it).
    const brandTitle = tearoff === "no" ? cliArgs?.title : undefined;

    return {
        ids,
        terminals,
        currentId,
        commands,
        brandTitle,
        reattachTabs,
        initialScrollbackTabs,
        serializeFns,
        mergeTargetRef,
        dragScreenPosRef,
        newTerminal,
        closeTerminal,
        switchTab,
        toTab,
        reorderTabs,
        tearOffTab,
        setCommandsFor,
        openChromeTab,
        isInitialized,
        initialized,
        sessionDialog: {open: session.dialog.open, count: session.dialog.count, resolve: session.resolveDialog},
    };
}
