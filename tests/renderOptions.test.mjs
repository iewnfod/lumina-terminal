import assert from "node:assert/strict";
import test from "node:test";

import {
    RENDER_FIELDS,
    formatPaddingObject,
    formatRenderValue,
    inheritedRenderValue,
    initialOverrideValue,
    listRenderOverrides,
    optionLabelKey,
    parseNumberInput,
    renderField,
    withRenderValue,
} from "../src/lib/renderOptions.ts";
import enUs from "../translations/en-us.json" with {type: "json"};
import zhCn from "../translations/zh-cn.json" with {type: "json"};

const keysOf = (fields) => fields.map((field) => field.key);
const labels = {unset: "?", on: "yes", off: "no"};

test("the schema lists each field once, in display order", () => {
    const keys = keysOf(RENDER_FIELDS);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(keys, [
        "rows", "cols", "padding", "scrollback",
        "fontFamily", "fontSize", "fontWeight", "fontStyle",
        "cursorStyle", "cursorBlink",
        "themePath",
        "webgl", "graphemeClusters", "ligatures", "colorSpread",
    ]);
    // Font, then text inputs, then switches — the order both forms render in.
    assert.deepEqual(keysOf(RENDER_FIELDS.filter((field) => field.kind === "toggle")), [
        "cursorBlink", "webgl", "graphemeClusters", "ligatures", "colorSpread",
    ]);
    assert.equal(renderField("themePath").kind, "text");
    // Color spread moved over from the General page with its existing strings,
    // and keeps its old default (off).
    const colorSpread = renderField("colorSpread");
    assert.equal(colorSpread.labelKey, "Color Spread");
    assert.equal(colorSpread.descriptionKey, "Let fullscreen apps' background fill the whole window");
    assert.equal(colorSpread.fallback, false);
});

test("every schema translation key exists in both languages", () => {
    for (const field of RENDER_FIELDS) {
        for (const key of [field.labelKey, field.descriptionKey, ...Object.values(field.optionLabelKeys ?? {})]) {
            if (key === undefined) continue;
            assert.ok(key in enUs, `en-us is missing "${key}"`);
            assert.ok(key in zhCn, `zh-cn is missing "${key}"`);
        }
    }
    assert.deepEqual(Object.keys(enUs).sort(), Object.keys(zhCn).sort());
});

test("listRenderOverrides returns the set keys in schema order; undefined means inherit", () => {
    assert.deepEqual(
        keysOf(listRenderOverrides({webgl: false, fontSize: 12, cursorBlink: undefined})),
        ["fontSize", "webgl"],
    );
    // false and "" are VALUES — they override the global setting.
    assert.deepEqual(
        keysOf(listRenderOverrides({themePath: "", ligatures: false})),
        ["themePath", "ligatures"],
    );
    assert.deepEqual(listRenderOverrides(undefined), []);
    assert.deepEqual(listRenderOverrides({}), []);
    // xterm passthrough options outside the UI list are never rows.
    assert.deepEqual(listRenderOverrides({lineHeight: 1.2, theme: {background: "#000"}}), []);
});

test("inheritedRenderValue: the global value, else the built-in default, else nothing", () => {
    assert.equal(inheritedRenderValue("fontSize", {fontSize: 14}), 14);
    assert.equal(inheritedRenderValue("fontSize", {}), 15);
    assert.equal(inheritedRenderValue("fontSize"), 15);
    assert.equal(inheritedRenderValue("webgl", {}), false);
    assert.equal(inheritedRenderValue("webgl", {webgl: true}), true);
    assert.equal(inheritedRenderValue("cursorStyle"), "block");
    assert.equal(inheritedRenderValue("rows"), 24);
    assert.equal(inheritedRenderValue("cols"), 80);
    assert.equal(inheritedRenderValue("padding"), 0);
    assert.equal(inheritedRenderValue("fontFamily", {fontFamily: "Fira Code"}), "Fira Code");
    // No built-in default: unset stays unset.
    assert.equal(inheritedRenderValue("fontFamily"), undefined);
    assert.equal(inheritedRenderValue("themePath"), undefined);
    // A key present but undefined falls through like a missing one.
    assert.equal(inheritedRenderValue("scrollback", {scrollback: undefined}), 1000);
    assert.equal(inheritedRenderValue("colorSpread"), false);
    assert.equal(inheritedRenderValue("colorSpread", {colorSpread: true}), true);
});

