import {invoke, Channel} from "@tauri-apps/api/core";
import {invokeLogged} from "./apiCore.ts";
import {TerminalProfile} from "../types/terminal.ts";

/**
 * PTY-flavored wrapper over the shared invokeLogged core (lib/apiCore.ts):
 * merges the terminal id into the args and logs with the `[pty]` prefix.
 * Rejections are logged here then rethrown, so a backend failure is always
 * recorded even when a caller treats the promise as fire-and-forget (most PTY
 * call sites do); callers that attach their own `.catch` still see it.
 */
function invokeWithLog<T>(command: string, id: string, args: Record<string, unknown>): Promise<T> {
    return invokeLogged<T>(command, {...args, id}, {
        message: `[pty] ${command} failed for terminal ${id}`,
    });
}

/** Write input/data to a running terminal's PTY. */
export function writeToTerminal(id: string, content: string) {
    return invokeWithLog<void>("write_to_terminal", id, {content});
}

/** Resize a terminal's PTY to the given cols/rows. */
export function resizeTerminal(id: string, cols: number, rows: number) {
    return invokeWithLog<void>("resize_terminal", id, {cols, rows});
}

/** Kill a terminal's PTY process and remove it from backend state. */
export function killTerminal(id: string) {
    return invokeWithLog<void>("kill_terminal", id, {});
}

/**
 * Spawn a terminal's PTY process on the backend. `onOutput` is a Channel the
 * backend streams PTY output over (low-overhead, binary-safe UTF-8). Set its
 * `.onmessage` before calling this.
 */
export function startTerminal(id: string, profile: TerminalProfile, onOutput: Channel<string>) {
    return invokeWithLog<void>("start_terminal", id, {
        exePath: profile.exePath,
        cols: profile.cols,
        rows: profile.rows,
        profileType: profile.type ?? "local",
        sshConfig: profile.type === "remote" ? profile.ssh : undefined,
        cwd: profile.cwd || undefined,
        startupCommand: profile.startupCommand || undefined,
        keepAfterExit: profile.keepAfterExit,
        onOutput,
    });
}

/**
 * Reattach an existing live PTY (keyed by `id`) to this window's output
 * Channel. Used by the torn-off-tab window: after replaying the serialized
 * scrollback into its own xterm, it calls this (instead of `startTerminal`)
 * so the running process keeps going and new output starts streaming to this
 * window. The backend atomically swaps the PTY's stored Channel, so the
 * previous window stops receiving on the next flush.
 */
export function reattachTerminal(id: string, onOutput: Channel<string>) {
    return invokeWithLog<void>("reattach_terminal", id, {onOutput});
}

/**
 * Toggle the per-terminal LowLatency output override. When true the backend
 * flushes every read immediately instead of coalescing into large bursts, so
 * user interaction (typing / mouse / resize) sees the lowest output delay.
 * Only call on boolean transitions — it is not debounced here.
 */
export function setOutputMode(id: string, lowLatency: boolean) {
    return invokeWithLog<void>("set_output_mode", id, {lowLatency});
}

/**
 * Query a running terminal's current working directory — the shell process's
 * cwd (where the user last `cd`'d), not a foreground command's. Used by the
 * "inherit working directory" option so a new tab starts where the active one
 * is. Resolves to null when the terminal is gone or the platform can't expose
 * a cwd (Windows); callers fall back to the profile's configured cwd.
 */
export function getTerminalCwd(id: string): Promise<string | null> {
    return invokeWithLog<string | null>("get_terminal_cwd", id, {});
}

/**
 * Toggle per-terminal read backpressure. When true the backend reader thread
 * pauses reading so it can't outrun xterm (which would pile up unbounded data
 * in the IPC bridge / JS heap and stall the renderer on heavy workloads like
 * vtebench). The ChunkedWriter drives this with hysteresis — only call on
 * watermark transitions, never per chunk.
 */
export function setThrottle(id: string, throttled: boolean) {
    return invokeWithLog<void>("set_throttle", id, {throttled});
}

/** Mirror the focused terminal id to the backend so the read-only MCP server
 *  can answer `get_active_tab`. The frontend's tab list is the source of
 *  truth; this just caches the value backend-side. Pass null when no terminal
 *  is focused (e.g. a settings/about tab). Best-effort: failures are logged
 *  but never block a tab switch. */
export function setActiveTab(id: string | null) {
    invokeLogged<void>("set_active_tab", {id}, {
        message: "Failed to mirror active tab to backend",
        fallback: undefined, // fire-and-forget: log and swallow
    });
}

/** Report a finished command (text + exit code) to the backend, so the
 *  read-only MCP server's `list_command_history` can see it. Called when shell
 *  integration reports the previous command's exit code (OSC CurrentCommandExit). */
export function reportCommandFinished(id: string, command: string | null, exitCode: number) {
    invokeLogged<void>("report_command_finished", {id, command, exitCode}, {
        message: "Failed to report command finished",
        fallback: undefined, // fire-and-forget: log and swallow
    });
}

/**
 * Find a system font file by CSS family name and return its binary contents.
 * Used by the ligature feature to parse the font's GSUB table client-side.
 * Not PTY-scoped (keyed on font family, not terminal id), so it bypasses
 * `invokeWithLog`. The caller handles errors via `.catch`.
 *
 * The backend answers with a raw-byte IPC response (tauri::ipc::Response),
 * which the Tauri runtime delivers as an ArrayBuffer — the default `Vec<u8>`
 * JSON serialization would inflate a 20 MB CJK font to ~70 MB of JSON and a
 * 20M-element JS array in the webview. Returned as a zero-copy Uint8Array
 * view over that buffer.
 */
export function findFont(family: string): Promise<Uint8Array> {
    return invoke<ArrayBuffer>("find_font", {family}).then((buf) => new Uint8Array(buf));
}
