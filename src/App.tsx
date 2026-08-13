import Term from "./components/Term.tsx";
import EmptyState from "./components/EmptyState.tsx";
import MaskedSurface from "./components/ui/MaskedSurface.tsx";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {useGlobalConfig} from "./hooks/config.tsx";
import {useMcpServerLifecycle} from "./hooks/useMcpServer.ts";
import {useI18n} from "./hooks/i18n.tsx";
import WelcomePage from "./pages/WelcomePage.tsx";
import TitleBar from "./components/TitleBar.tsx";
import TabBar, { type TabInfo } from "./components/TabBar.tsx";
import {getShellType} from "./lib/shellIcon.ts";
import {getAppIcon} from "./lib/appIcon.ts";
import {visibleRed} from "./lib/color.ts";
import CommandPalette from "./components/CommandPalette.tsx";
import SessionSaveDialog from "./components/SessionSaveDialog.tsx";
import {useEffectiveTheme} from "./hooks/useEffectiveTheme.ts";
import {useSystemTheme} from "./hooks/useSystemTheme.ts";
import {parseBindings, useKeyboardBindings, matchBinding} from "./lib/bindings.ts";
import {Actions} from "./types/config.ts";
import SettingsPage from "./pages/SettingsPage.tsx";
import AboutPage from "./pages/AboutPage.tsx";
import {SETTINGS_TAB_ID, ABOUT_TAB_ID} from "./constants.ts";
import { info, error } from "@tauri-apps/plugin-log";
import {usePaddingOffset} from "./hooks/paddingOffset.ts";
import {useMaximized} from "./hooks/maximized.ts";
import {useGlass} from "./hooks/useGlass.ts";
import {glassSurface} from "./lib/glass.ts";
import {useStartupUpdateCheck} from "./hooks/useStartupUpdateCheck.ts";
import {useUpdater} from "./hooks/useUpdater.ts";
import {useInstallSource} from "./hooks/useInstallSource.ts";
import UpdateModal from "./components/UpdateModal.tsx";
import {listen} from "@tauri-apps/api/event";
import {useWindowGeometry} from "./hooks/useWindowGeometry.ts";
import {useEmptyStateWindowSize} from "./hooks/useEmptyStateWindowSize.ts";
import {useTerminalManager} from "./hooks/useTerminalManager.ts";
import {useCommandPaletteActions} from "./hooks/useCommandPaletteActions.tsx";
import {reportCommandFinished} from "./lib/terminalApi.ts";

const OPEN_ABOUT_EVENT = "lumina-open-about";

