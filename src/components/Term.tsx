import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {AnimatePresence} from "framer-motion";
import {Terminal} from "@xterm/xterm";
import {listen} from "@tauri-apps/api/event";
import {Channel} from "@tauri-apps/api/core";
import {TerminalProfile, CurrentCommand} from "../types/terminal.ts";
import {FloatingFitAddon} from "../lib/FloatingFitAddon.ts";
import {WebglAddon} from "@xterm/addon-webgl";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {parseProfilePadding} from "../lib/term.ts";
import {profileWindowSize} from "../lib/terminalGeometry.ts";
import {isInitialWindowSizeApplied, markInitialWindowSizeApplied} from "../lib/initialWindowSize.ts";
import {ChunkedWriter} from "../lib/chunkedWriter.ts";
import {sampleEdgeBackground} from "../lib/edgeBackground.ts";
import {loadBindings} from "../lib/bindings.ts";
import {foregroundFor, isColorDark} from "../lib/color.ts";
import type {Binding} from "../types/config.ts";
import {Actions} from "../types/config.ts";
import {isMacOS} from "../lib/platform.ts";
import {openConfigFile} from "../lib/configFile.ts";
import {useGlobalConfig} from "../hooks/config.tsx";
import {useI18n} from "../hooks/i18n.tsx";
import {useOutputMode} from "../hooks/useOutputMode.ts";
import { info, debug, error } from "@tauri-apps/plugin-log";
import {getCurrentWebview} from "@tauri-apps/api/webview";
import {WebLinksAddon} from "@xterm/addon-web-links";
import {openUrl} from "@tauri-apps/plugin-opener";
import {ImageAddon} from "@xterm/addon-image";
import {SerializeAddon} from "@xterm/addon-serialize";
import {SearchAddon} from "@xterm/addon-search";
import {Unicode11Addon} from "@xterm/addon-unicode11";
import {UnicodeGraphemesAddon} from "@xterm/addon-unicode-graphemes";
import {IMAGE_ADDON_SETTINGS} from "../constants.ts";
import {reattachTerminal, resizeTerminal, setThrottle, startTerminal, writeToTerminal} from "../lib/terminalApi.ts";
import {CurrentCommandParser} from "../lib/currentCommand.ts";
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

