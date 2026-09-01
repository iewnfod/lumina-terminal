import {Terminal} from "@xterm/xterm";
import {LogicalSize} from "@tauri-apps/api/window";
import {info} from "@tauri-apps/plugin-log";
import {TerminalProfile} from "../types/terminal.ts";

/**
 * Compute the OS window size (logical px) needed to display a profile's
 * configured rows/cols exactly, accounting for chrome insets and the
 * terminal's own padding.
 *
 * Spawns an off-screen xterm to measure the actual per-cell dimensions of the
 * profile's font, since xterm renders glyphs at a size that depends on the
 * font family/size/style and isn't computable from CSS metrics alone. The
 * measurement terminal is disposed before returning.
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
): LogicalSize {
    // Off-screen measurement terminal. Must match the profile's font options so
    // the measured cell size reflects what the real terminal will render.
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
    const charWidth = renderDimensions?.css?.cell?.width || charSizeService?.width || 0;
    const charHeight = renderDimensions?.css?.cell?.height || charSizeService?.height || 0;
    dummyTerm.dispose();
    dummyDiv.remove();

    // Chrome inset: window inner size minus the terminal mount element's
    // inner size. termRef lives inside the padded Term surface, so this
    // difference already carries the sidebar/title-bar chrome AND the profile
    // padding — adding the padding again (the old bug) inflated the window by
    // one padding per axis, which fit() converted into extra rows/cols.
    // Measured against the live container so a 0-size container (not yet
    // mounted) falls back to 0.
    const widthOffset = Math.max(0, window.innerWidth - containerClientWidth);
    const heightOffset = Math.max(0, window.innerHeight - containerClientHeight);
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
        `cell=${charWidth}x${charHeight} dpr=${window.devicePixelRatio} ` +
        `inner=${window.innerWidth}x${window.innerHeight} container=${containerClientWidth}x${containerClientHeight} ` +
        `offset=${widthOffset}x${heightOffset} ` +
        `cols/rows=${profile.cols ?? 80}/${profile.rows ?? 24} -> ${pixelWidth}x${pixelHeight}`,
    ).catch(() => {});
    return new LogicalSize({width: pixelWidth, height: pixelHeight});
}
