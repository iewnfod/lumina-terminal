/**
 * CSS color parsing: pure parsers for the forms that matter (hex 3/4/6/8-digit
 * and `rgb()/rgba()` — xterm always emits hex, user themes use either), plus a
 * CSSOM fallback for everything else (named colors, `hsl()`, `color(…)`) that
 * only runs where `document` exists — assigning to a scratch element's
 * `style.color` makes the browser normalize the value to `rgb(r, g, b)` /
 * `rgba(r, g, b, a)`, while an invalid value leaves it empty.
 *
 * The pure-first ordering keeps the module loadable by `node --test`
 * (lib/edgeBackground.ts imports it). The previous hand-rolled parser turned
 * `rgb(36,41,47)` into NaN (classified as light) and `white`/`#fff` into
 * "dark" — both wrong enough to invert the chrome's foreground.
 */
const HEX3_RE = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i;
const HEX6_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/i;
const RGB_FN_RE = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/;
const RGB_NORM_RE = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/;
let scratchEl: HTMLDivElement | undefined;

function parseColor(input: string): {r: number; g: number; b: number} | null {
    const s = input.trim();
    let m = HEX3_RE.exec(s);
    if (m) {
        return {
            r: parseInt(m[1] + m[1], 16),
            g: parseInt(m[2] + m[2], 16),
            b: parseInt(m[3] + m[3], 16),
        };
    }
    m = HEX6_RE.exec(s);
    if (m) {
        return {r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16)};
    }
    m = RGB_FN_RE.exec(s);
    if (m) {
        return {r: Number(m[1]), g: Number(m[2]), b: Number(m[3])};
    }
    if (typeof document !== "undefined") {
        scratchEl ??= document.createElement("div");
        scratchEl.style.color = "";
        scratchEl.style.color = s;
        const norm = RGB_NORM_RE.exec(scratchEl.style.color);
        if (norm) {
            return {r: Number(norm[1]), g: Number(norm[2]), b: Number(norm[3])};
        }
    }
    return null;
}

export function isColorDark(color: string): boolean {
    const rgb = parseColor(color);
    // Unparseable → assume dark so chrome text defaults to white (readable
    // against the unknown-but-usually-dark terminal backgrounds).
    if (!rgb) return true;
    const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return luminance < 0.5;
}

/**
 * A readable foreground color for the given background: white on dark, black on
 * light. Used so chrome text (tab titles, title bar, settings) follows the
 * effective background even when a fullscreen TUI overrides it.
 */
export function foregroundFor(bg: string): string {
    return isColorDark(bg) ? "#ffffff" : "#000000";
}

export function adjustColor(color: string, amount: number): string {
    // Unparseable → clamp from black instead of emitting rgb(NaN, …), which
    // the browser would silently drop (vanishing borders/backgrounds).
    const rgb = parseColor(color) ?? {r: 0, g: 0, b: 0};
    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v + amount)));
    return `rgb(${clamp(rgb.r)}, ${clamp(rgb.g)}, ${clamp(rgb.b)})`;
}

/**
 * Pick a red that stays visible against the effective background, for danger
 * indicators (e.g. the privileged-command dot). Prefers the theme's ANSI reds
 * so the indicator follows the user's color scheme; on a light background the
 * normal red can be too pale, so brightRed is preferred there. Falls back to a
 * sensible default if the theme defines neither.
 */
export function visibleRed(
    red: string | undefined,
    brightRed: string | undefined,
    bg: string | undefined,
): string {
    const fallback = "#ef4444";
    const dark = bg ? isColorDark(bg) : true;
    if (dark) {
        // Dark background: the standard red reads well.
        return red ?? brightRed ?? fallback;
    }
    // Light background: brightRed is usually more saturated/visible.
    return brightRed ?? red ?? fallback;
}
