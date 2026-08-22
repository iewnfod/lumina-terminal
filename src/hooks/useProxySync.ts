import {useEffect} from "react";
import {error as logError, info} from "@tauri-apps/plugin-log";
import {useGlobalConfig} from "./config.tsx";
import {startProxySync, stopProxySync} from "../lib/proxyApi.ts";

/**
 * Drive the system-proxy watcher from `config.autoProxy`. Call this ONCE, at
 * the app root (App.tsx), so the watcher follows the app lifecycle — not the
 * settings panel's mount/unmount — exactly like `useMcpServerLifecycle`.
 *
 * The backend is idempotent, so the duplicate start from a tear-off window's
 * own App instance is a harmless no-op. Disabling stops the watcher AND
 * deletes the hooks' env-file, which unsets (only) what the hooks injected in
 * already-running shells at their next prompt.
 */
export function useProxySync() {
    const {config} = useGlobalConfig();
    const enabled = config.autoProxy ?? true;

    useEffect(() => {
        if (!enabled) {
            stopProxySync().catch((e) => {
                logError(`Failed to stop proxy sync: ${e}`).catch(() => {});
            });
            return;
        }
        info("Starting system-proxy watcher");
        startProxySync().catch((e) => {
            logError(`Proxy sync failed to start: ${e}`).catch(() => {});
        });
        // App-lifecycle-scoped like the MCP server: cleanup does NOT stop the
        // watcher — only a transition to enabled=false (above) does.
        return;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled]);
}
