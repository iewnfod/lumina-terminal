/**
 * Programming-ligature support for xterm.js, using the font's real GSUB table.
 *
 * xterm.js renders text on a cell grid and doesn't natively merge adjacent
 * cells for ligatures (e.g. `->` rendered as `→`). The `registerCharacterJoiner`
 * API lets us tell xterm which character ranges to join, and the renderer
 * (WebGL or canvas) then draws them as a single glyph — applying the font's
 * OpenType `calt` ligature substitutions.
 *
 * To know WHICH ranges to join we need the font's GSUB table. In a Tauri
 * webview there's no Node.js `fs` to read the font file, so the binary data
 * comes from the Rust backend (`find_font` command, transferred as raw bytes
 * over IPC — see lib/terminalApi.ts). `font-ligatures`'
 * `loadBuffer()` then parses the GSUB `calt` lookups entirely client-side
 * (via `opentype.js`, pure JS) and returns a `Font` object whose
 * `findLigatureRanges(text)` tells us exactly which substrings the font
 * ligates — including font-specific ones like Fira Code's `www` or `//`.
 *
 * ## Font cache
 *
 * Parsing the GSUB table (`loadBuffer`, ~50-100 ms, synchronous) is the
 * expensive part. Since the same font is reused across every terminal that
 * shares it (most tabs use the global profile font), we cache the parsed
 * `Font` per family name in a module-level `Map`. The first terminal to
 * request a family pays the parse cost; all subsequent terminals get the
 * cached `Font` instantly. `preloadFont()` can be called at app startup to
 * warm the cache for the global font before any terminal mounts.
 *
 * If the backend can't find the font, we fall back to a hardcoded list of
 * ~50 common programming ligatures (the same list xterm.js addon-ligatures
 * uses). This covers the most common cases but misses font-specific ligatures.
 *
 * Pure logic (no React) per the lib/ layering rule.
 */
import {Terminal} from "@xterm/xterm";
import {loadBuffer, type Font} from "font-ligatures";
import {findFont} from "./terminalApi.ts";

// Caches 100K characters worth of ligatures (~650 KB with moderate ligatures).
const CACHE_SIZE = 100000;

/**
 * Fallback ligature list used when the font file can't be loaded. Sourced from
 * Iosevka's default "calt" ligation set (same as xterm.js addon-ligatures).
 * Sorted longest-first so the greedy matcher prefers longer matches.
 */
const FALLBACK_LIGATURES = [
    "<--", "<---", "<<-", "<-", "->", "->>", "-->", "--->",
    "<==", "<===", "<<=", "<=", "=>", "=>>", "==>", "===>", ">=", ">>=",
    "<->", "<-->", "<--->", "<---->", "<=>", "<==>", "<===>", "<====>", "::", ":::",
    "<~~", "</", "</>", "/>", "~~>", "==", "!=", "/=", "~=", "<>", "===", "!==", "!===",
    "<:", ":=", "*=", "*+", "<*", "<*>", "*>", "<|", "<|>", "|>", "+*", "=*", "=:", ":>",
    "/*", "*/", "+++", "<!--", "<!---",
].sort((a, b) => b.length - a.length);

/** A [start, end) pair into a text string indicating a ligature range. */
type Range = [number, number];

/**
 * Module-level font cache: family name → parsed Font (or null if the backend
 * couldn't find the font). The promise is cached (not the resolved value) so
 * that concurrent callers sharing the same family dedupe to a single
 * `findFont` + `loadBuffer` round-trip (single-flight).
 */
const fontCache = new Map<string, Promise<Font | null>>();

/**
 * Get the parsed `Font` for a family name, loading + caching it if necessary.
 * Concurrent calls for the same family share one in-flight promise. Once
 * resolved, the `Font` (with its internal ligature-range LRU) is reused by
 * every terminal that shares this font — a memory and CPU win.
 *
 * `loadBuffer` is synchronous and can block for 50-100 ms; it runs inside the
 * promise so callers can `await` it without blocking the caller's synchronous
 * code path. Callers that need the result without blocking should use the
 * promise returned here (e.g. `enableLigatures` below).
 */
export function getOrLoadFont(family: string): Promise<Font | null> {
    let pending = fontCache.get(family);
    if (!pending) {
        pending = findFont(family)
            .then((bytes) => {
                if (!bytes || bytes.byteLength === 0) return null;
                // loadBuffer is synchronous (~50-100 ms). Wrap in a microtask so
                // the caller's .then() doesn't block on the same tick — the UI
                // gets a chance to paint first.
                return new Promise<Font>((resolve) => {
                    setTimeout(() => {
                        try {
                            resolve(loadBuffer(bytes.buffer, {cacheSize: CACHE_SIZE}));
                        } catch {
                            resolve(null as unknown as Font);
                        }
                    }, 0);
                });
            })
            .then((font) => (font ?? null))
            .catch(() => null);
        fontCache.set(family, pending);
    }
    return pending;
}

/**
 * Warm the font cache for a family name without blocking. Call this at app
 * startup (e.g. from GlobalConfigProvider after config loads) so the first
 * terminal to mount finds the font already parsed — zero ligature startup lag.
 *
 * Returns the same promise as {@link getOrLoadFont} for optional awaiting.
 */
export function preloadFont(family: string): Promise<Font | null> {
    return getOrLoadFont(family);
}

/**
 * Enable ligature rendering for a terminal. Must be called AFTER
 * `terminal.open()`.
 *
 * Uses the cached font for `family` if available (warm cache = instant);
 * otherwise kicks off the load (deduped with other terminals sharing the same
 * font). While the font is loading, the joiner returns fallback ranges from
 * the hardcoded list so common ligatures work immediately. Once the real font
 * is parsed, a `term.refresh()` re-evaluates already-rendered text.
 *
 * @param term The xterm.js Terminal instance.
 * @param family The CSS font-family string (e.g. `"Fira Code"`), or undefined
 *   to use fallback-only mode (no backend font lookup).
 * @returns The character-joiner ID (for deregistration), or `undefined` if
 *   registration failed.
 */
export function enableLigatures(
    term: Terminal,
    family?: string,
): number | undefined {
    let font: Font | null | undefined;

    if (family) {
        getOrLoadFont(family).then((f) => {
            font = f;
            // NOTE: deliberately NOT calling term.refresh() here. The character
            // joiner is lazy — xterm re-invokes it on the next natural render
            // (scroll, new output, cursor move, keystroke), so real ligatures
            // replace the fallback ranges within a frame or two with zero extra
            // cost. A forced full-viewport refresh here would make the joiner
            // re-evaluate every visible line in one synchronous burst, which is
            // exactly the "stutter on ligature load" we're avoiding. This lets
            // the switch happen quietly spread over normal rendering instead.
        });
    }

    return term.registerCharacterJoiner((text: string): Range[] => {
        // If the font's GSUB table is loaded, use it for precise, font-specific
        // ligature ranges (including Fira Code's `www`, `//`, etc.).
        if (font) {
            return font.findLigatureRanges(text).map((r) => [r[0], r[1]] as Range);
        }
        // Font not loaded yet or unavailable — use the hardcoded fallback list.
        return fallbackRanges(text);
    });
}

/** Match text against the fallback ligature list (greedy, longest-first). */
function fallbackRanges(text: string): Range[] {
    const ranges: Range[] = [];
    for (let i = 0; i < text.length; i++) {
        for (const lig of FALLBACK_LIGATURES) {
            if (text.startsWith(lig, i)) {
                ranges.push([i, i + lig.length]);
                i += lig.length - 1;
                break;
            }
        }
    }
    return ranges;
}
