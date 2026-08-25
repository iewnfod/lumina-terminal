import type {Terminal} from "@xterm/xterm";

/**
 * A color must cover at least this share of the sampled edge cells to count as
 * the background. Cells with other colors are treated as characters that
 * happen to touch the edge, not as evidence against the background.
 */
const DEFAULT_COVERAGE_THRESHOLD = 0.9;

/** A custom threshold is only honored inside (0,1]; anything else (or no
 *  value) falls back to the default. `1` restores strict uniformity. */
const sanitizeThreshold = (value: number | undefined): number => {
    if (value === undefined) return DEFAULT_COVERAGE_THRESHOLD;
    if (!Number.isFinite(value) || value <= 0 || value > 1) return DEFAULT_COVERAGE_THRESHOLD;
    return value;
};

/**
 * Inspect the outermost ring of the visible terminal buffer and, when one
 * background color dominates the edge, return that color so it can be painted
 * into the padding/margin area around the canvas. This lets a fullscreen TUI
 * (vim, htop, lazygit, ...) that sets its own background bleed seamlessly to
 * the terminal edges instead of revealing a theme.background border.
 *
 * The dominant color must cover at least `coverageThreshold` (default 0.9) of
 * the sampled cells — stragglers (a differently-colored statusline segment,
 * characters touching the edge, ...) are tolerated instead of aborting the
 * sample.
 *
 * Returns `null` (=> no override) when:
 *  - the terminal/core is not ready,
 *  - no single color covers enough of the edge cells,
 *  - the dominant color's support is entirely default-background cells (no
 *    TUI changed the edge) — the surrounding theme.background already
 *    matches, so overriding it would be a no-op and we keep things
 *    transparent. Whether a cell is default is decided per cell, NOT by
 *    comparing against the live theme bg (which Term's apply() rewrites to
 *    the sampled color — a string compare would oscillate).
 */
export function sampleEdgeBackground(
    term: Terminal,
    coverageThreshold?: number,
): string | null {
    const threshold = sanitizeThreshold(coverageThreshold);
    const buffer = term.buffer.active;
    const cols = term.cols;
    const rows = term.rows;
    if (cols < 2 || rows < 2) return null;

    // v6 moved the palette from `_colorManager` to `_themeService`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const core = (term as any)._core;
    const colors = core?._themeService?.colors;
    if (!colors) return null;

    const top = buffer.baseY;
    const reusableCell = buffer.getNullCell();

    const counts = new Map<string, number>();
    let total = 0;
    let defaultCount = 0;

    // Resolve a single cell's background to a CSS string and tally it.
    // Width-0 continuation cells (part of a wide char) are skipped rather than
    // counted, so they neither break the coverage nor dilute it.
    const tally = (row: number, col: number): void => {
        const line = buffer.getLine(top + row);
        if (!line) return;
        const cell = line.getCell(col, reusableCell);
        if (!cell) return;
        if (cell.getWidth() === 0) return; // wide-char tail, skip
        let css: string;
        if (cell.isBgDefault()) {
            css = colors.background.css;
            defaultCount++;
        } else if (cell.isBgRGB()) {
            const v = cell.getBgColor();
            css = "#" + (v >>> 0).toString(16).padStart(6, "0");
        } else if (cell.isBgPalette()) {
            const idx = cell.getBgColor();
            css = colors.ansi?.[idx]?.css ?? colors.background.css;
        } else {
            css = colors.background.css;
        }
        counts.set(css, (counts.get(css) ?? 0) + 1);
        total++;
    };

    // Top + bottom rows (all columns).
    for (let c = 0; c < cols; c++) {
        tally(0, c);
        tally(rows - 1, c);
    }
    // Left + right columns (inner rows only — corners already covered above).
    for (let r = 1; r < rows - 1; r++) {
        tally(r, 0);
        tally(r, cols - 1);
    }

    if (total === 0) return null;

    let dominant: string | null = null;
    let dominantCount = 0;
    for (const [css, n] of counts) {
        if (n > dominantCount) {
            dominant = css;
            dominantCount = n;
        }
    }

    // No color clearly owns the edge — treat it as no fullscreen TUI.
    if (dominantCount / total < threshold) return null;

    // The override is a no-op (keep the padding transparent) only when the
    // dominant color's support is ENTIRELY default-bg cells, i.e. nothing at
    // the edge actually sets its own background. Comparing against
    // colors.background.css alone is wrong here: apply() rewrites
    // theme.background to the sampled color, so on the NEXT tick the live
    // theme bg equals the TUI color and a string compare would flip the
    // result back to null — color/null/color flicker at the poll rate.
    // Explicit cells that happen to carry the theme-bg color still count as
    // support: re-applying it is a stable no-op in Term's apply().
    const dominantDefaultShare = dominant === colors.background.css ? defaultCount : 0;
    if (dominantCount - dominantDefaultShare <= 0) return null;
    return dominant;
}
