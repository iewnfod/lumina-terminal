import {adjustColor, isColorDark} from "./color.ts";

/**
 * Glass material helpers. Pure (no React) — given a background hex and a
 * capability flag, return the inline-style object a chrome surface should
 * wear. This is the single place that knows about `backdrop-filter` prefixes
 * and the Wayland/WebKitGTK fallback, so components just call {@link
 * glassSurface} and stay declarative.
 *
 * Capability (`supportsGlass`) comes from `hooks/useGlass.ts`, which probes
 * platform/Wayland once and caches. When false, we degrade to an opaque
 * surface derived via {@link adjustColor} (single source of truth for color
 * math, §3.2) so the chrome still reads correctly against the terminal bg.
 */

export interface GlassStyle {
    /** CSS `background` value (a color, or a translucent layer). */
    background: string;
    /** Standard `backdrop-filter` (omitted entirely when unsupported). */
    backdropFilter?: string;
    /** WebKit-prefixed `backdrop-filter`. */
    WebkitBackdropFilter?: string;
}

export interface GlassSurfaceOptions {
    /**
     * Blur radius in px. Defaults to the `--glass-blur` token via
     * {@link defaultBlurPx}. Pass 0 for a flat translucent layer (no blur).
     */
    blurPx?: number;
    /**
     * Saturation boost applied alongside blur. Omitted when `supportsGlass`
     * is false. Defaults to `--glass-saturate`.
     */
    saturate?: number;
    /**
     * Translucent tint layered over the blur, expressed as an alpha overlay
     * (e.g. `rgba(255,255,255,0.06)`). When omitted, a default is derived
     * from whether `bg` is dark or light.
     */
    tint?: string;
    /**
     * Opaque fallback tint strength. When `supportsGlass` is false we fall
     * back to `adjustColor(bg, ±strength)` (sign follows luminance).
     * Defaults to 8.
     */
    fallbackStrength?: number;
    /**
     * When true, the surface's background color has "spread" from a fullscreen
     * TUI (edge background). In that case we must NOT layer any tint or color
     * adjustment on top — the TUI's color should pass through chrome exactly,
     * so the window reads as one continuous field. We keep the blur+saturate
     * (the frosted feel) but drop the tint, and on the opaque fallback we use
     * the bg verbatim instead of adjustColor(bg, ±8).
     */
    spread?: boolean;
}

/** Default blur radius pulled from the `--glass-blur` design token. */
export function defaultBlurPx(): number {
    const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--glass-blur")
        .trim();
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
}

/** Default saturation pulled from the `--glass-saturate` design token. */
export function defaultSaturate(): number {
    const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--glass-saturate")
        .trim();
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1.6;
}

/**
 * Build the inline style for a glass surface.
 *
 * @param bg the effective background hex the surface floats over (from
 *   `useSurfaceColors`/`useEffectiveTheme`).
 * @param supportsGlass platform capability (from `useGlass()`). When false the
 *   result is fully opaque and blur-free.
 * @param opts optional tuning.
 */
export function glassSurface(
    bg: string,
    supportsGlass: boolean,
    opts?: GlassSurfaceOptions,
): GlassStyle {
    // Derive light/dark from the bg's real luminance — see useSurfaceColors
    // for why surface colors must not follow the theme mode.
    const dark = isColorDark(bg);
    const blurPx = opts?.blurPx ?? defaultBlurPx();
    const saturate = opts?.saturate ?? defaultSaturate();

    if (!supportsGlass || blurPx <= 0) {
        // Opaque fallback. Normally nudge the bg by a small amount so the
        // surface is distinguishable from the terminal canvas; but when the
        // background has spread from a fullscreen TUI, use the bg verbatim so
        // the chrome matches the TUI exactly.
        if (opts?.spread) {
            return {background: bg};
        }
        const strength = opts?.fallbackStrength ?? 8;
        return {
            background: adjustColor(bg, dark ? strength : -strength),
        };
    }

    // Glass path. When the bg has spread, drop the tint entirely (keep blur +
    // saturate) so the TUI's color passes through uncolored.
    const tint = opts?.spread
        ? "transparent"
        : (opts?.tint ?? (dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)"));
    const filter = `blur(${blurPx}px) saturate(${saturate})`;
    return {
        background: tint,
        backdropFilter: filter,
        WebkitBackdropFilter: filter,
    };
}

/**
 * A thin hairline border that reads on both light and dark bgs, derived from
 * the bg the surface overlays. Kept here so glass surfaces and their borders
 * stay in sync.
 *
 * @param darkOverride forces the light/dark decision (theme mode); omit to
 *   derive from `bg`.
 */
export function glassBorder(bg: string): string {
    const dark = isColorDark(bg);
    return dark
        ? "rgba(255,255,255,0.12)"
        : "rgba(0,0,0,0.10)";
}

/**
 * A 1px window outline for Linux, where some desktop environments draw no
 * compositor shadow — without it a dark window on a dark wallpaper has no
 * visible edge. Like {@link glassBorder} it derives from the surface bg so it
 * reads on both light and dark windows, but with more contrast since it
 * competes with the desktop behind the window, not a known chrome bg.
 */
export function windowOutline(bg: string): string {
    const dark = isColorDark(bg);
    return dark
        ? "rgba(255,255,255,0.22)"
        : "rgba(0,0,0,0.18)";
}

/**
 * Soft elevation shadow. Pure black at low alpha so it works on any bg; the
 * blur gives the "floating" feel without a heavy drop shadow.
 */
export function elevationShadow(strength: "sm" | "md" | "lg" = "sm"): string {
    const alphas = {sm: 0.08, md: 0.16, lg: 0.28} as const;
    const blurs = {sm: 8, md: 16, lg: 32} as const;
    const a = alphas[strength];
    const b = blurs[strength];
    return `0 ${Math.round(b / 4)}px ${b}px rgba(0,0,0,${a})`;
}
