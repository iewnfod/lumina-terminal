import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {AnimatePresence} from "framer-motion";
import {Terminal} from "@xterm/xterm";
import type {Event} from "@tauri-apps/api/event";
import {Channel} from "@tauri-apps/api/core";
import {TerminalProfile, CurrentCommand} from "../types/terminal.ts";
import type {FloatingFitAddon} from "../lib/FloatingFitAddon.ts";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {parseProfilePadding} from "../lib/term.ts";
import {isInitialWindowSizeApplied, markInitialWindowSizeApplied, sizeMainWindowToProfile} from "../lib/initialWindowSize.ts";
import {ChunkedWriter} from "../lib/chunkedWriter.ts";
import {loadBindings, parseTabIndex} from "../lib/bindings.ts";
import type {Binding} from "../types/config.ts";
import {Actions} from "../types/config.ts";
import {isMacOS} from "../lib/platform.ts";
import {openConfigFile} from "../lib/configFile.ts";
import {useGlobalConfig} from "../hooks/config.tsx";
import {useI18n} from "../hooks/i18n.tsx";
import {useOutputMode} from "../hooks/useOutputMode.ts";
import {useCurrentCommand} from "../hooks/useCurrentCommand.ts";
import {useEdgeBackground} from "../hooks/useEdgeBackground.ts";
import {setupTermAddons} from "../lib/setupTermAddons.ts";
import {useTauriListen, useTauriSubscription} from "../hooks/useTauriListen.ts";
import { info, debug, error, warn } from "@tauri-apps/plugin-log";
import {getCurrentWebview, type DragDropEvent} from "@tauri-apps/api/webview";
import type {SerializeAddon} from "@xterm/addon-serialize";
import type {SearchAddon} from "@xterm/addon-search";
import {readClipboardText} from "../lib/clipboardApi.ts";
import {reattachTerminal, resizeTerminal, setThrottle, startTerminal, writeToTerminal} from "../lib/terminalApi.ts";
import {installImeCompositionGuard} from "../lib/imeCompositionGuard.ts";
import SearchBar from "./SearchBar.tsx";

interface TermProps {
    id: string;
    profile: TerminalProfile;
    // Background color used to fill the terminal's own padding region (the gap
    // between the canvas and the rounded shell). Without it the padding is
    // transparent and the chrome layer beneath shows through as a border.
    // Comes from App's effective bg (theme bg, or the TUI edge bg when spread).
    fillBg?: string;
    // When set (theme mode system/light/dark), forces the terminal canvas to
    // this background color, overriding the profile theme and fullscreen-TUI
    // edge sampling. The foreground is auto-adjusted for readability. null =
    // canvas follows the profile/TUI as usual (theme mode "terminal").
    forceBg?: string | null;
    // Pre-parsed bindings (merged defaults + user overrides), shared from App
    // so every terminal uses the same parsed set instead of re-parsing each.
    bindings: Binding[];
    // Padding offset shared from App (derived from window maximize state +
    // platform), so every terminal shares one source of truth.
    paddingOffset: number;
    isActive?: boolean;
    onClose?: () => void;
    onNewTab?: (profileName?: string) => void;
    onOpenCommandPalette?: () => void;
    onOpenSettings?: () => void;
    onToTab?: (index: number) => void;
    onToggleSidebar?: () => void;
    // Reports the uniform background color sampled from the terminal's outer
    // ring (a fullscreen TUI's own bg), or null when there is none. Only the
    // active tab reports; inactive tabs report null.
    onEdgeBackgroundChange?: (color: string | null) => void;
    // Reports the currently-running command for this terminal, or null when
    // idle at the shell prompt. Drives the small subtitle under the tab title.
    onCommandChange?: (command: CurrentCommand | null) => void;
    // Reports a finished command's exit code (shell-integration precmd),
    // paired with the command text that was just running. Feeds the per-command
    // history on the backend (MCP `list_command_history`). The current command
    // is cleared separately via onCommandChange(null) immediately after.
    onCommandExit?: (payload: {command: string | null; exitCode: number}) => void;
    // When set, this Term reattaches to an existing live PTY (torn-off-tab
    // window) instead of spawning a new one: it replays `scrollback` into
    // xterm, then calls `reattachTerminal(ptyId, …)` so the running process
    // streams to this window. The `id` prop is ignored for backend calls in
    // this mode — `reattach.ptyId` is the canonical PTY id.
    reattach?: { ptyId: string; scrollback: string };
    // Scrollback to replay on a FRESH-start (session restore), where a NEW
    // PTY is spawned. Unlike reattach.scrollback (which plays before swapping
    // the channel to a live process), this plays before startTerminal spawns
    // the new shell — so the restored history appears, then the new prompt
    // boots below it. Distinct from reattach: a tab is in at most one mode.
    initialScrollback?: string;
    // Register a serialize function (captures the xterm buffer for tear-off)
    // with the parent. The parent stores it and calls it right before tearing
    // the tab off. Returns a cleanup that deregisters the function.
    onRegisterSerialize?: (fn: () => string) => () => void;
    // Register an "open search" trigger with the parent so the command palette
    // (which lives in App) can open this terminal's in-terminal search bar.
    // Returns a cleanup that deregisters the trigger. Mirrors onRegisterSerialize.
    onRegisterSearch?: (open: () => void) => () => void;
    // Tear this tab off into its own window. Wired to the `tearOffTab` action.
    onTearOff?: () => void;
}

