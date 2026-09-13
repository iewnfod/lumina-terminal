import {useEffect, useRef, useState, type MutableRefObject, type RefObject} from "react";
import type {Terminal} from "@xterm/xterm";
import {sampleEdgeBackground, selectionOverlayForFlip} from "../lib/edgeBackground.ts";
import {foregroundFor, isColorDark} from "../lib/color.ts";
import {DEFAULT_TERMINAL_THEME, GITHUB_LIGHT_TERMINAL_THEME} from "../constants.ts";

interface UseEdgeBackgroundOptions {
    /** Tab id — keys the effect (re-arm on tab identity change). */
    id: string;
    /** The live xterm instance ref (created by Term's init effect). */
    term: MutableRefObject<Terminal | null>;
    /** Host element ref — the .xterm / .xterm-viewport layers are queried in it. */
    termRef: RefObject<HTMLDivElement | null>;
    /** Latest is-active mirror; only the active tab samples/reports. */
    isActiveRef: MutableRefObject<boolean | undefined>;
    /** The profile theme's canvas background — the color the sampler restores
     *  when a fullscreen TUI's sampled background goes away. SHARED with the
     *  hot-apply effect (Term owns the ref and updates it on theme changes),
     *  so a hot-applied theme updates the fallback the already-running
     *  sampler restores to. */
    themeBgRef: MutableRefObject<string | undefined>;
    /** Reports the uniform background color sampled from the terminal's outer
     *  ring (a fullscreen TUI's own bg), or null when there is none. */
    onEdgeChange?: (color: string | null) => void;
    /** config.enableColorSpread !== false — whether the sampled color also
     *  spreads across the whole app chrome. */
    colorSpread: boolean;
    /** config.edgeBackgroundCoverage — required edge-cell coverage for a
     *  color to count as the TUI background (lib/edgeBackground.ts sanitizes). */
    edgeCoverage?: number;
    /** Forced bg (theme mode system/light/dark). When set, the canvas takes
     *  this color and TUI edge sampling is suppressed. */
    forceBg?: string | null;
}

/**
 * Poll the outermost ring of the xterm buffer. When one explicit color
 * dominates it (a fullscreen TUI's own bg; a few edge-touching stragglers are
 * tolerated per edgeCoverage), sync the xterm-owned layers (.xterm and
 * .xterm-viewport, which otherwise paint theme.background over the sub-cell
 * gap to the right/bottom of the canvas) and fill the surface's own padding
 * region with it, so the terminal interior has no seams regardless of the
 * spread setting. The color is also reported up (onEdgeChange) so the whole
 * app chrome can follow it — but ONLY when color spread is on; off, sampling
 * + interior sync still happen, the chrome spread is just suppressed (null
 * reported). Only the active tab samples/reports; inactive tabs clear it.
 *
 * Extracted verbatim from Term.tsx's self-contained 140-line effect.
 */
