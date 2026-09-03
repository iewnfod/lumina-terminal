import type {GlobalConfig} from "../types/config.ts";
import type {TerminalProfile} from "../types/terminal.ts";
import {parseProfile, type SystemTheme} from "./term.ts";
import type {SavedSession} from "./session.ts";

/** One restorable tab, mapped from a SavedTab. Terminal tabs carry the
 *  re-parsed profile + optional saved scrollback; chrome tabs restore
 *  directly via their sentinel id. */
export type RestoredEntry =
    | {kind: "terminal"; id: string; profile: TerminalProfile; scrollback?: string}
    | {kind: "chrome"; id: string};

/**
 * Map a saved session back to restorable entries: terminal tabs are re-parsed
 * against the CURRENT globalProfile so global render options (font/theme/…)
 * changes still apply; a terminal tab whose profile was deleted/renamed is
 * skipped (the caller is notified per skip so it can warn). Chrome tabs
 * (Settings/About) pass through via their sentinel id. Order is preserved so
 * the restored tab bar matches what the user left.
 *
 * Returns the entries (possibly empty when every tab was skippable), or null
 * when there is nothing to restore at all. Async but React-free — extracted
 * from useTerminalManager's seed effect so the mapping is independently
 * testable.
 */
export async function mapSavedSession(
    saved: SavedSession,
    config: GlobalConfig,
    systemTheme: SystemTheme,
    onSkipped?: (profileName: string) => void,
): Promise<RestoredEntry[] | null> {
    if (!saved || saved.tabs.length === 0) return null;
    const entries = await Promise.all(saved.tabs.map(async (tab): Promise<RestoredEntry | null> => {
        if (tab.kind === "chrome") {
            return {kind: "chrome", id: tab.chromeId};
        }
        const base = config.profiles.find((p) => p.name === tab.profileName);
        if (!base) {
            onSkipped?.(tab.profileName);
            return null;
        }
        const resolved = await parseProfile(
            tab.cwd ? {...base, cwd: tab.cwd} : base,
            config.globalProfile,
            systemTheme,
        );
        return {kind: "terminal", id: "", profile: resolved, scrollback: tab.scrollback};
    }));
    return entries.filter((e): e is RestoredEntry => e !== null);
}