/** Profile keys the hot-apply effect must NOT assign onto the live xterm
 *  instance: the mount-time constructor strip excludes them (not xterm
 *  options), plus cols/rows (would resize the OS window), webgl and
 *  graphemeClusters (addons can't be unloaded cleanly), ligatures (handled
 *  by re-registering the character joiner) and theme (applied with the
 *  edge-sampling fallback kept in sync). */
const HOT_APPLY_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
    "cols", "rows", "webgl", "padding", "themePath", "theme", "fontStyle",
    "graphemeClusters", "ligatures",
    "name", "exePath", "cwd", "default", "type", "ssh",
    "startupCommand", "keepAfterExit", "launcher",
]);

/** xterm options that change cell metrics — applying one requires a re-fit
 *  (and, when the grid shifts, a PTY resize via the onResize path). */
const FONT_METRIC_KEYS: ReadonlySet<string> = new Set([
    "fontFamily", "fontSize", "fontWeight", "fontWeightBold", "letterSpacing", "lineHeight",
]);

export default function Term(props : TermProps) {
    const {id, profile, isActive, bindings, paddingOffset} = props;
    // The PTY id used for backend calls. In reattach mode the canonical id
    // is the torn-off tab's original PTY (still alive on the backend); in
    // normal mode it is this tab's own freshly-minted id. Shared by the init
    // effect (onData/onResize routing), the listeners, and reattach calls.
    const ptyId = props.reattach?.ptyId ?? id;
    const term = useRef<Terminal | null>(null);
    const termRef = useRef<HTMLDivElement>(null);
    const isInitialized = useRef<boolean>(false);
    // SerializeAddon instance (loaded once at init). Used by the parent to
    // capture the buffer when tearing this tab off into a new window.
    const serializeAddonRef = useRef<SerializeAddon | null>(null);
    // SearchAddon instance (loaded once at init). Drives the in-terminal search
    // bar overlay (findNext/findPrevious + live match decorations).
    const searchAddonRef = useRef<SearchAddon | null>(null);
    // FitAddon instance (loaded once at init). Held in a ref so the separate
    // resize-observer effect (which re-runs normally under StrictMode, unlike
    // the one-shot init effect) can call fit() without re-deriving it.
    const fitAddonRef = useRef<FloatingFitAddon | null>(null);
    // Id returned by term.registerCharacterJoiner for ligatures, so a hot
    // font change can deregister the old joiner (it closes over the OLD
    // family's font table) and re-enable against the new family.
    const ligatureJoinerIdRef = useRef<number | undefined>(undefined);
    // The profile theme's canvas background, i.e. the color the edge-sampling
    // effect restores when a fullscreen TUI's sampled background goes away.
    // Kept in a ref rather than an effect-local snapshot so hot-applying a new
    // theme updates the fallback the ALREADY-RUNNING sampler restores to.
    const profileThemeBgRef = useRef<string | undefined>(profile.theme?.background);
    // The last profile whose render options were applied to the live xterm
    // instance (at mount or via the hot-apply effect below). Diffed against
    // the incoming profile to compute the minimal set of live changes.
    const appliedProfileRef = useRef<TerminalProfile>(profile);
    const padding = useMemo(() => parseProfilePadding(profile, paddingOffset), [profile, paddingOffset]);
    const {config} = useGlobalConfig();
    const t = useI18n();
    const {markInteractive} = useOutputMode(id);
    const [isDragOver, setIsDragOver] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    // Bumped on every search trigger so an already-open SearchBar re-focuses
    // its input: the shortcut always focuses the bar, never closes it — only
    // Escape in the bar (or its ✕ button) does.
    const [searchFocusTick, setSearchFocusTick] = useState(0);
    const isActiveRef = useRef(isActive);
    isActiveRef.current = isActive;

    // Open the search bar and focus its input. Shared by the `search` binding
    // (handleActions) and the command-palette trigger (onRegisterSearch): the
    // shortcut never toggles the bar closed — re-triggering just re-focuses.
    const openSearch = useCallback(() => {
        setSearchOpen(true);
        setSearchFocusTick((tick) => tick + 1);
    }, []);

    const handleActions = (action: Actions, args?: Record<string, string>) => {
        info(`Term action: ${action}${args ? ` args=${JSON.stringify(args)}` : ""}`);
        switch (action) {
            case "closeTab":
                props.onClose?.();
                break;
            case "newTab":
                props.onNewTab?.(args?.profileName);
                break;
            case "openConfigFile":
                openConfigFile().catch((e: unknown) => {
                    warn(`Failed to open the config file: ${e}`).catch(() => {});
                });
                break;
            case "openCommandPalette":
                props.onOpenCommandPalette?.();
                break;
            case "openSettings":
                props.onOpenSettings?.();
                break;
            case "toggleSidebar":
                props.onToggleSidebar?.();
                break;
            case "toTab": {
                const idx = parseTabIndex(args);
                if (!isNaN(idx)) props.onToTab?.(idx);
                break;
            }
            case "tearOffTab":
                props.onTearOff?.();
                break;
            case "search":
                openSearch();
                break;
            case "selectAll":
                term.current?.selectAll();
                break;
            case "paste":
                // Route through xterm's paste() so bracketed-paste mode is
                // honored; term.onData forwards the bytes to the PTY.
                readClipboardText().then((text) => {
                    if (text) term.current?.paste(text);
                }).catch((e) => {
                    error(`Paste failed: ${e}`).catch(() => {});
                });
                break;
            // copy is dispatched inside loadBindings (it needs the live
            // selection to decide fall-through) and never reaches this switch.
        }
    };

    // Keep handleActions ref fresh for the bindings callback
    const handleActionsRef = useRef(handleActions);
    handleActionsRef.current = handleActions;

    // Keep onClose ref fresh for the term-exit listener (avoid stale closure)
    const onCloseRef = useRef(props.onClose);
    onCloseRef.current = props.onClose;

    // keepAfterExit mode (frozen after the command/shell exits). Kept as a ref
    // so the term-exit listener (set up once) reads the current value without
    // a stale closure. `frozenRef` guards against re-triggering if multiple
    // term-exit events ever arrive for the same PTY.
    const keepAfterExitRef = useRef(profile.keepAfterExit);
    keepAfterExitRef.current = profile.keepAfterExit;
    const frozenRef = useRef(false);

    // Current-command tracking: parses shell-integration OSC sequences from
    // the output stream (feedOutput below) and subscribes to the backend's
    // /proc fallback (suppressed once OSC integration proves active). See
    // hooks/useCurrentCommand.ts.
    const {feedOutput} = useCurrentCommand({
        ptyId,
        onCommandChange: props.onCommandChange,
        onCommandExit: props.onCommandExit,
    });

    // Drag-and-drop: insert file path into terminal
    const lastDropRef = useRef(0);
    const subscribeDragDrop = useCallback(
        (handler: (event: Event<DragDropEvent>) => void) => getCurrentWebview().onDragDropEvent(handler),
        [],
    );
    useTauriSubscription(subscribeDragDrop, (event) => {
        if (!isActiveRef.current) return;

        if (event.payload.type === 'enter' || event.payload.type === 'over') {
            setIsDragOver(true);
        } else if (event.payload.type === 'drop') {
            setIsDragOver(false);
            if (event.payload.paths.length > 0) {
                markInteractive();
                const now = Date.now();
                if (now - lastDropRef.current < 200) return;
                lastDropRef.current = now;
                const filePaths = event.payload.paths.map(p =>
                    p.includes(' ') ? `"${p}"` : p
                ).join(' ');
                writeToTerminal(id, filePaths + ' ').then();
            }
        } else if (event.payload.type === 'leave') {
            setIsDragOver(false);
        }
    }, `drag-drop listener for terminal ${id}`);

    // Initialize terminal
    useEffect(() => {
        if (isInitialized.current) return;
        isInitialized.current = true;

        // Create terminal inside effect so StrictMode remount gets a fresh instance
        // Strip non-xterm properties (fontStyle, padding, name, exePath, etc.) so they
        // don't interfere with xterm's canvas font measurement and rendering.
        const {
            cols: _cols, rows: _rows, webgl: _webgl, padding: _padding,
            themePath: _themePath, theme: _theme, fontStyle: _fontStyle,
            name: _name, exePath: _exePath, cwd: _cwd, default: _default,
            type: _type, ssh: _ssh,
            ...xtermOptions
        } = profile;
        term.current = new Terminal({
            allowProposedApi: true,
            ...xtermOptions,
        });

        // Only the main window applies the profile's default rows/cols as an
        // initial OS window size. Torn-off windows keep whatever size the
        // source window handed them (createTearoffWindow), so a tab torn out
        // of a 120x40 window doesn't snap back to 80x24 on mount.
        // Skip when "remember window size" is on with a saved size — the
        // geometry restore in useWindowGeometry applies the remembered size
        // AND releases the show gate on that path (nothing marks here).
        const skipForRemembered = !!(config.rememberWindowSize && config.rememberedWindowSize);
        if (!isInitialWindowSizeApplied() && getCurrentWindow().label === "main" && !skipForRemembered) {
            // Claim synchronously (a second Term from a multi-tab session
            // restore, mounting in the same commit, must not size again).
            // sizeMainWindowToProfile handles the hidden-window shapes and
            // releases the show gate once the resize settles (or immediately
            // when deferring until visible) — see lib/initialWindowSize.ts.
            markInitialWindowSizeApplied();
            sizeMainWindowToProfile(
                profile,
                () => ({width: termRef.current?.clientWidth ?? 0, height: termRef.current?.clientHeight ?? 0}),
                `terminal ${id}`,
            );
        } else if (!isInitialWindowSizeApplied() && !skipForRemembered) {
            // Skipped for another reason (not the main window, or sizing
            // already handled) — mark so a later profile change doesn't
            // suddenly resize the window. Non-main windows never consult the
            // show gate, so no settle is needed on this branch.
            info(
                `Skipped initial window sizing (marking applied): alreadyApplied=${isInitialWindowSizeApplied()} ` +
                `window=${getCurrentWindow().label}`,
            ).catch(() => {});
            markInitialWindowSizeApplied();
        }

        // profile is already the product of parseProfile(), which resolved
        // themePath into an inline theme and stripped it — no need to re-read.
        if (profile.theme) {
            term.current!.options.theme = profile.theme;
        }

        // Standard addon stack (web links, Unicode 11, optional graphemes/
        // WebGL, image, fit, serialize, search). See lib/setupTermAddons.ts.
        const {fitAddon, serializeAddon, searchAddon} = setupTermAddons(term.current, profile, id);
        fitAddonRef.current = fitAddon;
        serializeAddonRef.current = serializeAddon;
        searchAddonRef.current = searchAddon;

        if (termRef.current) {
            term.current.open(termRef.current);
            fitAddon.fit();
            debug(`Terminal opened: id=${id}`);
        }

        // Optional programming-ligature rendering. Kicked off right after
        // term.open() — the dynamic import is itself async, so it doesn't block
        // this synchronous path, and the ~50ms font parse (loadBuffer, inside
        // lib/ligatures.ts) lands inside the PTY spawn + IPC round-trip window,
        // where the main thread is otherwise idle waiting for first output.
        // The module-level font cache means a preloaded global font (warmed at
        // app startup in config.tsx) is an instant cache hit. registerCharacter
        // Joiner installs synchronously and serves fallback ranges immediately;
        // the real font swaps in lazily on the next natural render.
        if (profile.ligatures) {
            const family = profile.fontFamily;
            import("../lib/ligatures.ts").then(({enableLigatures}) => {
                if (!term.current) return;
                ligatureJoinerIdRef.current = enableLigatures(term.current, family);
            }).catch((e) => {
                info(`Failed to load ligatures module: ${e}`);
            });
        }

        // Load keybindings right after terminal is ready
        loadBindings(term.current, bindings, (action, args) => {
            handleActionsRef.current(action, args);
        });
        info(`Bindings loaded for terminal with id ${id}`);

        term.current.onData((data) => {
            writeToTerminal(ptyId, data).then();
            markInteractive();
        });
        // One-shot: what the first fit() actually settled on. Compared with the
        // profile's configured rows/cols it tells us (from the log alone)
        // whether a wrong window size came from bad cell measurement or from
        // renderer-side rounding after the size was applied.
        let loggedFirstFit = false;
        term.current.onResize(({cols, rows}) => {
            if (!loggedFirstFit) {
                loggedFirstFit = true;
                info(
                    `First fit for terminal ${id}: ${cols}x${rows} (configured ${profile.cols ?? 80}x${profile.rows ?? 24}) ` +
                    `inner=${window.innerWidth}x${window.innerHeight} container=${termRef.current?.clientWidth ?? "?"}x${termRef.current?.clientHeight ?? "?"}`,
                ).catch(() => {});
            }
            resizeTerminal(ptyId, cols, rows).then();
            markInteractive();
        });

        // Bounded-chunk feeder for term.write(): coalesces bursts into bounded
        // chunks drained on a macrotask schedule (time-sliced so the renderer
        // stays alive) and drives read backpressure on the backend so the
        // reader can't outrun xterm on heavy workloads (vtebench). See
        // lib/chunkedWriter.ts for the full rationale.
        const writer = new ChunkedWriter(term.current, undefined, (throttled) => {
            // Frontend-driven backpressure: pause/resume the backend reader so
            // xterm isn't flooded faster than it can render. Fire-and-forget —
            // invokeWithLog records any failure. ptyId routes to the right PTY
            // (torn-off tabs reuse the original PTY, not this tab's id).
            setThrottle(ptyId, throttled).then();
        });

        // Backend streams PTY output over this Channel (low-overhead,
        // binary-safe UTF-8, with dynamic burst coalescing). The handler does
        // the same OSC parse → writer.push the old `term-write` event
        // listener did.
        const outputChannel = new Channel<string>();
        outputChannel.onmessage = (data: string) => {
            if (term.current && data) {
                feedOutput(data);
                writer.push(data);
            }
        };

        if (props.reattach) {
            // Tear-off window: replay the captured scrollback first so the new
            // xterm shows the history, then swap the backend's output channel
            // to this window's Channel. The PTY process is NOT respawned.
            if (props.reattach.scrollback) {
                term.current.write(props.reattach.scrollback);
            }
            reattachTerminal(ptyId, outputChannel).then(() => {
                info(`Terminal reattached: ptyId=${ptyId} in window for tab ${id}`);
                resizeTerminal(ptyId, term.current!.cols, term.current!.rows).then();
            }).catch((e) => {
                error(`Failed to reattach terminal ptyId=${ptyId}: ${e}`).catch(() => {});
            });
        } else {
            // Session-restore: replay saved scrollback before the new shell
            // boots so the restored history shows, then the fresh prompt
            // appears below it. The ChunkedWriter (`writer`) feeds xterm the
            // same way live output does, so large scrollback stays smooth.
            if (props.initialScrollback) {
                term.current.write(props.initialScrollback);
            }
            startTerminal(id, profile, outputChannel).then(() => {
                info(`Terminal started: id=${id} profile=${profile.name}`);
                resizeTerminal(id, term.current!.cols, term.current!.rows).then();
            }).catch((e) => {
                error(`Failed to start terminal id=${id} (profile=${profile.name}): ${e}`).catch(() => {});
            });
        }
    }, [id]);

    // Hot-apply render options when the profile changes (config hot reload,
    // settings save, profile edit). xterm's options are runtime-mutable, so
    // everything xterm owns is assigned onto the live instance — the same
    // key set the mount-time constructor strip passes through. Deliberately
    // NOT hot-applied:
    //  - cols/rows: would resize the OS window under the user's hands;
    //    applies to NEW terminals/windows only.
    //  - webgl / graphemeClusters: addons cannot be unloaded cleanly once
    //    loaded — new terminals only.
    // theme is applied with the edge-sampling fallback (profileThemeBgRef)
    // kept in sync; a font-metric or padding change re-fits, which re-sizes
    // the PTY through the existing onResize → resizeTerminal path; ligatures
    // is handled by re-registering the character joiner against the new
    // family (the old joiner closes over the old font table).
    useEffect(() => {
        const liveTerm = term.current;
        if (!liveTerm) return;
        const prev = appliedProfileRef.current;
        if (prev === profile) return;
        appliedProfileRef.current = profile;

        const current = profile as unknown as Record<string, unknown>;
        const before = prev as unknown as Record<string, unknown>;
        let fontMetricsChanged = false;
        for (const key of new Set([...Object.keys(current), ...Object.keys(before)])) {
            if (HOT_APPLY_EXCLUDED_KEYS.has(key)) continue;
            if (current[key] === before[key]) continue;
            (liveTerm.options as unknown as Record<string, unknown>)[key] = current[key];
            if (FONT_METRIC_KEYS.has(key)) fontMetricsChanged = true;
        }

        if (JSON.stringify(profile.theme) !== JSON.stringify(prev.theme) && profile.theme) {
            // Update the fallback BEFORE assigning: the edge sampler's next
            // tick re-applies a fullscreen TUI's color on top of this, and
            // its clear path restores from profileThemeBgRef.
            profileThemeBgRef.current = profile.theme.background;
            liveTerm.options.theme = {...profile.theme};
        }

        if (profile.ligatures !== prev.ligatures
            || (profile.ligatures && profile.fontFamily !== prev.fontFamily)) {
            if (ligatureJoinerIdRef.current !== undefined) {
                liveTerm.deregisterCharacterJoiner(ligatureJoinerIdRef.current);
                ligatureJoinerIdRef.current = undefined;
            }
            if (profile.ligatures) {
                const family = profile.fontFamily;
                import("../lib/ligatures.ts").then(({enableLigatures}) => {
                    if (term.current) {
                        ligatureJoinerIdRef.current = enableLigatures(term.current, family);
                    }
                }).catch((e) => {
                    info(`Failed to load ligatures module: ${e}`);
                });
            }
        }

        if (fontMetricsChanged || JSON.stringify(profile.padding) !== JSON.stringify(prev.padding)) {
            // fit() re-measures with the new metrics; when cols/rows shift,
            // the onResize handler forwards the new grid to the PTY.
            fitAddonRef.current?.fit();
        }
        info(`Hot-applied render options to terminal ${id} (profile=${profile.name})`).catch(() => {});
    }, [profile, id]);

    // WebKitGTK + IBus can commit text without a matching compositionstart.
    // Normalize that event sequence before xterm's delayed keyCode-229 fallback
    // reads the textarea, and suppress its duplicate unmatched compositionend.
    // Config-gated (imeDuplicateInputFix, default on): the per-commit textarea
    // rewrite can cost IME responsiveness, so users who feel lag can opt out
    // and get the raw xterm behavior back. Toggling re-runs this effect — the
    // guard's disposer uninstalls it live, no terminal restart needed.
    const imeFixEnabled = config.imeDuplicateInputFix !== false;
    useEffect(() => {
        if (!imeFixEnabled) return;
        const textarea = termRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
        if (!textarea) return;
        return installImeCompositionGuard(textarea);
    }, [id, imeFixEnabled]);

    // Register this terminal's serialize function with the parent so the
    // "tear off tab" command can capture the xterm buffer right before opening
    // the new window. Re-runs only if the parent hands us a new registrar
    // (it won't in practice — App passes a stable callback); the cleanup
    // deregisters so a closed/removed tab's stale fn is never called.
    useEffect(() => {
        if (!props.onRegisterSerialize) return;
        const serialize = () => {
            try {
                return serializeAddonRef.current?.serialize() ?? "";
            } catch (e) {
                error(`Failed to serialize terminal ${id} for tear-off: ${e}`).catch(() => {});
                return "";
            }
        };
        return props.onRegisterSerialize(serialize);
    }, [props.onRegisterSerialize, id]);

    // Register an "open search" trigger with the parent so the command palette
    // can open this terminal's search bar. Mirrors the serialize registration.
    useEffect(() => {
        if (!props.onRegisterSearch) return;
        return props.onRegisterSearch(openSearch);
    }, [props.onRegisterSearch, openSearch]);

    // ResizeObserver: refit the terminal whenever its container changes size.
    // Lives in its own effect (NOT inside the one-shot init effect) so that:
    //   1. React StrictMode's mount→unmount→remount cycle doesn't leave us
    //      with a disconnected observer — this effect has no isInitialized
    //      guard, so it re-runs and re-attaches cleanly on the second mount.
    //   2. Real unmount (tab close / tear-off) disconnects the observer so we
    //      never call fit() on a disposed terminal.
    // The init effect must have run first (it creates the Terminal + addons);
    // we check termRef + fitAddonRef and bail otherwise. Re-running before
    // init completes is harmless — there's just nothing to observe yet.
    useEffect(() => {
        const container = termRef.current;
        const fit = fitAddonRef.current;
        if (!container || !fit) return;
        let firstFrame: number | null = null;
        let secondFrame: number | null = null;

        const cancelScheduledFit = () => {
            if (firstFrame !== null) cancelAnimationFrame(firstFrame);
            if (secondFrame !== null) cancelAnimationFrame(secondFrame);
            firstFrame = null;
            secondFrame = null;
        };
        const fitAfterLayout = () => {
            cancelScheduledFit();
            if (!isMacOS()) {
                fit.fit();
                return;
            }

            // macOS applies the native Overlay window size asynchronously.
            // Waiting through two WebKit frames ensures both the flex layout
            // and the canvas compositing layer have adopted the final size;
            // fitting earlier leaves xterm slightly too tall and its first
            // rounded-corner clip does not repaint until a manual resize.
            firstFrame = requestAnimationFrame(() => {
                firstFrame = null;
                secondFrame = requestAnimationFrame(() => {
                    secondFrame = null;
                    if (container.isConnected) fit.fit();
                });
            });
        };

        const observer = new ResizeObserver(fitAfterLayout);
        observer.observe(container);
        // Fit once on attach: this catches the case where the OS window was
        // resized (e.g. the initial setSize call) between terminal init and
        // this observer attaching.
        fitAfterLayout();
        return () => {
            observer.disconnect();
            cancelScheduledFit();
        };
    }, [id]);

    // term-exit subscription (useTauriListen handles the unlisten +
    // unmount-race cleanup). Critical for tear-off: when a tab is torn off,
    // the source Term unmounts WITHOUT the PTY exiting, so a leaked term-exit
    // listener would later fire onClose on an unmounted component — the
    // hook's cleanup keeps only the currently-mounted Term (in whichever
    // window owns the PTY now) subscribed. The term-command fallback listener
    // lives in useCurrentCommand.
    useTauriListen(`term-exit-${ptyId}`, () => {
        // A PTY can legitimately emit term-exit more than once: React
        // StrictMode (dev) mounts the listener twice before the first
        // cleanup runs, and an old listener can also linger briefly across
        // a fast tab teardown. So this handler MUST be idempotent — a
        // duplicate event must never close a tab we decided to keep.
        if (frozenRef.current) {
            debug(`term-exit duplicate for frozen ptyId=${ptyId}, ignoring`);
            return;
        }
        info(`Terminal exited: ptyId=${ptyId}`);
        // "freeze": suppress the auto-close so the user can read the
        // command's final output. The PTY is gone (so the terminal is
        // read-only), but the xterm buffer + scrollback stay on screen
        // until the user closes the tab manually (Ctrl+W / tab close).
        // "shell" never reaches here until the user exits the dropped-to
        // shell, so it falls through to the normal close.
        if (keepAfterExitRef.current === "freeze") {
            frozenRef.current = true;
            info(`Terminal frozen after exit (keepAfterExit=freeze): ptyId=${ptyId}`);
            return;
        }
        onCloseRef.current?.();
    });

    // Hot-reload keybindings when the config changes (e.g. after the user edits
    // a shortcut in Settings). attachCustomKeyEventHandler replaces the previous handler, so
    // already-open terminals pick up the new bindings live without needing a tab restart.
    useEffect(() => {
        if (!isInitialized.current || !term.current) return;
        loadBindings(term.current, bindings, (action, args) => {
            handleActionsRef.current(action, args);
        });
        debug(`Bindings hot-reloaded for terminal ${id}`);
    }, [bindings, id]);

    // Auto-focus xterm when this tab becomes active
    useEffect(() => {
        if (isActive && term.current) {
            term.current.focus();
        }
    }, [isActive]);

    // Re-focus xterm when the OS window itself regains focus and this tab is
    // the active one — so clicking into the window (or alt-tabbing back) puts
    // keyboard input straight into the terminal without an extra click. Only
    // the active Term subscribes; the handler still gates on isActiveRef so a
    // tab switch between subscribe and fire can never steal focus.
    const subscribeFocus = useCallback(
        (handler: (event: Event<boolean>) => void) => getCurrentWindow().onFocusChanged(handler),
        [],
    );
    useTauriSubscription(isActive ? subscribeFocus : null, ({payload: focused}) => {
        if (focused && isActiveRef.current && term.current) {
            term.current.focus();
        }
    }, `window focus listener for terminal ${id}`);

    // Edge-background sampling: poll the outermost ring of the buffer and, when
    // one color dominates it (a fullscreen TUI's own bg), sync the xterm-owned
    // layers + this surface's padding and report the color up so the app
    // chrome can follow it. See hooks/useEdgeBackground.ts.
    const {containerBg} = useEdgeBackground({
        id,
        term,
        termRef,
        isActiveRef,
        themeBgRef: profileThemeBgRef,
        onEdgeChange: props.onEdgeBackgroundChange,
        colorSpread: config.enableColorSpread !== false,
        edgeCoverage: config.edgeBackgroundCoverage,
        forceBg: props.forceBg,
    });

    return (
        <div className="w-full h-full overflow-hidden relative" style={{
            // Inherit MaskedSurface's radius at this single clipping layer.
            // The xterm host stays rectangular inside the safe padding;
            // applying the full radius twice would clip its first cell again.
            borderRadius: "inherit",
            // Fill the terminal surface with its own bg so the chrome layer
            // beneath only shows through the rounded corners (the mask). The
            // sampled edge color (a
            // fullscreen TUI's own bg) takes priority so the terminal bleeds
            // seamlessly to its own edges even when content doesn't fill the
            // whole region; falls back to fillBg (theme bg / chrome spread).
            background: containerBg ?? props.fillBg,
            // Keep xterm's absolutely-positioned viewport inside a real CSS
            // content box. Padding on Terminal.element itself does not inset
            // that viewport reliably in WebKit and can make its first layout
            // taller than the surrounding chrome.
            paddingLeft: padding.left,
            paddingRight: padding.right,
            paddingTop: padding.top,
            paddingBottom: padding.bottom,
        }} onPointerDown={markInteractive} onWheel={markInteractive}>
                <div ref={termRef} className="w-full h-full overflow-hidden" style={{
                    fontStyle: profile.fontStyle ?? "normal",
                }}/>
                {isDragOver && (
                    <div
                        className="absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed pointer-events-none"
                        style={{
                            background: "rgba(255,70,31,0.12)",
                            borderColor: "var(--color-brand-cinnabar)",
                        }}
                    >
                        <div
                            className="px-4 py-2 rounded-[var(--radius-md)] text-sm font-medium"
                            style={{
                                background: "var(--color-brand-gradient)",
                                color: "#ffffff",
                            }}
                        >
                            {t["Drop file to insert path"]}
                        </div>
                    </div>
                )}
                <AnimatePresence>
                    {searchOpen && (
                        <SearchBar
                            searchAddon={searchAddonRef.current}
                            terminal={term.current}
                            fillBg={containerBg ?? props.fillBg}
                            focusTick={searchFocusTick}
                            onClose={() => setSearchOpen(false)}
                        />
                    )}
                </AnimatePresence>
        </div>
    );
}