export default function Term(props : TermProps) {
    const {id, profile, isActive, bindings, paddingOffset} = props;
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
    const padding = useMemo(() => parseProfilePadding(profile, paddingOffset), [profile, paddingOffset]);
    const {config} = useGlobalConfig();
    const t = useI18n();
    const {markInteractive} = useOutputMode(id);
    const [isDragOver, setIsDragOver] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const isActiveRef = useRef(isActive);
    isActiveRef.current = isActive;

    const getWindowSizeFromRowsAndColumns = useCallback(() => {
        const container = termRef.current;
        return profileWindowSize(
            profile,
            paddingOffset,
            container?.clientWidth ?? 0,
            container?.clientHeight ?? 0,
        );
    }, [profile, paddingOffset]);

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
                openConfigFile().then();
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
            case "toTab":
                if (args?.index !== undefined) {
                    const idx = args.index === "last" ? -1 : parseInt(args.index, 10);
                    if (!isNaN(idx)) props.onToTab?.(idx);
                }
                break;
            case "tearOffTab":
                props.onTearOff?.();
                break;
            case "search":
                setSearchOpen((o) => !o);
                break;
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

    // Keep onCommandChange ref fresh and track the current command.
    const onCommandChangeRef = useRef(props.onCommandChange);
    onCommandChangeRef.current = props.onCommandChange;
    const onCommandExitRef = useRef<((payload: {command: string | null; exitCode: number}) => void) | undefined>(undefined);
    onCommandExitRef.current = props.onCommandExit;
    // Last command reported upward. `null` = nothing reported yet / idle.
    const currentCommandRef = useRef<CurrentCommand | null>(null);
    const commandParserRef = useRef<CurrentCommandParser | null>(null);
    // True once the shell has emitted an OSC sequence this session — used to
    // decide whether the backend's process-group fallback should be honored.
    const oscActiveRef = useRef<boolean>(false);

    const reportCommand = useCallback((cmd: CurrentCommand | null) => {
        // Compare structurally (command name + privileged flag) before notifying.
        const prev = currentCommandRef.current;
        const changed =
            prev === null
                ? cmd !== null
                : cmd === null
                    ? true
                    : prev.command !== cmd.command || prev.privileged !== cmd.privileged;
        if (changed) {
            currentCommandRef.current = cmd;
            onCommandChangeRef.current?.(cmd);
        }
    }, []);

    // Drag-and-drop: insert file path into terminal
    const lastDropRef = useRef(0);
    useEffect(() => {
        let unlistenFn: (() => void) | undefined;

        getCurrentWebview().onDragDropEvent((event) => {
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
        }).then((fn) => {
            unlistenFn = fn;
        }).catch((e) => {
            error(`Failed to attach drag-drop listener for terminal ${id}: ${e}`).catch(() => {});
        });

        return () => {
            unlistenFn?.();
        };
    }, [id]);

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

        // The PTY id used for backend calls. In reattach mode the canonical id
        // is the torn-off tab's original PTY (still alive on the backend); in
        // normal mode it is this tab's own freshly-minted id. Declared up here
        // so onData/onResize/loadBindings all route to the right PTY.
        const ptyId = props.reattach?.ptyId ?? id;

        // Only the main window applies the profile's default rows/cols as an
        // initial OS window size. Torn-off windows keep whatever size the
        // source window handed them (createTearoffWindow), so a tab torn out
        // of a 120x40 window doesn't snap back to 80x24 on mount.
        // Skip when "remember window size" is on with a saved size — App.tsx's
        // restore effect has already applied the remembered size, and applying
        // the profile rows/cols here would clobber it.
        const skipForRemembered = !!(config.rememberWindowSize && config.rememberedWindowSize);
        if (!isInitialWindowSizeApplied() && getCurrentWindow().label === "main" && !skipForRemembered) {
            markInitialWindowSizeApplied();
            const windowSize = getWindowSizeFromRowsAndColumns();
            getCurrentWindow().setSize(windowSize).catch((e) => {
                error(`Failed to apply initial window size for terminal ${id}: ${e}`).catch(() => {});
            });
        } else if (!isInitialWindowSizeApplied()) {
            // Mark as applied even when we skipped, so a later profile change
            // doesn't suddenly resize the window.
            markInitialWindowSizeApplied();
        }

        // profile is already the product of parseProfile(), which resolved
        // themePath into an inline theme and stripped it — no need to re-read.
        if (profile.theme) {
            term.current!.options.theme = profile.theme;
        }

        const webLinksAddon = new WebLinksAddon((event, uri) => {
            if ((event.metaKey && isMacOS()) || event.ctrlKey) {
                openUrl(uri).then();
            }
        });
        term.current.loadAddon(webLinksAddon);

        // Unicode 11 width table. xterm ships only Unicode 6 by default, which
        // mis-measures the width of newer emoji / symbols (renders them as 1
        // column instead of 2, scrambling cursor position and forcing extra
        // repaints). Switching the active version to 11 fixes that for any
        // non-ASCII-heavy output (the vtebench unicode bench in particular).
        const unicode11Addon = new Unicode11Addon();
        term.current.loadAddon(unicode11Addon);
        term.current.unicode.activeVersion = "11";

        // Optional grapheme-cluster width rules (experimental). Unicode 11 still
        // splits wide grapheme clusters — emoji ZWJ sequences (🏳️‍🌈), flag pairs,
        // combining marks — each part on its own cell, which mis-aligns them.
        // This addon switches to a grapheme-based provider ("15-graphemes") that
        // treats such a cluster as one cell. On activate it remembers the current
        // version ("11") and restores it on dispose. Higher CPU than 11, so it's
        // opt-in via the profile's `graphemeClusters` render setting.
        if (profile.graphemeClusters) {
            try {
                term.current.loadAddon(new UnicodeGraphemesAddon());
            } catch (e) {
                info(`Grapheme clusters addon failed to load: ${e}`);
            }
        }

        const imageAddon = new ImageAddon(IMAGE_ADDON_SETTINGS);
        term.current.loadAddon(imageAddon);

        const fitAddon = new FloatingFitAddon();
        term.current.loadAddon(fitAddon);
        fitAddonRef.current = fitAddon;

        if (profile.webgl) {
            try {
                const webglAddon = new WebglAddon();
                term.current.loadAddon(webglAddon);
                debug(`WebGL addon loaded for terminal id=${id}`);
            } catch (e) {
                info(`WebGL addon failed to load, falling back to canvas: ${e}`);
            }
        }

        // SerializeAddon captures the xterm buffer (scrollback + viewport) so a
        // torn-off tab can replay its history in the new window. Loaded for
        // every terminal since any tab can be torn off at any time.
        const serializeAddon = new SerializeAddon();
        term.current.loadAddon(serializeAddon);
        serializeAddonRef.current = serializeAddon;

        // SearchAddon powers the in-terminal search bar overlay. Headless: we
        // drive findNext/findPrevious from our own SearchBar component.
        const searchAddon = new SearchAddon();
        term.current.loadAddon(searchAddon);
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
                enableLigatures(term.current, family);
            }).catch((e) => {
                info(`Failed to load ligatures module: ${e}`);
            });
        }

        // Load keybindings right after terminal is ready
        loadBindings(term.current, bindings, (action, args) => {
            handleActionsRef.current(action, args);
        }, config.copyWithCtrl ?? false, (data) => {
            writeToTerminal(ptyId, data).then();
        });
        info(`Bindings loaded for terminal with id ${id}`);

        term.current.onData((data) => {
            writeToTerminal(ptyId, data).then();
            markInteractive();
        });
        term.current.onResize(({cols, rows}) => {
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

        // Lazily create the OSC parser (one per terminal, kept in a ref).
        if (!commandParserRef.current) {
            commandParserRef.current = new CurrentCommandParser();
        }

        // Backend streams PTY output over this Channel (low-overhead,
        // binary-safe UTF-8, with dynamic burst coalescing). The handler does
        // the same OSC parse → writer.push the old `term-write` event
        // listener did.
        const outputChannel = new Channel<string>();
        outputChannel.onmessage = (data: string) => {
            if (term.current && data) {
                // Parse shell-integration sequences BEFORE writing to xterm;
                // xterm drops unknown OSC, so the visible output is unaffected.
                for (const ev of commandParserRef.current!.feed(data)) {
                    if (ev.type === "command") {
                        oscActiveRef.current = true;
                        reportCommand({command: ev.value, privileged: false});
                    } else {
                        // Command finished: pair the just-run command text with
                        // its exit code, forward to the backend history, then
                        // clear the current command (shell is back at prompt).
                        onCommandExitRef.current?.({
                            command: currentCommandRef.current?.command ?? null,
                            exitCode: ev.code,
                        });
                        reportCommand(null);
                    }
                }
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
        return props.onRegisterSearch(() => setSearchOpen(true));
    }, [props.onRegisterSearch]);

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

    // term-command / term-exit event listeners. Lives in its own effect (with
    // a real cleanup) for the same StrictMode + real-unmount reasons as the
    // ResizeObserver above. Critical for tear-off: when a tab is torn off, the
    // source Term unmounts WITHOUT the PTY exiting, so a leaked term-exit
    // listener would later fire onClose on an unmounted component. The cleanup
    // here unregisters both listeners so only the currently-mounted Term (in
    // whichever window owns the PTY now) reacts to events.
    useEffect(() => {
        const ptyId = props.reattach?.ptyId ?? id;
        let unlistenCommand: (() => void) | undefined;
        let unlistenExit: (() => void) | undefined;

        listen<CurrentCommand>(`term-command-${ptyId}`, (event) => {
            if (oscActiveRef.current) return;
            const cmdInfo = event.payload;
            const cmd = (cmdInfo?.command ?? "").trim();
            reportCommand(cmd === "" ? null : { command: cmd, privileged: !!cmdInfo?.privileged });
        }).then((fn) => {
            unlistenCommand = fn;
        }).catch((e) => {
            error(`Failed to listen for term-command-${ptyId}: ${e}`).catch(() => {});
        });

        listen(`term-exit-${ptyId}`, () => {
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
        }).then((fn) => {
            unlistenExit = fn;
        }).catch((e) => {
            error(`Failed to listen for term-exit-${ptyId}: ${e}`).catch(() => {});
        });

        return () => {
            unlistenCommand?.();
            unlistenExit?.();
        };
    }, [id, props.reattach, reportCommand]);

    // Hot-reload keybindings + copyWithCtrl when the config changes (e.g. after the user edits
    // a shortcut in Settings). attachCustomKeyEventHandler replaces the previous handler, so
    // already-open terminals pick up the new bindings live without needing a tab restart.
    useEffect(() => {
        if (!isInitialized.current || !term.current) return;
        loadBindings(term.current, bindings, (action, args) => {
            handleActionsRef.current(action, args);
        }, config.copyWithCtrl ?? false, (data) => {
            writeToTerminal(id, data).then();
        });
        debug(`Bindings hot-reloaded for terminal ${id}`);
    }, [bindings, config.copyWithCtrl, id]);

    // Auto-focus xterm when this tab becomes active
    useEffect(() => {
        if (isActive && term.current) {
            term.current.focus();
        }
    }, [isActive]);

    // Re-focus xterm when the OS window itself regains focus and this tab is
    // the active one — so clicking into the window (or alt-tabbing back) puts
    // keyboard input straight into the terminal without an extra click. Each
    // Term registers its own listener; only the active one's `isActive` gate
    // fires the focus(). Cleanup on unmount.
    useEffect(() => {
        if (!isActive) return;
        let unlisten: (() => void) | undefined;
        let cancelled = false;
        getCurrentWindow().onFocusChanged(({payload: focused}) => {
            if (focused && isActiveRef.current && term.current) {
                term.current.focus();
            }
        }).then((un) => {
            if (cancelled) un();
            else unlisten = un;
        }).catch((e) => {
            error(`Failed to listen for window focus for terminal ${id}: ${e}`).catch(() => {});
        });
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [id, isActive]);

    // Poll the outermost ring of the buffer. When it is a uniform explicit
    // color (a fullscreen TUI's own bg), sync the xterm-owned layers (.xterm
    // and .xterm-viewport, which otherwise paint theme.background over the
    // sub-cell gap to the right/bottom of the canvas) and fill this surface's
    // own padding region with it, so the terminal interior has no seams
    // regardless of the spread setting. The color is also reported up so the
    // whole app chrome (TabBar/TitleBar/window bg) can follow it — but ONLY
    // when color spread is on; off, sampling + interior sync still happen, the
    // chrome spread is just suppressed (null reported). Only the active tab
    // samples/reports; inactive tabs clear it.
    const onEdgeRef = useRef(props.onEdgeBackgroundChange);
    onEdgeRef.current = props.onEdgeBackgroundChange;
    const colorSpreadRef = useRef(config.enableColorSpread !== false);
    colorSpreadRef.current = config.enableColorSpread !== false;
    // Forced bg (theme mode system/light/dark). When set, the canvas takes
    // this color and TUI edge sampling is suppressed so a light TUI can't
    // override a "always dark" window.
    const forceBgRef = useRef<string | null>(props.forceBg ?? null);
    forceBgRef.current = props.forceBg ?? null;
    // Background painted into this surface's padding region (the gap between the
    // canvas and the rounded shell). Follows the sampled edge color so the
    // terminal bleeds seamlessly to its own edges; falls back to props.fillBg
    // (theme bg / chrome spread color) when nothing is sampled.
    const [containerBg, setContainerBg] = useState<string | null>(null);
    useEffect(() => {
        if (!term.current) return;
        const xtermEl = termRef.current?.querySelector(".xterm") as HTMLElement | null;
        const viewportEl = termRef.current?.querySelector(".xterm-viewport") as HTMLElement | null;
        // Snapshot the profile theme's original canvas background. The sampled
        // edge color overrides this base color while a fullscreen TUI is active
        // (so the canvas itself follows the TUI); on clear we restore it so the
        // terminal falls back to the configured theme instead of xterm's
        // built-in default (black). Without this, applying an empty/invalid
        // background would reset theme.background and drop the whole custom theme.
        const originalThemeBg = term.current.options.theme?.background;

        const apply = (next: string | null) => {
            // When clearing, fall back to the original theme bg so the xterm
            // layers and canvas show the configured theme again (NOT "" — an
            // empty background makes xterm drop the theme and revert to its
            // built-in black default).
            const value = next ?? originalThemeBg ?? "";
            if (xtermEl && xtermEl.style.backgroundColor !== value) {
                xtermEl.style.backgroundColor = value;
            }
            if (viewportEl && viewportEl.style.backgroundColor !== value) {
                viewportEl.style.backgroundColor = value;
            }
            if (term.current) {
                const cur = term.current.options.theme;
                const bgChanged = cur?.background !== value;
                // If the new background and the current foreground fall on the
                // same luminance side, text would be unreadable — pick a
                // contrasting foreground. This covers the forced-bg case where
                // a light-theme profile (dark fg) is repainted onto a dark bg.
                const fg = cur?.foreground;
                const contrastFg = fg && isColorDark(value) === isColorDark(fg)
                    ? foregroundFor(value)
                    : fg;
                const fgChanged = contrastFg !== fg;
                if (bgChanged || fgChanged) {
                    term.current.options.theme = {
                        ...cur,
                        background: value,
                        ...(fgChanged ? {foreground: contrastFg} : {}),
                    };
                }
            }
            setContainerBg(next);
        };

        let lastApplied: string | null = null;
        let lastReported: string | null = null;
        const tick = () => {
            if (!term.current) return;
            if (!isActiveRef.current) {
                if (lastApplied !== null) {
                    lastApplied = null;
                    apply(null);
                }
                if (lastReported !== null) {
                    lastReported = null;
                    onEdgeRef.current?.(null);
                }
                return;
            }
            // Forced bg (theme mode system/light/dark): paint the canvas with
            // the forced color and suppress both TUI edge sampling and chrome
            // spread, so a light TUI can't break an "always dark" window.
            const forced = forceBgRef.current;
            if (forced) {
                if (lastApplied !== forced) {
                    lastApplied = forced;
                    apply(forced);
                }
                if (lastReported !== null) {
                    lastReported = null;
                    onEdgeRef.current?.(null);
                }
                return;
            }
            const next = sampleEdgeBackground(term.current);
            // Always keep xterm's own layers + this surface's padding in sync
            // with the edge color so the terminal interior has no seams,
            // regardless of the spread setting.
            if (next !== lastApplied) {
                lastApplied = next;
                apply(next);
            }
            // Only report the color up (to spread it across the chrome) when
            // color spread is enabled. The "reported" color is also tracked so
            // toggling spread on re-reports without waiting for the edge to
            // change, and toggling off clears it.
            const wantReport = colorSpreadRef.current ? next : null;
            if (wantReport !== lastReported) {
                lastReported = wantReport;
                onEdgeRef.current?.(wantReport);
            }
        };
        tick();
        const handle = setInterval(tick, 200);
        return () => {
            clearInterval(handle);
            if (xtermEl) xtermEl.style.backgroundColor = "";
            if (viewportEl) viewportEl.style.backgroundColor = "";
            // Restore the terminal theme's original canvas background so a
            // remount/tab switch doesn't inherit the last sampled TUI color.
            if (term.current && originalThemeBg !== undefined && term.current.options.theme?.background !== originalThemeBg) {
                term.current.options.theme = {...term.current.options.theme, background: originalThemeBg};
            }
            setContainerBg(null);
        };
    }, [id]);

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
                            onClose={() => setSearchOpen(false)}
                        />
                    )}
                </AnimatePresence>
        </div>
    );
}
