import assert from "node:assert/strict";
import test from "node:test";
import {TomlError} from "smol-toml";

import {parseConfigToml, renderConfigToml, semanticEqual, unwrapLegacyJson} from "../src/lib/configFormat.ts";

/** A representative GlobalConfig slice exercising every TOML shape the
 * config uses: array-of-tables (profiles), nested tables (render options),
 * string arrays (binding modifiers), records with hostile keys, floats,
 * booleans and unicode strings. */
const SAMPLE_CONFIG = {
    language: "en-us",
    showTabBar: false,
    edgeBackgroundCoverage: 0.9,
    themeMode: "terminal",
    globalProfile: {
        fontFamily: "JetBrains Mono",
        fontSize: 13,
        ligatures: true,
        padding: {top: 4, bottom: 4, left: 7, right: 7},
        xterm: {},
    },
    profiles: [
        {name: "zsh", default: true, exePath: "/bin/zsh"},
        {name: "ssh-box", ssh: {host: "example.com", port: 22, user: "妙"},
            keepAfterExit: "freeze", theme: {background: "#1e1e2e"}},
    ],
    bindings: [
        {key: "t", with: ["CtrlOrCommand"], action: "newTab"},
        {key: "1", with: ["CtrlOrCommand"], action: "toTab", args: {index: "0"}},
    ],
    profileLastOpened: {"Work.ssh": 1730000000000, "my profile": 42},
};

test("TOML from-scratch render round-trips the config shape", () => {
    const doc = renderConfigToml(undefined, SAMPLE_CONFIG);
    assert.deepEqual(parseConfigToml(doc), SAMPLE_CONFIG);
});

test("from-scratch render ends with a newline", () => {
    assert.ok(renderConfigToml(undefined, {a: 1}).endsWith("\n"));
});

test("render quotes hostile record keys", () => {
    const doc = renderConfigToml(undefined, {profileLastOpened: {"a.b c": 1}});
    assert.match(doc, /"a\.b c" = 1/);
    assert.deepEqual(parseConfigToml(doc), {profileLastOpened: {"a.b c": 1}});
});

test("render prunes undefined/null values (TOML cannot express them)", () => {
    const doc = renderConfigToml(undefined, {
        a: 1,
        b: undefined,
        c: null,
        d: {e: undefined, f: null, g: 2},
        h: [1, undefined, null, 2],
        i: [{j: null, k: 3}],
    });
    assert.deepEqual(parseConfigToml(doc), {a: 1, d: {g: 2}, h: [1, 2], i: [{k: 3}]});
});

test("parseConfigToml accepts comments and arbitrary formatting", () => {
    const doc = "# user comment\nlanguage = \"zh-cn\"  # trailing\n\n[globalProfile]\nfontSize = 12.5\n";
    assert.deepEqual(parseConfigToml(doc), {language: "zh-cn", globalProfile: {fontSize: 12.5}});
});

test("parseConfigToml throws on invalid TOML", () => {
    assert.throws(() => parseConfigToml("not toml at all [[["), TomlError);
});

test("patching preserves key order, spacing and comments", () => {
    const existing = [
        "# Lumina config — hand-written section",
        "# edgeBackgroundCoverage is a hidden setting (no GUI)",
        "edgeBackgroundCoverage = 0.9   # trailing note",
        "language = 'zh-cn'",
        "",
        "[globalProfile]",
        "fontSize = 13",
        "ligatures = true",
    ].join("\n") + "\n";
    const updated = {
        language: "zh-cn",
        autoProxy: true,                 // new key
        edgeBackgroundCoverage: 0.6,     // changed value
        globalProfile: {fontSize: 14, ligatures: true},
    };
    const out = renderConfigToml(existing, updated);
    // Comments survive, including on a line whose value changed.
    assert.ok(out.includes("# Lumina config — hand-written section"));
    assert.ok(out.includes("# edgeBackgroundCoverage is a hidden setting (no GUI)"));
    assert.ok(out.includes("# trailing note"));
    // Order survives: coverage stays before language, new key appended after.
    const coverage = out.indexOf("edgeBackgroundCoverage = 0.6");
    const language = out.indexOf("language =");
    const autoProxy = out.indexOf("autoProxy = true");
    assert.ok(coverage !== -1 && language !== -1 && coverage < language);
    assert.ok(autoProxy > language);
    // Changed values applied, nested table patched in place.
    assert.ok(out.includes("fontSize = 14"));
    assert.deepEqual(parseConfigToml(out), updated);
});

