import {useEffect, type RefObject} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {TerminalProfile, TerminalRenderOptions} from "../types/terminal.ts";
import {parseProfile, parseProfilePadding, type SystemTheme} from "../lib/term.ts";
import {
    isInitialWindowSizeApplied,
    markInitialWindowSizeApplied,
    notifyInitialWindowSizeSettled,
    sizeMainWindowToProfile,
} from "../lib/initialWindowSize.ts";
import {error} from "@tauri-apps/plugin-log";

/**
 * When the app starts with no terminal (e.g. `sessionSaveMode` "never" +
 * `loadDefaultProfileOnStartup` off), the main window is never sized to fit a
 * terminal — no Term ever mounts to run the usual `profileWindowSize` sizing.
 * This sizes the main window to the DEFAULT profile using the same
 * once-per-session lock Term uses (whichever runs first wins), so the window
 * matches the size a default-profile terminal would have produced and never
 * double-sizes.
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
        // A restored/remembered size already wins (useWindowGeometry) — and
        // that restore also releases the show gate on this path, so nothing
        // marks here.
        if (rememberWindowSize && rememberedWindowSize) return;
        if (!defaultProfile) {
            // No profiles → the first-run WelcomePage: nothing will ever size
            // the window, so settle the show gate immediately.
            notifyInitialWindowSizeSettled();
            return;
        }

        let cancelled = false;
        // Bake global theme/font into the profile exactly as newTerminal does,
        // so the cell measurement matches a real default tab.
        parseProfile(defaultProfile, globalProfile, systemTheme).then((profile) => {
            if (cancelled || isInitialWindowSizeApplied()) return;
            // Claim synchronously so a re-run of this effect can't double-size.
            // sizeMainWindowToProfile handles the hidden-window shapes (warm
            // caches → size before show; cold caches → show now, size once
            // visible) and releases the show gate — see lib/initialWindowSize.ts.
            markInitialWindowSizeApplied();
            // The container fills the whole content area (no padding inset —
            // no Term is mounted). A mounted Term's termRef would be this
            // container minus the profile padding (parseProfilePadding, incl.
            // paddingOffset, exactly as Term applies it). Pass that shrunk
            // size so profileWindowSize's chrome offset (inner - container)
            // comes out chrome + padding — identical to the Term path.
            const pad = parseProfilePadding(profile, paddingOffset);
            sizeMainWindowToProfile(
                profile,
                () => {
                    const container = containerRef.current;
                    return {
                        width: (container?.clientWidth ?? 0) - pad.left - pad.right,
                        height: (container?.clientHeight ?? 0) - pad.top - pad.bottom,
                    };
                },
                `empty state "${profile.name}"`,
            );
        }).catch((e) => {
            error(`Empty state: failed to resolve default profile for sizing: ${e}`).catch(() => {});
        });
        return () => { cancelled = true; };
    }, [active, containerRef, defaultProfile, globalProfile, systemTheme, paddingOffset, rememberWindowSize, rememberedWindowSize]);
}
