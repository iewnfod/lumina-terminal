import {invokeLogged} from "./apiCore.ts";
import type {CliArgs} from "../types/cli.ts";

/**
 * Read the parsed launch flags from the backend. The args are parsed once at
 * startup (clap, in `src-tauri/src/cli.rs`) and stored process-wide, so this
 * is a cheap read. On rejection (backend unavailable) it resolves to a default
 * with no overrides so the app boots normally — the failure is logged.
 *
 * Sibling to `terminalApi.ts`: a new backend command gets a wrapped helper with
 * log-on-reject rather than a raw `invoke` in a component.
 */
export function getCliArgs(): Promise<CliArgs> {
    return invokeLogged<CliArgs>("get_cli_args", {}, {
        message: "Failed to read CLI args",
        fallback: {command: [], hold: false},
    });
}
