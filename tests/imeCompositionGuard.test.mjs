import assert from "node:assert/strict";
import test from "node:test";

import {installImeCompositionGuard} from "../src/lib/imeCompositionGuard.ts";

class FakeTextarea {
    #listeners = new Map();
    value = "";
    selectionStart = 0;
    selectionEnd = 0;

    setSelectionRange(start, end) {
        this.selectionStart = start;
        this.selectionEnd = end;
    }

    addEventListener(type, listener, options) {
        const listeners = this.#listeners.get(type) ?? [];
        listeners.push({listener, capture: options === true || options?.capture === true});
        this.#listeners.set(type, listeners);
    }

    removeEventListener(type, listener, options) {
        const capture = options === true || options?.capture === true;
        const listeners = this.#listeners.get(type) ?? [];
        this.#listeners.set(type, listeners.filter((entry) => (
            entry.listener !== listener || entry.capture !== capture
        )));
    }

    dispatch(type, init = {}) {
        let stopped = false;
        const event = {
            type,
            ...init,
            stopImmediatePropagation() {
                stopped = true;
            },
        };
        const listeners = this.#listeners.get(type) ?? [];
        for (const capture of [true, false]) {
            for (const entry of listeners) {
                if (entry.capture === capture && !stopped) entry.listener(event);
            }
        }
    }
}

test("blocks an unmatched compositionend after the IME 229-key fallback", () => {
    const textarea = new FakeTextarea();
    const dispose = installImeCompositionGuard(textarea);
    let xtermCompositionEnds = 0;
    textarea.addEventListener("compositionend", () => xtermCompositionEnds++);

    textarea.dispatch("keydown", {keyCode: 229});
    textarea.dispatch("compositionend");

    assert.equal(xtermCompositionEnds, 0);
    dispose();
});

test("allows compositionend when compositionstart was received", () => {
    const textarea = new FakeTextarea();
    const dispose = installImeCompositionGuard(textarea);
    let xtermCompositionEnds = 0;
    textarea.addEventListener("compositionend", () => xtermCompositionEnds++);

    textarea.dispatch("keydown", {keyCode: 229});
    textarea.dispatch("compositionstart");
    textarea.dispatch("compositionend");

    assert.equal(xtermCompositionEnds, 1);
    dispose();
});

test("allows compositionend when no 229-key fallback is pending", () => {
    const textarea = new FakeTextarea();
    const dispose = installImeCompositionGuard(textarea);
    let xtermCompositionEnds = 0;
    textarea.addEventListener("compositionend", () => xtermCompositionEnds++);

    textarea.dispatch("compositionend");

    assert.equal(xtermCompositionEnds, 1);
    dispose();
});

test("expires the 229-key fallback marker after the current event turn", async () => {
    const textarea = new FakeTextarea();
    const dispose = installImeCompositionGuard(textarea);
    let xtermCompositionEnds = 0;
    textarea.addEventListener("compositionend", () => xtermCompositionEnds++);

    textarea.dispatch("keydown", {keyCode: 229});
    await new Promise((resolve) => setTimeout(resolve, 0));
    textarea.dispatch("compositionend");

    assert.equal(xtermCompositionEnds, 1);
    dispose();
});

test("normalizes an unmatched IME input so xterm's fallback sends only the committed data", async () => {
    const textarea = new FakeTextarea();
    textarea.value = "existing";
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
    let xtermData = "";

    // Mirrors xterm's 229-key textarea fallback. It is registered before the
    // application guard, just like the listeners created by Terminal.open().
    textarea.addEventListener("keydown", (event) => {
        if (event.keyCode !== 229) return;
        const oldValue = textarea.value;
        setTimeout(() => {
            xtermData += textarea.value.replace(oldValue, "");
        }, 0);
    }, true);
    const dispose = installImeCompositionGuard(textarea);

    textarea.dispatch("keydown", {keyCode: 229});
    // WebKitGTK can rewrite earlier textarea content while committing, so the
    // old value is no longer a substring and xterm's replace returns all of it.
    textarea.value = "rewritten积累文本，";
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
    textarea.dispatch("input", {
        data: "，",
        inputType: "insertFromComposition",
        isComposing: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(xtermData, "，");
    assert.equal(textarea.value, "existing，");
    dispose();
});