function InnerApp({isMaximized, paddingOffset}: {isMaximized: boolean, paddingOffset: number}) {
    const {config, updateConfig} = useGlobalConfig();
    // MCP server lifecycle follows the app (not the settings panel), so the
    // server keeps running even when settings is closed — and (later) when only
    // the tray remains. See hooks/useMcpServer.ts.
    useMcpServerLifecycle();
    const t = useI18n();

    // Terminal lifecycle: tab list, profiles, active id, tear-off + merge.
    // All the create/close/switch state + cross-window listeners live here.
    const mgr = useTerminalManager();
    const {ids, terminals, currentId, commands, reattachTabs, initialScrollbackTabs} = mgr;
    const currentProfile = useMemo(() => {
        if (currentId) {
            return terminals[currentId] ?? null;
        } else {
            return null;
        }
    }, [currentId, terminals]);
    // The default profile (first flagged default, else the first). Used as the
    // terminal-theme fallback when no tab is active (see themeProfile) and by
    // findProfile/newTerminal for the "new tab" action.
    const defaultProfile = useMemo(() => {
        return config.profiles.find(p => p.default) || config.profiles[0];
    }, [config.profiles]);
    const systemTheme = useSystemTheme();
    const themeMode = config.themeMode ?? "terminal";
    // When following the terminal theme but no terminal is active (empty state —
    // all tabs closed, or startup with loadDefaultProfileOnStartup off), fall
    // back to the default profile's palette so the chrome still reads as a
    // terminal theme instead of reverting to black/system. Other modes force
    // their own bg, so the profile is irrelevant there.
    const themeProfile = themeMode === "terminal" && !currentProfile
        ? (defaultProfile ?? null)
        : currentProfile;
    // Translate the theme mode into a dark override for useEffectiveTheme.
    // "terminal" → null (derive from bg, the legacy behavior). "system" → null
    // until the OS theme resolves, then the resolved value.
    const darkOverride =
        themeMode === "light" ? false
        : themeMode === "dark" ? true
        : themeMode === "system" ? (systemTheme === "light" ? false : systemTheme === "dark" ? true : null)
        : null;
    // A forced background color makes the whole window (incl. the terminal
    // canvas) follow the theme mode, not just the chrome text. "terminal" mode
    // leaves the bg to the profile/TUI. Neutral base colors that harmonize with
    // most terminal palettes.
    const forceBg =
        themeMode === "terminal" ? null
        : darkOverride === true ? "#1a1a1a"
        : darkOverride === false ? "#fafafa"
        : null; // system unresolved → briefly fall back to terminal bg
    const {theme: effectiveTheme, bg: effectiveBg, fg: effectiveFg, isSpread, setEdgeBg} = useEffectiveTheme(themeProfile, currentId, config.enableColorSpread !== false, darkOverride, forceBg, config.globalProfile, systemTheme);
    // Glass material filling the terminal area. The terminal surface is clipped
    // to a rounded rectangle via clip-path; its four corners are transparent,
    // exposing this chrome layer beneath — so the chrome reads as a continuous
    // frame wrapping the terminal with rounded inner corners.
    const {supportsGlass} = useGlass();
    const chromeGlass = useMemo(
        () => glassSurface(effectiveBg ?? "#000000", supportsGlass, {blurPx: 16, spread: isSpread}),
        [effectiveBg, supportsGlass, isSpread],
    );
    // Danger color for the privileged-command indicator: follows the theme's
    // ANSI reds so it stays visible even on red-dominant backgrounds.
    const dangerColor = useMemo(
        () => visibleRed(effectiveTheme?.red, effectiveTheme?.brightRed, effectiveBg),
        [effectiveTheme?.red, effectiveTheme?.brightRed, effectiveBg],
    );
    const tabBarVisible = config.showTabBar ?? false;
    const parsedBindings = useMemo(() => parseBindings(config.bindings), [config.bindings]);
    // Per-tab "open search" triggers, registered by each Term (mirrors the
    // serialize-fns map in useTerminalManager). The command palette's
    // "Find in Terminal" calls the active tab's trigger to open its bar.
    const openSearchFns = useRef<Map<string, () => void>>(new Map());
    const openSearch = useCallback(() => {
        if (!currentId) return;
        openSearchFns.current.get(currentId)?.();
    }, [currentId]);
    // Check for updates once on startup unless the user opted out. Runs after
    // config loads; only checks (never auto-installs).
    useStartupUpdateCheck(config.autoUpdateOnStartup !== false);
    // Single updater instance for the whole app — owned here so the sidebar
    // banner, the update modal, and the About page all share one state machine.
    const updater = useUpdater();
    // Detect package-manager-managed installs (pacman/dpkg/rpm) so the update
    // modal can show the package-manager update command instead of the in-app
    // self-updater, which only supports AppImage on Linux.
    const installSource = useInstallSource();
    const [isUpdateModalOpen, setIsUpdateModalOpen] = useState(false);
    // Resolve a profile by name, falling back to the default profile. Centralized
    // so newTab handlers (command palette, keybinding, drag) all share one path.
    const findProfile = useCallback((name?: string) => {
        if (name) {
            const found = config.profiles.find(p => p.name === name);
            if (found) return found;
        }
        return defaultProfile;
    }, [config.profiles, defaultProfile]);

    const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);

    // Main-window geometry: restore on startup, persist on move/resize. No-op
    // for tear-off windows (they're positioned by createTearoffWindow).
    const isMainWindow = getCurrentWindow().label === "main";
    useWindowGeometry(isMainWindow);
    // When the app starts with no terminal (empty state), no Term ever mounts
    // to size the window — so size it to the default profile here, sharing the
    // same once-per-session lock Term uses (whichever runs first wins).
    const emptyStateContainerRef = useRef<HTMLDivElement>(null);
    useEmptyStateWindowSize({
        active: ids.length === 0 && mgr.initialized,
        containerRef: emptyStateContainerRef,
        defaultProfile,
        globalProfile: config.globalProfile,
        systemTheme,
        paddingOffset,
        rememberWindowSize: config.rememberWindowSize,
        rememberedWindowSize: config.rememberedWindowSize,
    });

    // Settings/About are chrome-only tabs (no PTY). openChromeTab adds the id
    // if absent and activates it — the single path used by both handlers.
    const openSettings = useCallback(() => {
        info("Opening settings");
        mgr.openChromeTab(SETTINGS_TAB_ID);
    }, [mgr]);
    const openAbout = useCallback(() => {
        info("Opening about");
        mgr.openChromeTab(ABOUT_TAB_ID);
    }, [mgr]);

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let cancelled = false;

        listen(OPEN_ABOUT_EVENT, () => {
            openAbout();
        }).then((cleanup) => {
            if (cancelled) {
                cleanup();
            } else {
                unlisten = cleanup;
            }
        }).catch((e) => {
            error(`Failed to listen for About menu event: ${e}`);
        });

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [openAbout]);

    // Keyboard bindings for non-terminal tabs (Settings, About, etc.)
    const isNonTerminalTab = currentId === SETTINGS_TAB_ID || currentId === ABOUT_TAB_ID;
    // The App-level key handler also serves the empty state — when the last tab
    // is closed while "keep window on last tab closed" is on, currentId becomes
    // null and no Term/xterm instance is mounted to field shortcuts. Without
    // this, new-tab / settings / command-palette hotkeys become dead keys.
    const appKeyHandlerActive = isNonTerminalTab || currentId === null;
    const handleNonTerminalAction = useCallback((action: Actions, args?: Record<string, string>) => {
        info(`Keybinding action from non-terminal tab: ${action}`);
        switch (action) {
            case "closeTab":
                if (currentId) mgr.closeTerminal(currentId);
                break;
            case "newTab": {
                mgr.newTerminal(findProfile(args?.profileName));
                break;
            }
            case "openSettings":
                openSettings();
                break;
            case "openCommandPalette":
                setIsCommandPaletteOpen(true);
                break;
            case "toggleSidebar":
                updateConfig({ showTabBar: !tabBarVisible });
                break;
            case "toTab":
                if (args?.index !== undefined) {
                    const idx = args.index === "last" ? -1 : parseInt(args.index, 10);
                    if (!isNaN(idx)) mgr.toTab(idx);
                }
                break;
            case "tearOffTab":
                // Only meaningful for terminal tabs; the command palette only
                // shows this action when currentId is a real terminal, and
                // Term handles the keybinding via its own onTearOff. No-op here.
                break;
            case "search":
                // Search is handled inside each Term; on a non-terminal tab there
                // is no terminal to search, so this is a no-op here.
                break;
        }
    }, [currentId, mgr, findProfile, openSettings, tabBarVisible, updateConfig]);
    useKeyboardBindings(parsedBindings, handleNonTerminalAction, appKeyHandlerActive);

    // Global: prevent browser defaults for configured shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (matchBinding(e, parsedBindings)) {
                e.preventDefault();
            }
            // Prevent Ctrl+Shift+C from opening DevTools "Inspect Element"
            if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "c") {
                e.preventDefault();
            }
        };

        window.addEventListener("keydown", handleKeyDown, { capture: true });
        return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
    }, [parsedBindings]);

    // Build command palette actions
    const commandActions = useCommandPaletteActions({
        profiles: config.profiles,
        currentId,
        terminals,
        parsedBindings,
        tabBarVisible,
        closeWindowOnLastTab: config.closeWindowOnLastTab,
        t,
        newTerminal: (profile) => { mgr.newTerminal(profile); },
        closeTerminal: (id) => mgr.closeTerminal(id),
        tearOffTab: (id) => { mgr.tearOffTab(id); },
        openSettings,
        openAbout,
        openSearch,
        updateConfig,
    });

    // Close command palette when Escape is pressed while it's open
    const handleCommandPaletteOpenChange = useCallback((open: boolean) => {
        setIsCommandPaletteOpen(open);
    }, []);

    if (config.profiles.length) {
        const tabs = ids
            .map((id) => {
                if (id === SETTINGS_TAB_ID) {
                    return { id, name: t["Settings"] };
                }
                if (id === ABOUT_TAB_ID) {
                    return { id, name: t["About"] };
                }
                if (id in terminals) {
                    const cmd = commands[id];
                    return {
                        id,
                        name: terminals[id].name,
                        subtitle: cmd ? cmd.command : undefined,
                        commandPrivileged: cmd ? cmd.privileged : false,
                        shellType: getShellType(terminals[id]),
                        // App icon: prefer the running command (more precise —
                        // reflects what's actually foreground), but fall back to
                        // the profile's startupCommand. The fallback matters
                        // because a startup command runs via `<shell> -c <cmd>`,
                        // where the shell often stays the foreground process-
                        // group leader, so foreground_command can't see the
                        // child and term-command never reports it. The static
                        // startupCommand is the user's declared intent for this
                        // tab, so it's a reliable signal in that case.
                        appIcon: (cmd && getAppIcon(cmd.command))
                            ?? getAppIcon(terminals[id].startupCommand ?? "")
                            ?? undefined,
                    };
                }
                return null;
            })
            .filter(Boolean) as TabInfo[];

        return (
            <div
                className="w-full h-full overflow-hidden flex flex-row"
                style={{background: effectiveBg ?? "black"}}
            >
                <CommandPalette
                    isOpen={isCommandPaletteOpen}
                    onOpenChange={handleCommandPaletteOpenChange}
                    actions={commandActions}
                    backgroundColor={effectiveBg ?? "#000000"}
                    foregroundColor={effectiveFg ?? "#ffffff"}
                    bgSpread={isSpread}
                />
                <UpdateModal
                    isOpen={isUpdateModalOpen}
                    onOpenChange={setIsUpdateModalOpen}
                    info={updater.info}
                    status={updater.status}
                    progress={updater.progress}
                    error={updater.error}
                    onInstall={updater.install}
                    installSource={installSource}
                    theme={effectiveTheme}
                />
                <SessionSaveDialog
                    open={mgr.sessionDialog.open}
                    count={mgr.sessionDialog.count}
                    onResolve={mgr.sessionDialog.resolve}
                    backgroundColor={effectiveBg ?? "#000000"}
                    foregroundColor={effectiveFg ?? "#ffffff"}
                />
                <TabBar
                    tabs={tabs}
                    activeId={currentId}
                    onSelect={mgr.switchTab}
                    onClose={mgr.closeTerminal}
                    onNew={() => mgr.newTerminal(defaultProfile)}
                    onTearOff={mgr.tearOffTab}
                    onReorder={mgr.reorderTabs}
                    mergeTargetRef={mgr.mergeTargetRef}
                    dragScreenPosRef={mgr.dragScreenPosRef}
                    backgroundColor={effectiveBg ?? "#000000"}
                    foregroundColor={effectiveFg ?? "#ffffff"}
                    dangerColor={dangerColor}
                    bgSpread={isSpread}
                    collapsed={!tabBarVisible}
                    brandTitle={mgr.brandTitle}
                    defaultProfileName={defaultProfile?.name}
                    updateVersion={updater.status === "available" && updater.info ? updater.info.version : null}
                    onUpdateClick={() => setIsUpdateModalOpen(true)}
                />
                <div className="flex-1 flex flex-col min-w-0">
                    <TitleBar
                        theme={effectiveTheme}
                        bgSpread={isSpread}
                        tabBarVisible={tabBarVisible}
                        onToggleTabBar={() => updateConfig({ showTabBar: !tabBarVisible })}
                        onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
                        onOpenSettings={openSettings}
                        isMaximized={isMaximized}
                    />
                    <div className="flex-1 relative overflow-hidden">
                        {/* Chrome glass layer filling the terminal area. The
                            terminal surfaces above are clipped to a rounded
                            rectangle (clip-path), so their four corners are
                            transparent and expose this layer — making the
                            chrome read as a continuous frame wrapping the
                            terminal. Settings/About sit above this (they fill
                            the area without clipping). */}
                        <div
                            aria-hidden
                            className="absolute inset-0"
                            style={{...chromeGlass, zIndex: 0}}
                        />
                        {currentId === SETTINGS_TAB_ID && (
                            <MaskedSurface className="absolute inset-0" style={{zIndex: 1}}>
                                <SettingsPage theme={effectiveTheme} openAbout={openAbout} />
                            </MaskedSurface>
                        )}
                        {currentId === ABOUT_TAB_ID && (
                            <MaskedSurface className="absolute inset-0" style={{zIndex: 1}}>
                                <AboutPage
                                    theme={effectiveTheme}
                                    updater={updater}
                                    installSource={installSource}
                                    onShowUpdateModal={() => setIsUpdateModalOpen(true)}
                                />
                            </MaskedSurface>
                        )}
                        {/* Empty state: the last tab was closed while "keep
                            window on last tab closed" is on, so the window
                            stays but ids is empty. mgr.initialized (state, set
                            when seeding finishes) gates the first render so
                            this never flashes before the seed decision. Sits
                            above the chrome glass layer like Settings/About. */}
                        {ids.length === 0 && mgr.initialized && (
                            <div ref={emptyStateContainerRef} className="absolute inset-0" style={{zIndex: 1}}>
                                <MaskedSurface className="absolute inset-0">
                                    <EmptyState
                                        foregroundColor={effectiveFg ?? "#ffffff"}
                                        profiles={config.profiles}
                                        bindings={parsedBindings}
                                        profileLastOpened={config.profileLastOpened}
                                        maxProfiles={config.emptyStateMaxProfiles}
                                        onNewTab={(profile) => { mgr.newTerminal(profile); }}
                                    />
                                </MaskedSurface>
                            </div>
                        )}
                        {ids.filter((id) => id in terminals).map((id) => {
                            // A tab reattaches (replay scrollback + swap the PTY's
                            // output channel instead of spawning) when it is a
                            // torn-off window's boot tab OR a tab merged in from
                            // another window — both register in `reattachTabs`.
                            const reattachEntry = reattachTabs[id];
                            const reattach = reattachEntry
                                ? {ptyId: reattachEntry.ptyId, scrollback: reattachEntry.scrollback}
                                : undefined;
                            return (
                            <div
                                key={id}
                                className="absolute inset-0"
                                style={{
                                    zIndex: id === currentId ? 1 : 0,
                                    pointerEvents: id === currentId ? "auto" : "none",
                                    opacity: id === currentId ? 1 : 0,
                                }}
                            >
                                <MaskedSurface
                                    // Mask the terminal to a rounded rectangle so
                                    // its four corners expose the chrome glass
                                    // layer beneath, tying the frame together.
                                    // absolute inset-0 guarantees the surface is
                                    // exactly the same size as the chrome layer
                                    // beneath without adding a visible border.
                                    className="absolute inset-0"
                                >
                                <Term
                                    id={id}
                                    profile={terminals[id]}
                                    fillBg={effectiveBg}
                                    forceBg={forceBg}
                                    paddingOffset={paddingOffset}
                                    isActive={id === currentId}
                                    bindings={parsedBindings}
                                    reattach={reattach}
                                    initialScrollback={initialScrollbackTabs[id]}
                                    onClose={() => mgr.closeTerminal(id)}
                                    onNewTab={(profileName?: string) => {
                                        mgr.newTerminal(findProfile(profileName));
                                    }}
                                    onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
                                    onOpenSettings={openSettings}
                                    onToTab={mgr.toTab}
                                    onToggleSidebar={() => updateConfig({ showTabBar: !tabBarVisible })}
                                    onTearOff={() => mgr.tearOffTab(id)}
                                    onRegisterSearch={(open) => {
                                        openSearchFns.current.set(id, open);
                                        return () => {
                                            // Only delete if it's still ours (avoids wiping a
                                            // re-registered fn after a rapid remount).
                                            if (openSearchFns.current.get(id) === open) {
                                                openSearchFns.current.delete(id);
                                            }
                                        };
                                    }}
                                    onRegisterSerialize={(fn) => {
                                        mgr.serializeFns.current.set(id, fn);
                                        return () => {
                                            // Only delete if it's still ours (avoids wiping a
                                            // re-registered fn after a rapid remount).
                                            if (mgr.serializeFns.current.get(id) === fn) {
                                                mgr.serializeFns.current.delete(id);
                                            }
                                        };
                                    }}
                                    onEdgeBackgroundChange={(color) => {
                                        // Only the active tab's report is honored;
                                        // inactive tabs report null and are ignored.
                                        if (id === currentId) setEdgeBg(color);
                                    }}
                                    onCommandChange={(cmd) => {
                                        mgr.setCommandsFor(id, cmd);
                                    }}
                                    onCommandExit={(p) => {
                                        reportCommandFinished(id, p.command, p.exitCode);
                                    }}
                                />
                                </MaskedSurface>
                            </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        );
    } else {
        return (
            <WelcomePage/>
        );
    }
}

function App() {
    const isMaximized = useMaximized();
    const paddingOffset = usePaddingOffset(isMaximized);

    return (
        <div
            className="w-screen h-screen overflow-hidden relative"
            style={{
                padding: paddingOffset,
                background: "transparent",
            }}
        >
            <div className={`w-full h-full overflow-hidden ${isMaximized ? "" : "rounded-lg"}`}>
                <InnerApp isMaximized={isMaximized} paddingOffset={paddingOffset}/>
            </div>
        </div>
    );
}

export default App;
