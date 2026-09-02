import assert from "node:assert/strict";
import test from "node:test";

import {reResolveByName} from "../src/lib/profileSync.ts";

const resolveDouble = async (source) => ({...source, fontSize: (source.fontSize ?? 12) * 2});

test("re-resolves matched entries by name and reports the change", async () => {
    const entries = {tab1: {name: "zsh", fontSize: 12}, tab2: {name: "fish", fontSize: 12}};
    const sources = [{name: "zsh", fontSize: 12}, {name: "fish", fontSize: 12}];
    const next = await reResolveByName(entries, sources, resolveDouble);
    assert.deepEqual(next, {tab1: {name: "zsh", fontSize: 24}, tab2: {name: "fish", fontSize: 24}});
});

test("keeps snapshots whose profile disappeared (editing must not kill tabs)", async () => {
    const entries = {tab1: {name: "deleted-profile", fontSize: 12}};
    const next = await reResolveByName(entries, [], resolveDouble);
    // Unchanged entries keep the SAME object; the map is still returned
    // because the other entry changed in this scenario — here nothing else
    // exists, so the whole pass is a no-op (null).
    assert.equal(next, null);
});

test("mixed: surviving profile re-resolves, vanished one keeps its snapshot", async () => {
    const entries = {
        tab1: {name: "zsh", fontSize: 12},
        tab2: {name: "gone", fontSize: 30},
    };
    const next = await reResolveByName(entries, [{name: "zsh", fontSize: 12}], resolveDouble);
    assert.deepEqual(next.tab1, {name: "zsh", fontSize: 24});
    assert.equal(next.tab2, entries.tab2);
});

test("returns null (same ref semantics) when nothing changed", async () => {
    const entries = {tab1: {name: "zsh", fontSize: 12}};
    const identity = async (source) => ({...source});
    assert.equal(await reResolveByName(entries, [{name: "zsh", fontSize: 12}], identity), null);
});

test("empty entry map is a no-op without calling resolve", async () => {
    let calls = 0;
    const next = await reResolveByName({}, [{name: "zsh"}], async (s) => {
        calls++;
        return s;
    });
    assert.equal(next, null);
    assert.equal(calls, 0);
});

test("a renamed profile counts as vanished — match is exact, not fuzzy", async () => {
    const entries = {tab1: {name: "zsh", fontSize: 12}};
    const next = await reResolveByName(entries, [{name: "zsh2", fontSize: 12}], resolveDouble);
    assert.equal(next, null);
});
