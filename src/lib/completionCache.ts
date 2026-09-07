import {LazyStore} from "@tauri-apps/plugin-store";
import {debug, error} from "@tauri-apps/plugin-log";
import {COMPLETION_CACHE_STORE_PATH} from "../constants.ts";
import {
    type SerializedCompletionIndex,
    mergeCompletionIndex,
    pruneCompletionIndex,
} from "./completions.ts";

/**
 * Per-profile completion warm-cache persistence — the durable half of the
 * terminal-suggest instant-open (hooks/useShellCompletions.ts holds the
 * in-memory index; this module loads it at mount and writes it back after
 * fetches).
 *
 * Runtime state, NOT a user setting: a dedicated LazyStore
 * (`state/completion-cache.json`), mirroring {@link lib/session.ts} and
 * {@link lib/profileUsage.ts} so nothing pollutes config.toml. All failures
 * are logged and swallowed — losing the data only degrades the popup back to
 * shell round-trips (the uncached behavior).
 *
 * Writes are read-merge-write per profile section, so concurrent tabs of the
 * same profile accumulate knowledge instead of clobbering each other.
 */

const store = new LazyStore(COMPLETION_CACHE_STORE_PATH);
const INDEX_KEY = "index";

/** Persistence bounds: per profile the freshest contexts/words survive, each
 *  set capped at the UI's display limit (more could never be shown). */
const PERSIST_CTX_CAP = 96;
const PERSIST_WORD_CAP = 8;
const PERSIST_SET_CAP = 100;

/** Read one profile's persisted index (one-shot). Returns {} when no data
 *  exists or the read fails — the latter is logged, not thrown. */
export async function loadCompletionIndex(profile: string): Promise<SerializedCompletionIndex> {
    try {
        const all = await store.get<Record<string, SerializedCompletionIndex>>(INDEX_KEY);
        return all?.[profile] ?? {};
    } catch (e) {
        error(`Failed to load completion cache for profile ${profile}: ${e}`).catch(() => {});
        return {};
    }
}

/**
 * Merge `mine` (this terminal's in-memory snapshot) into the profile's
 * persisted section (newer fetchAt wins per entry), prune to the bounds, and
 * save. Failures are logged and swallowed.
 */
export async function persistCompletionIndex(
    profile: string,
    mine: SerializedCompletionIndex,
): Promise<void> {
    try {
        const all = (await store.get<Record<string, SerializedCompletionIndex>>(INDEX_KEY)) ?? {};
        const merged = pruneCompletionIndex(
            mergeCompletionIndex(all[profile] ?? {}, mine),
            PERSIST_CTX_CAP,
            PERSIST_WORD_CAP,
            PERSIST_SET_CAP,
        );
        all[profile] = merged;
        await store.set(INDEX_KEY, all);
        await store.save();
        debug(
            `Persisted completion cache for profile ${profile}: ` +
                `${Object.keys(merged).length} context(s)`,
        );
    } catch (e) {
        error(`Failed to persist completion cache for profile ${profile}: ${e}`).catch(() => {});
    }
}
