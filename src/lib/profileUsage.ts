import {LazyStore} from "@tauri-apps/plugin-store";
import {debug, error} from "@tauri-apps/plugin-log";
import {PROFILE_USAGE_STORE_PATH} from "../constants.ts";

/**
 * Per-profile "last opened" recency bookkeeping — which profile was opened
 * how recently, so the empty-state quick-launch list (components/
 * EmptyState.tsx) can sort by recency.
 *
 * This is runtime state, NOT a user setting: it used to live in config.toml's
 * `profileLastOpened` key (rewritten on every tab open), which polluted the
 * user's hand-editable config with noise. It now lives in a dedicated
 * LazyStore file, mirroring {@link lib/session.ts} and {@link lib/tearoff.ts};
 * hooks/config.tsx strips the legacy config key once. All failures are logged
 * and swallowed — losing the data only degrades the empty-state sort back to
 * config order.
 */

const store = new LazyStore(PROFILE_USAGE_STORE_PATH);
const LAST_OPENED_KEY = "lastOpened";

/** Read the whole last-opened map (one-shot). Returns {} when no data exists
 *  or the read fails — the latter is logged, not thrown. */
export async function loadProfileLastOpened(): Promise<Record<string, number>> {
    try {
        const map = await store.get<Record<string, number>>(LAST_OPENED_KEY);
        return map ?? {};
    } catch (e) {
        error(`Failed to load profile recency data: ${e}`).catch(() => {});
        return {};
    }
}

/** Persist (overwrite) the last-opened map. Failures are logged and swallowed —
 *  a failed persist must never block tab creation. */
export async function saveProfileLastOpened(map: Record<string, number>): Promise<void> {
    try {
        await store.set(LAST_OPENED_KEY, map);
        await store.save();
        debug(`Persisted profile recency: ${Object.keys(map).length} profile(s)`);
    } catch (e) {
        error(`Failed to persist profile recency data: ${e}`).catch(() => {});
    }
}
