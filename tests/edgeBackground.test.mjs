import assert from "node:assert/strict";
import test from "node:test";

import {sampleEdgeBackground} from "../src/lib/edgeBackground.ts";

const DEFAULT_BG = "#1e1e2e";

function makeCell({width = 1, bg = "default", value = 0} = {}) {
    return {
        getWidth: () => width,
        isBgDefault: () => bg === "default",
        isBgRGB: () => bg === "rgb",
        isBgPalette: () => bg === "palette",
        getBgColor: () => value,
    };
}

/**
 * Build a mock Terminal around a grid of cell specs ({bg, value, width};
 * null entries are missing lines/cells). Rows and cols are inferred from
 * the grid — only the outermost ring is ever read. `backgroundCss` is the
 * LIVE theme background, so tests can simulate the tick AFTER Term's
 * apply() rewrote theme.background to the sampled TUI color.
 */
function makeTerm(cells, backgroundCss = DEFAULT_BG) {
    const nullCell = makeCell();
    return {
        cols: cells[0].length,
        rows: cells.length,
        buffer: {
            active: {
                baseY: 0,
                getNullCell: () => nullCell,
                getLine: (y) => cells[y] == null ? undefined : {
                    getCell: (x) => cells[y][x] == null ? null : makeCell(cells[y][x]),
                },
            },
        },
        _core: {
            _themeService: {
                colors: {
                    background: {css: backgroundCss},
                    ansi: Array.from({length: 16}, (_, i) => ({css: `#ansi-${i}`})),
                },
            },
        },
    };
}

/** rows×cols grid filled with one spec, with `[row, col, spec]` overrides. */
function grid(rows, cols, fill, overrides = []) {
    const g = Array.from({length: rows}, () => Array.from({length: cols}, () => ({...fill})));
    for (const [r, c, spec] of overrides) g[r][c] = {...spec};
    return g;
}

test("returns the uniform explicit RGB edge color", () => {
    assert.equal(sampleEdgeBackground(makeTerm(grid(6, 10, {bg: "rgb", value: 0x282c34}))), "#282c34");
});

test("pads small RGB values to six hex digits", () => {
    assert.equal(sampleEdgeBackground(makeTerm(grid(6, 10, {bg: "rgb", value: 0x0000ff}))), "#0000ff");
});

test("resolves palette backgrounds through the ANSI table", () => {
    assert.equal(sampleEdgeBackground(makeTerm(grid(6, 10, {bg: "palette", value: 4}))), "#ansi-4");
});

test("returns null when the edge is entirely default background", () => {
    assert.equal(sampleEdgeBackground(makeTerm(grid(6, 10, {bg: "default"}))), null);
});

test("keeps the dominant color when stragglers stay under 10%", () => {
    // 10×10 edge ring = 36 cells; 3 default stragglers => 33/36 ≈ 92%.
    const cells = grid(10, 10, {bg: "rgb", value: 0x282c34}, [
        [0, 0, {bg: "default"}],
        [0, 1, {bg: "default"}],
        [0, 2, {bg: "default"}],
    ]);
    assert.equal(sampleEdgeBackground(makeTerm(cells)), "#282c34");
});

test("returns null when coverage falls below 90%", () => {
    // 4 stragglers => 32/36 ≈ 88.9% — no color owns the edge.
    const cells = grid(10, 10, {bg: "rgb", value: 0x282c34}, [
        [0, 0, {bg: "default"}],
        [0, 1, {bg: "default"}],
        [0, 2, {bg: "default"}],
        [0, 3, {bg: "default"}],
    ]);
    assert.equal(sampleEdgeBackground(makeTerm(cells)), null);
});

/** The 36-cell ring of a 10×10 grid with `stragglers` default-bg cells. */
function ringWithStragglers(stragglers) {
    return grid(10, 10, {bg: "rgb", value: 0x282c34}, Array.from({length: stragglers}, (_, i) => [0, i, {bg: "default"}]));
}

test("coverageThreshold 1 restores strict all-cells-uniform behavior", () => {
    // 33/36 ≈ 92% passes the 0.9 default but fails strict uniformity.
    assert.equal(sampleEdgeBackground(makeTerm(ringWithStragglers(3)), 1), null);
    assert.equal(sampleEdgeBackground(makeTerm(ringWithStragglers(0)), 1), "#282c34");
});

test("coverageThreshold can be lowered to tolerate more stragglers", () => {
    // 27/36 = 75% — passes a 0.7 threshold, fails the 0.9 default.
    const term = makeTerm(ringWithStragglers(9));
    assert.equal(sampleEdgeBackground(term, 0.7), "#282c34");
    assert.equal(sampleEdgeBackground(term), null);
});

