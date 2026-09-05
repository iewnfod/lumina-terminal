import assert from "node:assert/strict";
import test from "node:test";

import {isDragRegionDoubleClick} from "../src/lib/dragRegionDoubleClick.ts";

/** Minimal stand-in for a DOM element: only `getAttribute` is needed (the
 *  predicate duck-types the target so it stays node --test loadable). */
function el(attrValue) {
    return {
        getAttribute: (name) =>
            name === "data-tauri-drag-region" ? attrValue : null,
    };
}

/** A mousedown shaped event with the given overrides. */
function mousedown({button = 0, detail = 2, target = el("")} = {}) {
    return {button, detail, target};
}

test("second left click directly on a bare drag region qualifies", () => {
    assert.equal(isDragRegionDoubleClick(mousedown({target: el("")})), true);
});

test('explicit data-tauri-drag-region="true" qualifies too', () => {
    assert.equal(isDragRegionDoubleClick(mousedown({target: el("true")})), true);
});

test("first click (detail 1) and later clicks (detail 3+) do not qualify", () => {
    assert.equal(isDragRegionDoubleClick(mousedown({detail: 1})), false);
    assert.equal(isDragRegionDoubleClick(mousedown({detail: 3})), false);
});

test("non-left mouse buttons never qualify", () => {
    assert.equal(isDragRegionDoubleClick(mousedown({button: 1})), false);
    assert.equal(isDragRegionDoubleClick(mousedown({button: 2})), false);
});

test('data-tauri-drag-region="false" is an explicit opt-out', () => {
    assert.equal(isDragRegionDoubleClick(mousedown({target: el("false")})), false);
});

test("elements without the attribute never qualify (buttons, plain children)", () => {
    assert.equal(isDragRegionDoubleClick(mousedown({target: el(null)})), false);
});

test("non-element targets (document, window) never throw and never qualify", () => {
    assert.equal(isDragRegionDoubleClick(mousedown({target: null})), false);
    assert.equal(
        isDragRegionDoubleClick(mousedown({target: {noGetMethod: true}})),
        false,
    );
});
