import {invoke} from "@tauri-apps/api/core";
import {error} from "@tauri-apps/plugin-log";

/** Start the system-proxy watcher: it polls the platform proxy source
 *  (gsettings / kioslaverc / scutil / registry) every few seconds and rewrites
 *  the shell hooks' env-file on change. Idempotent — safe to call when the
 *  watcher is already running (e.g. from a tear-off window). */
export function startProxySync(): Promise<void> {
    return invoke<void>("start_proxy_sync").catch((e) => {
        error(`Failed to start proxy sync: ${e}`).catch(() => {});
        throw e;
    });
}

/** Stop the watcher and delete the hooks' env-file (its absence tells the
 *  hooks to unset what they injected). Idempotent — safe to call when no
 *  watcher is running; also cleans up a stale file left by a crashed run. */
export function stopProxySync(): Promise<void> {
    return invoke<void>("stop_proxy_sync").catch((e) => {
        error(`Failed to stop proxy sync: ${e}`).catch(() => {});
        throw e;
    });
}
