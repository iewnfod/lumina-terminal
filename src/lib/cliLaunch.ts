import type {CliArgs} from "../types/cli.ts";
import type {TerminalProfile} from "../types/terminal.ts";

/** True when any launch-shaping flag was given (`--profile`/`-e`/`
 *  --working-directory`/`--hold`/`-T/--title`). `--sidebar` is deliberately
 *  excluded: it's a chrome-only override App applies without shaping the
 *  initial tab. Pure — extracted from useTerminalManager's seed effect so the
 *  flag semantics are testable without React. */
export function hasLaunchArgs(cliArgs: CliArgs): boolean {
    return (
        cliArgs.command.length > 0 ||
        !!cliArgs.workingDirectory ||
        cliArgs.hold ||
        !!cliArgs.title ||
        !!cliArgs.profile
    );
}

/**
 * Apply Alacritty-style launch flags to a base profile, producing the initial
 * tab's profile for this launch:
 *  - base = the `--profile` flag's profile when it resolves, else the default
 *    profile (an unresolvable name warns and falls back).
 *  - `--working-directory` overrides the startup cwd.
 *  - `-e/--command` runs through the configured shell (Lumina's
 *    startupCommand model). Without `--hold` the tab closes when the command
 *    exits (Alacritty-faithful); `--hold` freezes the output instead.
 *  - `--hold` without a command still freezes (shell exits → frozen output).
 *
 * Returns null when NO launch flag was given — callers fall through to the
 * normal session-restore / default-tab path. Window shaping (`-T/--title`)
 * is NOT applied here; the caller drives setTitle itself.
 */
export function deriveCliLaunchProfile(
    cliArgs: CliArgs,
    profiles: TerminalProfile[],
    defaultProfile: TerminalProfile | undefined,
    onUnknownProfile?: (name: string) => void,
): TerminalProfile | null {
    if (!hasLaunchArgs(cliArgs)) return null;
    let base = defaultProfile;
    if (cliArgs.profile) {
        const found = profiles.find((p) => p.name === cliArgs.profile);
        if (found) {
            base = found;
        } else {
            onUnknownProfile?.(cliArgs.profile);
        }
    }
    if (!base) return null;
    const p: TerminalProfile = {...base};
    if (cliArgs.workingDirectory) p.cwd = cliArgs.workingDirectory;
    if (cliArgs.command.length > 0) {
        p.startupCommand = cliArgs.command.join(" ");
        p.keepAfterExit = cliArgs.hold ? "freeze" : "exit";
    } else if (cliArgs.hold) {
        p.keepAfterExit = "freeze";
    }
    return p;
}
