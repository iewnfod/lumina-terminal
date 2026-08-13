import {useEffect, type RefObject} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {TerminalProfile, TerminalRenderOptions} from "../types/terminal.ts";
import {parseProfile, parseProfilePadding, type SystemTheme} from "../lib/term.ts";
import {profileWindowSize} from "../lib/terminalGeometry.ts";
import {isInitialWindowSizeApplied, markInitialWindowSizeApplied} from "../lib/initialWindowSize.ts";
import {info, error} from "@tauri-apps/plugin-log";

/**
 * When the app starts with no terminal (e.g. `sessionSaveMode` "never" +
 * `loadDefaultProfileOnStartup` off), the main window is never sized to fit a
 * terminal — no Term ever mounts to run the usual `profileWindowSize` sizing.
 * This sizes the main window to the DEFAULT profile using the same off-screen
 * dummy-xterm measurement (`profileWindowSize`) and the same once-per-session
 * lock Term uses, so the window matches the size a default-profile terminal
 * would have produced and never double-sizes.
 *
 * No-op for tear-off windows (label !== "main") and when a remembered size is
 * set (useWindowGeometry's restore wins) — mirroring Term's guards.
 */
export function useEmptyStateWindowSize(opts: {
    /** True while the empty state is actually mounted. */
    active: boolean;
    /** Ref to the element filling the terminal content area (drives the chrome
     *  inset measurement inside profileWindowSize). */
    containerRef: RefObject<HTMLDivElement | null>;
    defaultProfile: TerminalProfile | undefined;
    globalProfile: TerminalRenderOptions | undefined;
    systemTheme: SystemTheme;
    paddingOffset: number;
    rememberWindowSize: boolean | undefined;
    rememberedWindowSize: {width: number; height: number} | undefined;
}): void {
    const {
        active, containerRef, defaultProfile, globalProfile, systemTheme,
        paddingOffset, rememberWindowSize, rememberedWindowSize,
    } = opts;

    useEffect(() => {
        if (!active) return;
        // A terminal already sized the window this session (the usual path) —
        // e.g. the user closed all tabs after using one. Don't resize.
        if (isInitialWindowSizeApplied()) return;
        if (getCurrentWindow().label !== "main") return;
        // A restored/remembered size already wins (useWindowGeometry).
        if (rememberWindowSize && rememberedWindowSize) return;
        if (!defaultProfile) return;

        let cancelled = false;
        // Bake global theme/font into the profile exactly as newTerminal does,
        // so the dummy-xterm cell measurement matches a real default tab.
        parseProfile(defaultProfile, globalProfile, systemTheme).then((profile) => {
            if (cancelled || isInitialWindowSizeApplied()) return;
            const container = containerRef.current;
            if (!container) return;
            // Match Term's measurement exactly. Term passes its termRef (the
            // terminal mount element), which sits INSIDE the profile padding, so
            // profileWindowSize's chrome offset (inner - container) includes that
            // padding. The empty-state container fills the whole content area
            // (no padding inset), so subtract the profile padding to get the
            // same effective container size — otherwise the window comes out
            // smaller than a terminal's and a later-opened terminal would resize.
            const pad = parseProfilePadding(profile, paddingOffset);
            const w = container.clientWidth - pad.left - pad.right;
            const h = container.clientHeight - pad.top - pad.bottom;
            if (w <= 0 || h <= 0) return; // not laid out yet; a later render retries
            const size = profileWindowSize(profile, paddingOffset, w, h);
            markInitialWindowSizeApplied();
            info(`Empty state: sized main window to default profile "${profile.name}" (${size.width}x${size.height})`);
            getCurrentWindow().setSize(size).catch((e) =>
                error(`Empty state: failed to set window size: ${e}`).catch(() => {}),
            );
        }).catch((e) => {
            error(`Empty state: failed to resolve default profile for sizing: ${e}`).catch(() => {});
        });
        return () => { cancelled = true; };
    }, [active, containerRef, defaultProfile, globalProfile, systemTheme, paddingOffset, rememberWindowSize, rememberedWindowSize]);
}
