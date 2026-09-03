import type {GlobalConfig} from "../types/config.ts";
import type {SystemTheme} from "./term.ts";

/** What the theme-mode setting forces downstream: `darkOverride` feeds
 *  useEffectiveTheme (light/dark rendering of chrome + HeroUI class) and
 *  `forceBg` repaints the whole window (including the terminal canvas via
 *  Term's forceBg prop). */
export interface ThemeModeForces {
    darkOverride: boolean | null;
    forceBg: string | null;
}

/**
 * Translate the theme-mode setting ("system" | "terminal" | "light" | "dark")
 * into the dark override + forced background the theme pipeline consumes:
 *  - "terminal" → null/null (derive from the bg, the legacy behavior).
 *  - "system"  → null until the OS theme resolves, then the resolved value;
 *    while unresolved the window briefly falls back to the terminal bg.
 *  - "light"/"dark" → forced neutral base colors that harmonize with most
 *    terminal palettes.
 *
 * Pure — extracted from App.tsx so the mode semantics live next to the theme
 * code instead of inline in the composition root (AGENTS.md §3.5).
 */
export function themeModeForces(
    themeMode: NonNullable<GlobalConfig["themeMode"]>,
    systemTheme: SystemTheme,
): ThemeModeForces {
    const darkOverride =
        themeMode === "light" ? false
        : themeMode === "dark" ? true
        : themeMode === "system" ? (systemTheme === "light" ? false : systemTheme === "dark" ? true : null)
        : null;
    const forceBg =
        themeMode === "terminal" ? null
        : darkOverride === true ? "#1a1a1a"
        : darkOverride === false ? "#fafafa"
        : null; // system unresolved → briefly fall back to terminal bg
    return {darkOverride, forceBg};
}