test("initialOverrideValue seeds values and inverts toggles", () => {
    // Values start at what is in effect now — edit it into what you want.
    assert.equal(initialOverrideValue("fontSize", {fontSize: 14}), 14);
    assert.equal(initialOverrideValue("fontSize"), 15);
    assert.equal(initialOverrideValue("fontFamily", {fontFamily: "Fira Code"}), "Fira Code");
    assert.equal(initialOverrideValue("fontFamily"), "");
    assert.equal(initialOverrideValue("cursorStyle", {cursorStyle: "bar"}), "bar");
    // A global value outside the menu (hand-edited) seeds the menu default.
    assert.equal(initialOverrideValue("cursorStyle", {cursorStyle: "outline"}), "block");
    // Per-side global padding cannot seed a number input.
    assert.equal(initialOverrideValue("padding", {padding: {x: 12}}), 0);
    // A toggle starts at the opposite of the inherited state.
    assert.equal(initialOverrideValue("webgl"), true);
    assert.equal(initialOverrideValue("webgl", {webgl: true}), false);
    assert.equal(initialOverrideValue("colorSpread"), true);
    assert.equal(initialOverrideValue("colorSpread", {colorSpread: true}), false);
});

test("formatRenderValue", () => {
    assert.equal(formatRenderValue(undefined, labels), "?");
    assert.equal(formatRenderValue(true, labels), "yes");
    assert.equal(formatRenderValue(false, labels), "no");
    assert.equal(formatRenderValue(12, labels), "12");
    // Options localize through the callback; raw ids otherwise.
    assert.equal(formatRenderValue("bar", {...labels, option: (o) => `t(${o})`}), "t(bar)");
    assert.equal(formatRenderValue("bar", labels), "bar");
    assert.equal(formatRenderValue({x: 12, y: 8}, labels), "x: 12, y: 8");
});

test("formatPaddingObject lists only the sides that are set, in a fixed order", () => {
    assert.equal(formatPaddingObject({bottom: 3, top: 1, left: 4, right: 2}), "left: 4, right: 2, top: 1, bottom: 3");
    assert.equal(formatPaddingObject({y: 6}), "y: 6");
    assert.equal(formatPaddingObject({}), "");
});

test("parseNumberInput: empty is unset, values clamp to the minimum", () => {
    assert.equal(parseNumberInput("", 1), undefined);
    assert.equal(parseNumberInput("  ", 1), undefined);
    assert.equal(parseNumberInput("abc", 1), undefined);
    assert.equal(parseNumberInput("0", 1), 1);
    assert.equal(parseNumberInput("-4", 0), 0);
    assert.equal(parseNumberInput("80", 1), 80);
    assert.equal(parseNumberInput("2.5", 1), 2.5);
});

test("withRenderValue sets a field and removes an override without touching the rest", () => {
    const profile = {name: "zsh", fontSize: 12, lineHeight: 1.2};
    const updated = withRenderValue(profile, "webgl", true);
    assert.deepEqual(updated, {name: "zsh", fontSize: 12, lineHeight: 1.2, webgl: true});
    assert.deepEqual(profile, {name: "zsh", fontSize: 12, lineHeight: 1.2}, "the source is not mutated");

    const cleared = withRenderValue(updated, "fontSize", undefined);
    assert.equal(cleared.fontSize, undefined);
    assert.equal(cleared.lineHeight, 1.2);
    // A removed override reads as inherited everywhere downstream.
    assert.deepEqual(keysOf(listRenderOverrides(cleared)), ["webgl"]);
});

test("optionLabelKey resolves only for menu options that have a translation", () => {
    assert.equal(optionLabelKey(renderField("cursorStyle"), "bar"), "cursor_bar");
    assert.equal(optionLabelKey(renderField("fontStyle"), "italic"), "Italic");
    // Font weights are their own labels.
    assert.equal(optionLabelKey(renderField("fontWeight"), "300"), null);
    assert.equal(optionLabelKey(renderField("webgl"), "x"), null);
});
