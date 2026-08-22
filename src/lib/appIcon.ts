import {CommandIconRule} from "../types/config.ts";

/**
 * Application icon resolution: given a running command line, decide which
 * (if any) app icon the tab should show.
 *
 * Pure logic (no React) per the lib/ layering rule. The single source of
 * truth for the command→icon mapping; components consume {@link getAppIcon}.
 *
 * Mirrors the organization of `shellIcon.ts`, but maps a *running command* to
 * a branded app icon rather than a shell category. App icons are rendered by
 * `components/AppIcon.tsx` and take precedence over the shell icon when set.
 *
 * User-defined rules (config `commandIcons`) are evaluated before the built-in
 * table here; see {@link getAppIcon}.
 */

/** Icon id — a string matching a directory name under
 * `src/assets/app-icons/<id>/`, or a `custom:<file>` reference to an imported
 * image (resolved in lib/commandIconApi.ts). Add a built-in id by dropping
 * `<id>/<id>-light.svg` + `<id>-dark.svg` there and adding a row in
 * {@link APP_COMMANDS}. */
export type AppIconId = string;

/** Prefix marking an icon id as a user-imported image file (the rest of the
 * id is the stored file name under the app data dir's command-icons dir). */
const CUSTOM_PREFIX = "custom:";

/** True when the icon id refers to an imported image, not a built-in one. */
export function isCustomIconId(id: AppIconId): boolean {
    return id.startsWith(CUSTOM_PREFIX);
}

/** The stored file name part of a `custom:` icon id (no validation). */
export function customIconName(id: AppIconId): string {
    return id.slice(CUSTOM_PREFIX.length);
}

/** Build a `custom:` icon id from a stored file name. */
export function customIconId(name: string): AppIconId {
    return CUSTOM_PREFIX + name;
}

/** Command basename (lowercase) → app icon id. The single mapping table; all
 * matching goes through this. Keys are argv[0] basenames as reported by the
 * backend's `foreground_command` / shell-integration CurrentCommand stream.
 * The id must match an icon directory under `src/assets/app-icons/`. */
const APP_COMMANDS: Record<string, AppIconId> = {
    opencode: "opencode",
    vim: "vim",
    nvim: "neovim",
    neovim: "neovim",
    claude: "claudecode"
};

/** argv[0] basenames that wrap another command. When extracting the "real"
 * app from a command line, these are skipped so e.g. "sudo opencode" resolves
 * to opencode. Extends the PRIVILEGED_COMMANDS idea from command_tracker.rs
 * with non-privileged wrappers (env, time, strace, ...). */
const WRAPPERS = new Set([
    // privilege escalation
    "sudo", "doas", "su", "pkexec", "gsudo", "runuser",
    // generic wrappers
    "env", "exec", "nohup", "time", "timed",
    // observation / scheduling
    "strace", "ltrace", "nice", "ionice",
    // misc
    "xargs", "watch",
]);

/** Extract the executable basename (no dir, no `.exe`) from a path string. */
function exeBasename(exe: string): string {
    const base = exe.split(/[\\/]/).pop() ?? exe;
    return base.toLowerCase().replace(/\.exe$/, "");
}

/** Extract the "real" app basename from a full command line, skipping wrapper
 * commands. Returns the first non-wrapper, non-env-assignment token's basename.
 * e.g. "sudo nvim file.txt" → "nvim"; "env FOO=bar opencode" → "opencode".
 * Returns null for an empty/all-wrapper command line. */
export function resolveAppFromCommand(line: string): string | null {
    const tokens = line.trim().split(/\s+/);
    for (const tok of tokens) {
        const base = exeBasename(tok);
        if (!base) continue;
        if (WRAPPERS.has(base)) continue;
        if (base.includes("=")) continue; // env VAR=val assignment
        return base;
    }
    return null;
}

/** Compile-check a regex pattern for the settings editor: true when the
 * pattern is a valid RegExp source (empty counts as invalid — a rule with no
 * pattern can never match). */
export function isValidRegex(pattern: string): boolean {
    if (!pattern) return false;
    try {
        new RegExp(pattern);
        return true;
    } catch {
        return false;
    }
}

/** Test a single user rule against a command line. Plain rules compare the
 * wrapper-resolved command basename (case-insensitive) exactly like the
 * built-in table; regex rules test the whole raw command line. An invalid
 * regex never matches — this runs on the icon derivation path, where a
 * throwing rule would break tab rendering. Exported for the settings panel's
 * live validation/preview. */
export function ruleMatches(rule: CommandIconRule, line: string): boolean {
    if (!rule.match) return false;
    if (rule.isRegex) {
        try {
            return new RegExp(rule.match).test(line);
        } catch {
            return false;
        }
    }
    const app = resolveAppFromCommand(line);
    return app !== null && app === rule.match.trim().toLowerCase();
}

/** Given a command line, return the app icon id to display, or null when the
 * command is not a supported app (caller falls back to the shell icon).
 * User rules run first in array order (first match wins, so they can override
 * built-ins), then the built-in table. This is the single entry point
 * components/App should call. */
export function getAppIcon(line: string, userRules?: CommandIconRule[]): AppIconId | null {
    for (const rule of userRules ?? []) {
        if (ruleMatches(rule, line)) return rule.icon;
    }
    const app = resolveAppFromCommand(line);
    if (!app) return null;
    return APP_COMMANDS[app] ?? null;
}
