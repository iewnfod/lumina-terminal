import {invoke} from "@tauri-apps/api/core";
import {error} from "@tauri-apps/plugin-log";

/**
 * The one invoke-with-error-logging core every domain api module
 * (terminalApi / mcpApi / proxyApi / cliApi / …) builds on: log any rejection
 * as an error before rethrowing, so a backend failure is always recorded even
 * when a caller treats the promise as fire-and-forget. Callers that attach
 * their own `.catch` still see the rejection; the log happens exactly once
 * here. Previously each api module hand-rolled this catch-and-log stanza, and
 * the message formats had drifted.
 *
 * Options:
 *  - `message`: full log message (default `` `${scope}: ${command} failed` ``).
 *  - `scope`:   short domain tag used by the default message.
 *  - `fallback`: return this value instead of rethrowing (degrade-to-default
 *    wrappers, e.g. cliApi's getCliArgs). Presence-checked so an explicit
 *    `fallback: undefined` still rethrows.
 */
export function invokeLogged<T>(
    command: string,
    args: Record<string, unknown> = {},
    opts: {scope?: string; message?: string; fallback?: T} = {},
): Promise<T> {
    return invoke<T>(command, args).catch((e) => {
        const msg = opts.message ?? `${opts.scope ?? "invoke"}: ${command} failed`;
        error(`${msg}: ${e}`).catch(() => {});
        if ("fallback" in opts) return opts.fallback as T;
        throw e;
    });
}