test("out-of-range coverageThreshold values fall back to the 0.9 default", () => {
    // 32/36 ≈ 88.9% fails the default; a bogus threshold must not loosen it.
    const term = makeTerm(ringWithStragglers(4));
    assert.equal(sampleEdgeBackground(term, 0), null);
    assert.equal(sampleEdgeBackground(term, 1.5), null);
    assert.equal(sampleEdgeBackground(term, Number.NaN), null);
    // 33/36 ≈ 92% passes the default — bogus values must not tighten it either.
    const lenient = makeTerm(ringWithStragglers(3));
    assert.equal(sampleEdgeBackground(lenient, 0), "#282c34");
    assert.equal(sampleEdgeBackground(lenient, Number.NaN), "#282c34");
});

test("returns null when the dominant color is the default background", () => {
    // 92% default + 3 red cells: overriding with the theme bg would be a no-op.
    const cells = grid(10, 10, {bg: "default"}, [
        [0, 0, {bg: "rgb", value: 0xff0000}],
        [0, 1, {bg: "rgb", value: 0xff0000}],
        [0, 2, {bg: "rgb", value: 0xff0000}],
    ]);
    assert.equal(sampleEdgeBackground(makeTerm(cells)), null);
});

test("returns null when the edge mixes two colors evenly", () => {
    // Repaint the top row + left column (18 of the 36 ring cells) red.
    const cells = grid(10, 10, {bg: "rgb", value: 0x282c34});
    for (let c = 0; c < 10; c++) cells[0][c] = {bg: "rgb", value: 0xff0000};
    for (let r = 1; r < 9; r++) cells[r][0] = {bg: "rgb", value: 0xff0000};
    assert.equal(sampleEdgeBackground(makeTerm(cells)), null);
});

test("skips wide-char continuation cells instead of counting them", () => {
    // Counted, the four red tails would drop coverage to 24/28 ≈ 86%.
    const cells = grid(6, 10, {bg: "rgb", value: 0x282c34}, [
        [0, 0, {bg: "rgb", value: 0xff0000, width: 0}],
        [0, 1, {bg: "rgb", value: 0xff0000, width: 0}],
        [5, 0, {bg: "rgb", value: 0xff0000, width: 0}],
        [5, 1, {bg: "rgb", value: 0xff0000, width: 0}],
    ]);
    assert.equal(sampleEdgeBackground(makeTerm(cells)), "#282c34");
});

test("skips missing lines and cells", () => {
    const cells = grid(6, 10, {bg: "rgb", value: 0x282c34});
    cells[5] = null;      // bottom row missing — 18 ring cells remain
    cells[0][9] = null;   // top-right cell missing — 17
    assert.equal(sampleEdgeBackground(makeTerm(cells)), "#282c34");
});

test("returns null for degenerate terminal sizes", () => {
    assert.equal(sampleEdgeBackground(makeTerm(grid(1, 10, {bg: "rgb", value: 0x282c34}))), null);
});

test("returns null when the theme service is unavailable", () => {
    const term = {
        cols: 10,
        rows: 6,
        buffer: {active: {baseY: 0, getNullCell: () => ({}), getLine: () => undefined}},
        _core: {},
    };
    assert.equal(sampleEdgeBackground(term), null);
});

test("keeps the TUI color when the theme bg already equals it (post-apply tick)", () => {
    // Regression: apply() rewrites theme.background to the sampled color, so
    // the NEXT tick sees colors.background.css === TUI color. A string
    // compare against the live theme bg would flip to null here and the tick
    // after would flip back — color/null flicker at the 200ms poll rate.
    const term = makeTerm(grid(6, 10, {bg: "rgb", value: 0x282c34}), "#282c34");
    assert.equal(sampleEdgeBackground(term), "#282c34");
});

test("keeps the TUI color post-apply even when default cells merge into it", () => {
    // Post-apply, default cells resolve to the applied color and join its
    // bucket. They must not make the dominant look "all default".
    const cells = grid(6, 10, {bg: "rgb", value: 0x282c34}, [
        [0, 0, {bg: "default"}],
        [0, 1, {bg: "default"}],
        [5, 0, {bg: "default"}],
        [5, 1, {bg: "default"}],
    ]);
    assert.equal(sampleEdgeBackground(makeTerm(cells, "#282c34")), "#282c34");
});

test("restores null after the TUI exits and the theme bg is still the TUI color", () => {
    // All cells back to default while theme.background still holds the
    // applied TUI color: dominant support is entirely default cells → null,
    // so apply() restores the original theme.
    const term = makeTerm(grid(6, 10, {bg: "default"}), "#282c34");
    assert.equal(sampleEdgeBackground(term), null);
});

test("returns null when a lenient threshold is met by default cells alone", () => {
    // 20 default + 16 red on the 36-cell ring: default wins at 55% but has
    // no explicit support — no TUI owns the edge, keep the padding as-is.
    const overrides = [];
    for (let c = 0; c < 10; c++) overrides.push([0, c, {bg: "rgb", value: 0xff0000}]);
    for (let r = 1; r <= 6; r++) overrides.push([r, 0, {bg: "rgb", value: 0xff0000}]);
    assert.equal(sampleEdgeBackground(makeTerm(grid(10, 10, {bg: "default"}, overrides)), 0.5), null);
});