test("patching removes keys absent from the config", () => {
    const existing = "a = 1\n# comment about b\nb = 2\n";
    const out = renderConfigToml(existing, {a: 1});
    assert.deepEqual(parseConfigToml(out), {a: 1});
    assert.ok(!out.includes("b ="));
});

test("patching appends new profiles and removes deleted ones", () => {
    const existing = '[[profiles]]\nname = "a"\n\n[[profiles]]\nname = "b"\n';
    const appended = renderConfigToml(existing, {profiles: [{name: "a"}, {name: "b"}, {name: "c", default: true}]});
    assert.deepEqual(parseConfigToml(appended).profiles, [{name: "a"}, {name: "b"}, {name: "c", default: true}]);
    const removed = renderConfigToml(existing, {profiles: [{name: "a"}]});
    assert.deepEqual(parseConfigToml(removed).profiles, [{name: "a"}]);
});

test("render throws on a non-empty but unparseable existing document", () => {
    // The caller (writeConfigDocument) catches this and falls back to a
    // from-scratch render rather than losing the save.
    assert.throws(() => renderConfigToml("broken [[[", {a: 1}));
});

test("semanticEqual ignores object key order (file order vs state order)", () => {
    // The hot-reload guard depends on this: patch-based writes preserve the
    // file's hand-written key order while the in-memory state follows
    // DEFAULT_CONFIG's order.
    const fromFile = {language: "zh-cn", profiles: [{name: "a", fontSize: 14}], autoProxy: true};
    const fromState = {autoProxy: true, profiles: [{name: "a", fontSize: 14}], language: "zh-cn"};
    assert.ok(semanticEqual(fromFile, fromState));
});

test("semanticEqual detects real differences (nested, typed, array order)", () => {
    assert.ok(!semanticEqual({a: {b: 1}}, {a: {b: 2}}));
    assert.ok(!semanticEqual({a: 1}, {a: "1"}));
    assert.ok(!semanticEqual({a: [1, 2]}, {a: [2, 1]}));  // arrays are ordered
    assert.ok(!semanticEqual({a: 1}, {a: 1, b: 2}));
});

test("semanticEqual treats undefined fields as absent", () => {
    // Optional fields in state are commonly undefined; the parsed file omits
    // them entirely — those must compare equal.
    assert.ok(semanticEqual({a: 1, b: undefined}, {a: 1}));
    assert.ok(semanticEqual({a: {b: undefined, c: 2}}, {a: {c: 2}}));
});

test("semanticEqual round-trips through a TOML render+parse", () => {
    const config = {language: "en-us", globalProfile: {fontSize: 14, ligatures: true}, profiles: [{name: "zsh"}]};
    assert.ok(semanticEqual(config, parseConfigToml(renderConfigToml(undefined, config))));
});

test("unwrapLegacyJson unwraps the plugin-store {\"config\": {...}} wrapper", () => {
    const text = JSON.stringify({config: {language: "zh-cn", showTabBar: true}});
    assert.deepEqual(unwrapLegacyJson(text), {language: "zh-cn", showTabBar: true});
});

test("unwrapLegacyJson accepts a plain root object as-is", () => {
    const text = JSON.stringify({language: "en-us", profiles: [{name: "zsh"}]});
    assert.deepEqual(unwrapLegacyJson(text), {language: "en-us", profiles: [{name: "zsh"}]});
});

test("unwrapLegacyJson falls back to the root when `config` is not an object", () => {
    // A hand-written config whose only oddity is a stray non-object "config"
    // key must not be discarded — it reads like any other plain root.
    const text = JSON.stringify({language: "en-us", config: 42});
    assert.deepEqual(unwrapLegacyJson(text), {language: "en-us", config: 42});
});

test("unwrapLegacyJson rejects invalid JSON and non-object roots", () => {
    assert.throws(() => unwrapLegacyJson("{not json"), SyntaxError);
    assert.throws(() => unwrapLegacyJson("[1, 2]"));
    assert.throws(() => unwrapLegacyJson("42"));
    assert.throws(() => unwrapLegacyJson("null"));
});
