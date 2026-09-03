import {invokeLogged} from "./apiCore.ts";

/** Start the system-proxy watcher: it polls the platform proxy source
 *  (gsettings / kioslaverc / scutil / registry) every few seconds and rewrites
 *  the shell hooks' env-file on change. Idempotent — safe to call when the
 *  watcher is already running (e.g. from a tear-off window). */
export function startProxySync(): Promise<void> {
    return invokeLogged<void>("start_proxy_sync", {}, {
        message: "Failed to start proxy sync",
    });
}

/** Stop the watcher and delete the hooks' env-file (its absence tells the
 *  hooks to unset what they injected). Idempotent — safe to call when no
 *  watcher is running; also cleans up a stale file left by a crashed run. */
export function stopProxySync(): Promise<void> {
    return invokeLogged<void>("stop_proxy_sync", {}, {
        message: "Failed to stop proxy sync",
    });
}
