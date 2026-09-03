import {useRef} from "react";
import {CurrentCommand} from "../types/terminal.ts";
import {CurrentCommandParser} from "../lib/currentCommand.ts";
import {useTauriListen} from "./useTauriListen.ts";

interface UseCurrentCommandOptions {
    /** PTY id whose `term-command-<id>` events this hook subscribes to. */
    ptyId: string;
    /** Reports the currently-running command, or null when idle at the shell
     *  prompt. Drives the small subtitle under the tab title. */
    onCommandChange?: (command: CurrentCommand | null) => void;
    /** Reports a finished command's exit code (shell-integration precmd),
     *  paired with the command text that was just running. Feeds the
     *  per-command history on the backend (MCP `list_command_history`). */
    onCommandExit?: (payload: {command: string | null; exitCode: number}) => void;
}

/**
 * Tracks what command is running in a terminal, merging the two signal
 * sources: shell-integration OSC sequences parsed from the OUTPUT stream
 * (precise: full command text) and the backend's /proc process-group probe
 * (fallback: command name only, no exit codes). The fallback is suppressed
 * once OSC integration proves active — it is strictly less precise.
 *
 * Extracted from Term.tsx where this logic was spread across the props refs,
 * the output-channel handler, and the term-command listener.
 */
export function useCurrentCommand({ptyId, onCommandChange, onCommandExit}: UseCurrentCommandOptions) {
    // Latest-refs so the (once-registered) parser feed and listener always
    // observe the current callbacks without re-subscribing.
    const onCommandChangeRef = useRef(onCommandChange);
    onCommandChangeRef.current = onCommandChange;
    const onCommandExitRef = useRef(onCommandExit);
    onCommandExitRef.current = onCommandExit;
    // Last command reported upward. `null` = nothing reported yet / idle.
    const currentCommandRef = useRef<CurrentCommand | null>(null);
    const commandParserRef = useRef<CurrentCommandParser | null>(null);
    // True once the shell has emitted an OSC sequence this session — used to
    // decide whether the backend's process-group fallback should be honored.
    const oscActiveRef = useRef<boolean>(false);

    // Only notify upward on an actual change (command text or privileged flag)
    // so the tab list doesn't re-render on every output chunk.
    const reportCommand = (cmd: CurrentCommand | null) => {
        const prev = currentCommandRef.current;
        const changed =
            prev === null
                ? cmd !== null
                : cmd === null
                    ? true
                    : prev.command !== cmd.command || prev.privileged !== cmd.privileged;
        if (changed) {
            currentCommandRef.current = cmd;
            onCommandChangeRef.current?.(cmd);
        }
    };

    /** Feed a chunk of PTY output through the shell-integration parser. Parse
     *  BEFORE the chunk reaches xterm — xterm drops unknown OSC, so parsing
     *  here is invisible to the rendered output. */
    const feedOutput = (data: string) => {
        if (!commandParserRef.current) {
            commandParserRef.current = new CurrentCommandParser();
        }
        for (const ev of commandParserRef.current.feed(data)) {
            if (ev.type === "command") {
                oscActiveRef.current = true;
                reportCommand({command: ev.value, privileged: false});
            } else {
                // Command finished: pair the just-run command text with its
                // exit code, forward to the backend history, then clear the
                // current command (shell is back at prompt).
                onCommandExitRef.current?.({
                    command: currentCommandRef.current?.command ?? null,
                    exitCode: ev.code,
                });
                reportCommand(null);
            }
        }
    };

    // Backend /proc fallback (emitted by the watcher thread while the shell
    // itself is foreground). Ignored once OSC integration is active.
    useTauriListen<CurrentCommand>(`term-command-${ptyId}`, (cmdInfo) => {
        if (oscActiveRef.current) return;
        const cmd = (cmdInfo?.command ?? "").trim();
        reportCommand(cmd === "" ? null : {command: cmd, privileged: !!cmdInfo?.privileged});
    });

    return {feedOutput};
}
