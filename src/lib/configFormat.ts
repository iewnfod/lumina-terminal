import {parse, stringify} from "smol-toml";
import {patch} from "@decimalturn/toml-patch";

/**
 * Config-file format handling — the pure (no React, no Tauri) parse /
 * serialize layer between the on-disk user config and GlobalConfig.
 *
 * The default config document is TOML (`config.toml`, the root table IS the
 * config — no wrapper key). The legacy `config.json` stays readable for
 * migration (see {@link unwrapLegacyJson}); lib/configFile.ts orchestrates
 * the read / migrate / write flow on top of these.
 *
 * Deliberately free of internal imports so `node --test` can load it
 * directly — types/config.ts pulls in the React/i18n graph.
 */

/** Parse a TOML config document. Throws on invalid TOML (TomlError); the
 *  caller decides how to degrade. Returns the root table as parsed —
 *  merging/validation against DEFAULT_CONFIG happens upstream. */
export function parseConfigToml(text: string): Record<string, unknown> {
    return parse(text) as Record<string, unknown>;
}

/** Parse a legacy JSON config, accepting both shapes ever written:
 *  - the pre-TOML plugin-store wrapper `{"config": {...}}` — unwrapped;
 *  - a plain root object — used as-is.
 *  Throws on invalid JSON or a non-object root; the caller degrades. */
export function unwrapLegacyJson(text: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("legacy config.json root is not an object");
    }
    const root = parsed as Record<string, unknown>;
    const wrapped = root["config"];
    if (wrapped !== null && typeof wrapped === "object" && !Array.isArray(wrapped)) {
        return wrapped as Record<string, unknown>;
    }
    return root;
}

/** Drop `undefined`/`null` values recursively (table values AND array
 *  entries). TOML cannot express either: smol-toml silently skips nullish
 *  table values but THROWS on nullish array entries, and GlobalConfig's
 *  many optional fields are commonly undefined — prune the whole shape so
 *  stringify can never blow up on one. */
function pruneNullish(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.filter((entry) => entry != null).map(pruneNullish);
    }
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry != null) out[key] = pruneNullish(entry);
        }
        return out;
    }
    return value;
}

/** Canonical JSON with object keys sorted recursively (arrays keep their
 *  order — it is semantic). `undefined` properties are skipped so an
 *  optional field present-as-undefined equals an absent one. */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

/** Deep equality that ignores OBJECT key order. The hot-reload watcher
 *  compares the file's parsed config against the in-memory state: the file
 *  preserves the user's hand-written key order (patch-based writes) while
 *  the state follows DEFAULT_CONFIG's order, so an order-sensitive compare
 *  would false-positive and trigger pointless setConfig churn — which
 *  re-seeds every settings draft and wipes unsaved UI edits. */
export function semanticEqual(a: object, b: object): boolean {
    return canonicalJson(a) === canonicalJson(b);
}

/** Serialize a config object to a full TOML document, pruning nullish
 *  values first (see {@link pruneNullish}). Uses smol-toml's writer (not
 *  toml-patch's) so nested tables render as `[profiles.render]` sections
 *  rather than inline tables — this output is what users hand-edit on
 *  first run / after the JSON migration. */
function stringifyPruned(pruned: unknown): string {
    return stringify(pruned);
}

/**
 * Render the config as TOML text for saving. When `existingText` is a
 * parseable TOML document, the new config is PATCHED onto it in place:
 * existing keys keep their position, spacing and comments (even when their
 * value changes), new keys are appended to the end of their table, and keys
 * absent from `config` are removed. This is what keeps hand-edited hidden
 * settings findable — the file is never wholesale re-sorted underneath the
 * user. A missing/empty `existingText` (first run, JSON migration) renders
 * from scratch. Throws when `existingText` is non-empty but unparseable —
 * the caller decides whether to fall back to a from-scratch render.
 *
 * Known trade-off: array-of-tables elements (profiles) are patched by
 * index — inserting/removing an element in the middle rewrites the affected
 * blocks' contents in place, so per-block field order inside profiles is
 * not preserved. Table-level order (top level and nested tables) always is.
 */
export function renderConfigToml(existingText: string | undefined, config: object): string {
    const pruned = pruneNullish(config);
    if (existingText === undefined || existingText.trim() === "") {
        return stringifyPruned(pruned);
    }
    return patch(existingText, pruned, {trailingNewline: 1});
}
