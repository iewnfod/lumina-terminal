import {appDataDir, join} from "@tauri-apps/api/path";
import {exists, mkdir, rename} from "@tauri-apps/plugin-fs";
import {debug, info, warn} from "@tauri-apps/plugin-log";
import {
    CELL_METRICS_STORE_PATH,
    PROFILE_USAGE_STORE_PATH,
    SESSION_STORE_PATH,
    STATE_DIR,
    TEAROFF_STORE_PATH,
} from "../constants.ts";

/**
 * One-time migration for the state-folder layout: the app's own LazyStore
 * files (session / profile usage / cell metrics / tear-off) used to sit
 * directly in the app data dir root, next to the user's config.toml. They now
 * live under {@link STATE_DIR} (see constants.ts), so the root holds only
 * user-facing content. This moves any pre-folder file into the folder once —
 * without it, an upgrading user would silently lose their saved session,
 * recency map and metrics cache on first launch.
 *
 * Idempotent by construction (a file is moved only when the old location
 * exists and the new one does not), so it is safe to call on every load —
 * after the first run it costs one `exists` probe per file. Tear-off windows
 * run the same migration concurrently; a rename that loses that race sees the
 * destination already populated and treats it as success. A rename that fails
 * outright is logged and skipped — the store at the new path just starts
 * empty, degrading exactly like a lost file (no session restore, re-sorted
 * empty state, one extra metrics measurement).
 *
 * Called at the top of the config load (hooks/config.tsx) so it settles
 * before the first store read (the cell-metrics warm below it and the
 * session-restore seed in children).
 */

/** Every LazyStore file that lives under {@link STATE_DIR}. The legacy
 *  pre-folder location is the bare file name, derived from the path so the
 *  two can never drift apart. */
const STATE_STORE_PATHS: readonly string[] = [
    SESSION_STORE_PATH,
    PROFILE_USAGE_STORE_PATH,
    CELL_METRICS_STORE_PATH,
    TEAROFF_STORE_PATH,
];

export async function migrateLegacyStateStores(): Promise<void> {
    try {
        const dataDir = await appDataDir();
        for (const storePath of STATE_STORE_PATHS) {
            const name = storePath.split("/").pop() ?? storePath;
            const legacyPath = await join(dataDir, name);
            if (!(await exists(legacyPath))) continue;
            const folderPath = await join(dataDir, storePath);
            if (await exists(folderPath)) continue;
            // rename() does NOT create the destination directory, and at this
            // point nothing else has made state/ yet (plugin-store's save()
            // creates parents, but no save has run — this is the first store
            // touch of the session). Recursive mkdir is an idempotent no-op
            // once the folder exists.
            await mkdir(await join(dataDir, STATE_DIR), {recursive: true});
            try {
                await rename(legacyPath, folderPath);
                info(`Migrated ${name} into ${STATE_DIR}/`);
            } catch (e) {
                if (await exists(folderPath)) {
                    // Another window (tear-off) won the rename race — the file is
                    // where it belongs, nothing to recover from.
                    debug(`${name} was already migrated into ${STATE_DIR}/ by another window`);
                    continue;
                }
                warn(`Failed to migrate ${name} into ${STATE_DIR}/ (the store at the new path starts empty): ${e}`).catch(() => {});
            }
        }
    } catch (e) {
        // Never let the migration abort the config load: degrading to empty
        // stores beats booting (and then saving) on DEFAULT_CONFIG.
        warn(`State-store migration failed (stores at the new path start empty): ${e}`).catch(() => {});
    }
}
