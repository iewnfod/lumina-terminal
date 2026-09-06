import {Terminal} from "@xterm/xterm";
import {LogicalSize} from "@tauri-apps/api/window";
import {info} from "@tauri-apps/plugin-log";
import {TerminalProfile} from "../types/terminal.ts";
import {
    cachedCellMetrics,
    cachedChromeOffset,
    ensureCellMetricsLoaded,
    storeCellMetrics,
    storeChromeOffset,
} from "./cellMetrics.ts";

/**
 * Compute the OS window size (logical px) needed to display a profile's
 * configured rows/cols exactly, accounting for chrome insets and the
 * terminal's own padding.
 *
 * Returns null when the size can't be computed reliably YET: WebKitGTK
 * performs no layout while the window is hidden (every clientWidth/Height
 * reads 0), so a cold-cache launch must defer sizing until after the window
 * is visible (the caller — lib/initialWindowSize.ts
 * sizeMainWindowToProfile — handles the retry). With warm caches the size is
 * computed fully offline: cell metrics come from {@link lib/cellMetrics.ts}
 * and the chrome offset from its last live measurement, so the window can be
 * sized BEFORE it is shown.
 *
 * Live computations (a real container size) both measure the cell — an
 * off-screen xterm matched to the profile's font options, since xterm renders
 * glyphs at a size that isn't computable from CSS metrics alone — and refresh
 * the cached chrome offset (inner − container), keeping the offline path
 * honest.
 *
 * Pure-ish logic (DOM + xterm, but no React) per the lib/ layering rule.
 * `containerClientWidth/Height` is the terminal mount element's inner size;
 * pass the same `<div>` Term opens xterm into. That element sits INSIDE the
 * profile padding, so the chrome inset (`inner - container`) already includes
 * the padding — it must not be added again on top.
 */
export function profileWindowSize(
    profile: TerminalProfile,
    containerClientWidth: number,
    containerClientHeight: number,
): LogicalSize | null {
    // Kick the cache load in case no one has yet (idempotent — hooks/
    // config.tsx normally started it right after config load); a measurement
    // below can then persist for the next launch.
    ensureCellMetricsLoaded();
    const laidOut = containerClientWidth > 0 && containerClientHeight > 0;
    const cached = cachedCellMetrics(profile);
    let charWidth: number;
    let charHeight: number;
    if (cached) {
        charWidth = cached.width;
        charHeight = cached.height;
    } else {
        // Measuring needs a laid-out document (the dummy xterm reads renderer
        // dimensions); while the window is hidden it would yield 0s.
        if (!laidOut) return null;
        // Off-screen measurement terminal. Must match the profile's font
        // options so the measured cell size reflects what the real terminal
        // will render.
        const dummyTerm = new Terminal({...profile});
        const dummyDiv = document.createElement("div");
        dummyDiv.style.position = "absolute";
        dummyDiv.style.visibility = "hidden";
        dummyDiv.style.top = "-9999px";
        dummyDiv.style.width = "500px";
        dummyDiv.style.height = "500px";
        dummyDiv.style.fontStyle = profile.fontStyle ?? "normal";
        document.body.appendChild(dummyDiv);
        dummyTerm.open(dummyDiv);
        // @ts-ignore — _charSizeService is internal; measure explicitly for accuracy.
        if (dummyTerm._core?._charSizeService) {
            // @ts-ignore
            dummyTerm._core._charSizeService.measure();
        }
        const renderDimensions = (dummyTerm as any)._core?._renderService?.dimensions;
        const charSizeService = (dummyTerm as any)._core?._charSizeService;
        // The RENDERER's cell — not the raw char measurement — is what the fit
        // addon divides the container by, and the DomRenderer derives it with
        // upward rounding (canvas width via Math.round, height via Math.ceil at
        // the device layer). Sizing with the raw fractional measurement made the
        // container up to a cell too small, so fit() settled on (rows-1)/(cols-1)
        // for any font whose metrics aren't integral at the given size/dpr.
        // Reading the dummy's own dimensions uses the exact same rounding the
        // real terminal will apply; the charSizeService values remain a fallback
        // for the not-yet-measured window.
        charWidth = renderDimensions?.css?.cell?.width || charSizeService?.width || 0;
        charHeight = renderDimensions?.css?.cell?.height || charSizeService?.height || 0;
        dummyTerm.dispose();
        dummyDiv.remove();
        // Font metrics not yet available (document fonts still loading) —
        // applying a 0-cell size would shrink the window to its chrome. Defer.
        if (charWidth <= 0 || charHeight <= 0) return null;
        // Only cache real measurements — a 0 would poison every future
        // launch's sizing.
        storeCellMetrics(profile, {width: charWidth, height: charHeight});
    }

    // Chrome inset: window inner size minus the terminal mount element's
    // inner size. termRef lives inside the padded Term surface, so this
    // difference already carries the sidebar/title-bar chrome AND the profile
    // padding — adding the padding again (the old bug) inflated the window by
    // one padding per axis, which fit() converted into extra rows/cols.
    // Hidden window (no layout): use the last live-measured offset so the
    // size can be applied before show.
    let widthOffset: number;
    let heightOffset: number;
    if (laidOut) {
        widthOffset = Math.max(0, window.innerWidth - containerClientWidth);
        heightOffset = Math.max(0, window.innerHeight - containerClientHeight);
        storeChromeOffset(widthOffset, heightOffset);
    } else {
        const offset = cachedChromeOffset();
        if (!offset) return null;
        widthOffset = offset.dx;
        heightOffset = offset.dy;
    }
    // Ceil, never floor: the container must hold AT LEAST rows/cols cells —
    // fit() floors available/cell, so a sub-cell deficit costs a whole row or
    // column while a sub-cell surplus is absorbed as edge background.
    const pixelWidth = Math.ceil(
        (profile.cols ?? 80) * charWidth,
    ) + widthOffset;
    const pixelHeight = Math.ceil(
        (profile.rows ?? 24) * charHeight,
    ) + heightOffset;
    // Diagnostic: every input of the sizing decision on one line. Runs once
    // per session (not a hot path), and a wrong window size is otherwise
    // undiagnosable remotely — the raw cell metrics + offsets are what
    // discriminate font-fallback / scaling / layout-timing failures.
    info(
        `profileWindowSize: profile=${profile.name ?? "?"} ` +
        `font=${JSON.stringify(profile.fontFamily ?? "(default)")}/${profile.fontSize ?? "(default)"} ` +
        `cell=${charWidth}x${charHeight} dpr=${window.devicePixelRatio} cached=${cached ? "hit" : "miss"} ` +
        `offset=${widthOffset}x${heightOffset}${laidOut ? "" : "(cached)"} ` +
        `inner=${window.innerWidth}x${window.innerHeight} container=${containerClientWidth}x${containerClientHeight} ` +
        `cols/rows=${profile.cols ?? 80}/${profile.rows ?? 24} -> ${pixelWidth}x${pixelHeight}`,
    ).catch(() => {});
    return new LogicalSize({width: pixelWidth, height: pixelHeight});
}
