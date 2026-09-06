import {LazyStore} from "@tauri-apps/plugin-store";
import {debug, error} from "@tauri-apps/plugin-log";
import {CELL_METRICS_STORE_PATH} from "../constants.ts";
import {TerminalProfile} from "../types/terminal.ts";

/**
 * Cached xterm cell metrics (css px per cell) keyed by everything that
 * influences them — font family/size/weight/style, letterSpacing, lineHeight
 * and the device pixel ratio.
 *
 * Measuring a cell requires spawning an off-screen dummy xterm and reading its
 * renderer dimensions (lib/terminalGeometry.ts), which is exactly the work that
 * used to sit between the main window becoming visible and reaching its final
 * size at startup. With the cache, a launch whose font configuration is
 * unchanged sizes the window straight from the cached numbers; only a cache
 * miss pays the measurement (and stores the result for next time).
 *
 * Runtime cache, NOT user config: a dedicated LazyStore file mirroring
 * {@link lib/profileUsage.ts}. All failures are logged and swallowed — losing
 * the cache only costs one dummy-xterm measurement. Keys can't go stale
 * against a config change: any input change produces a different key and the
 * old entry just goes unused (the file stays tiny; one write per distinct
 * font configuration ever used).
 *
 * Pure logic (no React) per the lib/ layering rule.
 */
const store = new LazyStore(CELL_METRICS_STORE_PATH);
const METRICS_KEY = "metrics";

/** The whole persisted document (one store key): the cell-metrics map plus the
 *  last chrome offset. */
interface MetricsDoc {
    cells?: MetricsMap;
    chromeOffset?: {dx: number, dy: number};
}

/** One measured cell size (css px), as xterm's renderer reported it. */
export interface CellMetrics {
    width: number;
    height: number;
}

type MetricsMap = Record<string, CellMetrics>;

// Mirror of the store's contents once loaded; null until then.
// profileWindowSize reads it synchronously, so the load is kicked early —
// hooks/config.tsx calls ensureCellMetricsLoaded() right after config load,
// before any sizer can run.
let cached: MetricsMap | null = null;
let loadOnce: Promise<void> | null = null;

// The most recent chrome offset (window inner size minus the terminal mount
// element — sidebar + title bar + padding), stored alongside the cell metrics.
// WebKitGTK reports 0x0 for every element while the window is hidden, so the
// startup sizing can't measure the offset before show(); it uses this cached
// value instead (see lib/terminalGeometry.ts). Keyed as "last known" rather
// than per sidebar/padding state: a stale entry (sidebar toggled since) only
// makes one launch's window slightly wide/narrow — the live re-measure below
// overwrites it as soon as a real layout is available.
let cachedOffset: {dx: number, dy: number} | null = null;

/** Cache key: every render option xterm's cell metrics depend on, plus the
 *  device pixel ratio (the renderer rounds cell dimensions at the device
 *  layer). */
export function cellMetricsKey(profile: TerminalProfile): string {
    return [
        profile.fontFamily ?? "",
        profile.fontSize ?? "",
        profile.fontStyle ?? "",
        profile.fontWeight ?? "",
        profile.letterSpacing ?? "",
        profile.lineHeight ?? "",
        window.devicePixelRatio,
    ].join("|");
}

/** Load the metrics cache once (idempotent; never rejects). Failures log and
 *  leave the cache empty, which just costs a re-measurement. */
export function ensureCellMetricsLoaded(): Promise<void> {
    if (!loadOnce) {
        loadOnce = (async () => {
            try {
                const doc = await store.get<MetricsDoc>(METRICS_KEY);
                cached = doc?.cells ?? {};
                cachedOffset = doc?.chromeOffset ?? null;
            } catch (e) {
                error(`Failed to load cached cell metrics: ${e}`).catch(() => {});
                cached = {};
            }
        })();
    }
    return loadOnce;
}

/** Synchronous lookup into the loaded cache — null before the load has
 *  resolved or on a miss; the caller measures and stores instead. */
export function cachedCellMetrics(profile: TerminalProfile): CellMetrics | null {
    if (!cached) return null;
    return cached[cellMetricsKey(profile)] ?? null;
}

/** The last measured chrome offset (inner − terminal container), or null when
 *  none was ever stored. Used to size the window while it is still hidden. */
export function cachedChromeOffset(): {dx: number, dy: number} | null {
    return cachedOffset;
}

/** Record a measurement for the profile's key. Updates the in-memory map and
 *  persists fire-and-forget; failures only cost the next launch a
 *  re-measurement. No-op while the cache hasn't loaded (persisting then could
 *  drop the other entries — see {@link ensureCellMetricsLoaded}). */
export function storeCellMetrics(profile: TerminalProfile, metrics: CellMetrics): void {
    if (!cached) return;
    if (!Number.isFinite(metrics.width) || !Number.isFinite(metrics.height)) return;
    cached[cellMetricsKey(profile)] = metrics;
    store.set(METRICS_KEY, {cells: cached, chromeOffset: cachedOffset} as MetricsDoc)
        .then(() => store.save())
        .then(() => debug("Persisted cell metrics cache"))
        .catch((e: unknown) => {
            error(`Failed to persist cell metrics cache: ${e}`).catch(() => {});
        });
}

/** Record the chrome offset observed from a real layout. Same persistence
 *  semantics as {@link storeCellMetrics}. */
export function storeChromeOffset(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    cachedOffset = {dx, dy};
    if (!cached) return; // cell cache not loaded; the offset stays memory-only this session
    store.set(METRICS_KEY, {cells: cached, chromeOffset: cachedOffset})
        .then(() => store.save())
        .catch((e: unknown) => {
            error(`Failed to persist cell metrics cache: ${e}`).catch(() => {});
        });
}