export function useEdgeBackground(options: UseEdgeBackgroundOptions): {containerBg: string | null} {
    const {id, term, termRef, isActiveRef, themeBgRef} = options;
    // Latest-value refs so the interval callback reads the current config /
    // props without re-arming the poller.
    const onEdgeRef = useRef(options.onEdgeChange);
    onEdgeRef.current = options.onEdgeChange;
    const colorSpreadRef = useRef(options.colorSpread);
    colorSpreadRef.current = options.colorSpread;
    const edgeCoverageRef = useRef(options.edgeCoverage);
    edgeCoverageRef.current = options.edgeCoverage;
    const forceBgRef = useRef(options.forceBg ?? null);
    forceBgRef.current = options.forceBg ?? null;
    // Background painted into the surface's padding region (the gap between
    // the canvas and the rounded shell). Follows the sampled edge color so the
    // terminal bleeds seamlessly to its own edges; the caller falls back to
    // its own fill (theme bg / chrome spread color) when nothing is sampled.
    const [containerBg, setContainerBg] = useState<string | null>(null);

    useEffect(() => {
        if (!term.current) return;
        const xtermEl = termRef.current?.querySelector(".xterm") as HTMLElement | null;
        const viewportEl = termRef.current?.querySelector(".xterm-viewport") as HTMLElement | null;
        // The profile theme's original canvas background is read from
        // themeBgRef (NOT snapshotted here) so the hot-apply effect can update
        // it when the user changes the theme: the sampled edge color overrides
        // this base while a fullscreen TUI is active (so the canvas itself
        // follows the TUI); on clear we restore it so the terminal falls back
        // to the configured theme instead of xterm's built-in default (black).
        // Without this, applying an empty/invalid background would reset
        // theme.background and drop the whole custom theme.

        const apply = (next: string | null) => {
            // When clearing, fall back to the (current) theme bg so the xterm
            // layers and canvas show the configured theme again (NOT "" — an
            // empty background makes xterm drop the theme and revert to its
            // built-in black default).
            const value = next ?? themeBgRef.current ?? "";
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
                // The same polarity flip blinds the SELECTION: the theme's
                // selectionBackground is an overlay tuned for the bg the theme
                // was designed for, so a dark overlay (light theme) on the
                // forced dark bg — or a light overlay (dark theme) on a light
                // fullscreen TUI — blends into the background and the selected
                // region turns invisible. Substitute the built-in palette's
                // overlay for the applied polarity while the flip lasts, and
                // restore the theme's own selection once it ends.
                const designedBg = themeBgRef.current;
                if (designedBg !== lastDesignedBg) {
                    // The hot-apply effect swapped the whole theme (and updated
                    // themeBgRef), re-seeding the live selectionBackground —
                    // any earlier backup is stale.
                    lastDesignedBg = designedBg;
                    selectionBackup = null;
                }
                const flipOverlay = selectionOverlayForFlip(
                    value || null,
                    designedBg,
                    // The built-in palettes always define a selection overlay
                    // (ITheme marks it optional only to match xterm's type).
                    DEFAULT_TERMINAL_THEME.selectionBackground!,
                    GITHUB_LIGHT_TERMINAL_THEME.selectionBackground!,
                );
                let selectionPatch: {selectionBackground: string | undefined} | undefined;
                if (flipOverlay !== null) {
                    if (selectionBackup === null) selectionBackup = cur?.selectionBackground;
                    if (cur?.selectionBackground !== flipOverlay) selectionPatch = {selectionBackground: flipOverlay};
                } else if (selectionBackup !== null) {
                    if (cur?.selectionBackground !== selectionBackup) selectionPatch = {selectionBackground: selectionBackup ?? undefined};
                    selectionBackup = null;
                }
                if (bgChanged || fgChanged || selectionPatch) {
                    term.current.options.theme = {
                        ...cur,
                        background: value,
                        ...(fgChanged ? {foreground: contrastFg} : {}),
                        ...selectionPatch,
                    };
                }
            }
            setContainerBg(next);
        };

        let lastApplied: string | null = null;
        let lastReported: string | null = null;
        // Selection-polarity substitution bookkeeping (see apply below):
        // `selectionBackup` holds the theme's own selectionBackground while a
        // polarity flip is active (null = not currently substituted).
        let selectionBackup: string | undefined | null = null;
        // Last theme bg the sampler has seen — a change means the hot-apply
        // effect reassigned options.theme wholesale (the live selection is the
        // new theme's own again), invalidating any backup.
        let lastDesignedBg: string | undefined;
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
            const next = sampleEdgeBackground(term.current, edgeCoverageRef.current);
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
            if (term.current && themeBgRef.current !== undefined
                && term.current.options.theme?.background !== themeBgRef.current) {
                term.current.options.theme = {...term.current.options.theme, background: themeBgRef.current};
            }
            // Restore the theme's own selection if it was substituted for a
            // polarity flip, mirroring the background restore above.
            if (term.current && selectionBackup !== null) {
                term.current.options.theme = {
                    ...term.current.options.theme,
                    selectionBackground: selectionBackup ?? undefined,
                };
            }
            setContainerBg(null);
        };
    }, [id]);

    return {containerBg};
}
