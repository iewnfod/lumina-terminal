import {useEffect, useState} from "react";
import {ITheme} from "@xterm/xterm";
import {TerminalProfile, TerminalRenderOptions} from "../types/terminal.ts";
import {parseProfileTheme, type SystemTheme} from "../lib/term.ts";
import {foregroundFor, isColorDark} from "../lib/color.ts";
import {error} from "@tauri-apps/plugin-log";

export interface EffectiveTheme {
    // The ITheme with bg/fg overridden to the effective values (TUI edge color
    // takes priority), or null when no profile is active yet.
    theme: ITheme | null;
    // Effective background color (edge bg if a fullscreen TUI set one, else
    // theme.background), or undefined before the theme resolves.
    bg: string | undefined;
    // Effective foreground color — a readable contrast color for bg.
    fg: string | undefined;
    /** Resolved light/dark decision for the whole app. Comes from
     *  {@link darkOverride} when set (theme mode = system/light/dark), otherwise
     *  derived from {@link bg} via isColorDark (theme mode = terminal). Chrome
     *  consumers should prefer this over re-deriving from bg. */
    dark: boolean;
    /** True when `bg` comes from a fullscreen TUI's edge background (the TUI
     *  has "spread" its color across the whole window). Chrome uses this to
     *  skip its glass tint so the TUI's color passes through unmodified. */
    isSpread: boolean;
}

/** Resolve a profile's theme exactly as {@link parseProfile} does at tab
 *  creation: merge globalProfile's theme first (as the base), then the
 *  profile's own themePath/inline theme, with systemTheme choosing the
 *  bare-profile fallback palette. Centralizing this keeps the empty-state
 *  fallback (a raw config profile, not pre-parsed) consistent with what a real
 *  terminal shows. */
async function resolveProfileTheme(
    profile: TerminalRenderOptions,
    globalProfile: TerminalRenderOptions | undefined,
    systemTheme: SystemTheme | undefined,
): Promise<ITheme> {
    if (globalProfile) {
        const globalTheme = await parseProfileTheme(globalProfile, undefined, systemTheme);
        return parseProfileTheme(profile, globalTheme, systemTheme);
    }
    return parseProfileTheme(profile, undefined, systemTheme);
}

/**
 * Derive the effective theme for the whole app from the active profile and the
 * edge background reported by the active terminal.
 *
 * - Resolves the profile's theme (themePath + inline theme) asynchronously.
 * - When a fullscreen TUI reports a uniform edge background, that color becomes
 *   the effective background and a readable contrast foreground is picked for
 *   it, so chrome (tab bar, title bar, settings) stays legible.
 * - Syncs the HeroUI light/dark class on <html> with the effective background.
 *
 * Returns the effective theme/bg/fg plus a setter to report edge background
 * changes from the active terminal (null clears it).
 */
export function useEffectiveTheme(
    currentProfile: TerminalProfile | null,
    currentId: string | null,
    /** When false, the TUI edge-background spread is disabled: edge reports are
     *  ignored and the effective theme falls back to the terminal theme. */
    enabled: boolean = true,
    /** Forces the light/dark decision regardless of the background color, for
     *  theme modes "system" / "light" / "dark". `null`/`undefined` = derive
     *  from the background (theme mode "terminal", the legacy behavior). This
     *  drives HeroUI's `.dark` class (app-framework controls). */
    darkOverride: boolean | null = null,
    /** Forces the effective background COLOR to this value, overriding both the
     *  terminal theme bg and fullscreen-TUI edge spread. Used by theme modes
     *  "system"/"light"/"dark" so the whole window (including the terminal
     *  canvas) follows the mode, not just the chrome text. `null`/`undefined` =
     *  bg follows the terminal/TUI (theme mode "terminal"). */
    forceBg: string | null = null,
    /** Global render options, merged the same way {@link parseProfile} merges
     *  them at tab-creation time so the resolved theme matches a real terminal.
     *  Required for the empty-state fallback, whose profile is raw (not
     *  pre-parsed). */
    globalProfile?: TerminalRenderOptions,
    /** OS light/dark preference; picks the fallback palette for a bare profile
     *  (no themePath/inline theme), matching useSystemTheme. */
    systemTheme?: SystemTheme,
): EffectiveTheme & { setEdgeBg: (color: string | null) => void } {
    const [currentTheme, setCurrentTheme] = useState<ITheme | null>(null);
    // Uniform background color sampled from the active terminal's outer ring
    // (a fullscreen TUI's own bg). When set, the whole app follows it so the
    // TUI bleeds seamlessly to the window edges; null => use theme.background.
    const [edgeBg, setEdgeBg] = useState<string | null>(null);

    // Resolve the profile's theme the same way parseProfile does at tab
    // creation: merge globalProfile first, then the profile's own
    // themePath/inline theme, with systemTheme picking the bare-profile
    // fallback palette. This matters for the empty-state fallback, where the
    // profile is a raw config profile (not pre-parsed) — without the global
    // merge + systemTheme it resolves to the wrong palette. Active profiles are
    // already pre-parsed (.theme set), so re-resolving yields the same result.
    useEffect(() => {
        if (!currentProfile) return;
        let cancelled = false;
        resolveProfileTheme(currentProfile, globalProfile, systemTheme)
            .then((theme) => {
                if (!cancelled) setCurrentTheme(theme);
            })
            .catch((e) => {
                error(`Failed to resolve profile theme: ${e}`).catch(() => {});
            });
        return () => { cancelled = true; };
    }, [currentProfile, globalProfile, systemTheme]);

    // Clear the sampled edge background whenever the active tab changes, so a
    // previously fullscreen TUI's color doesn't bleed into the next tab. The
    // active terminal will re-report its own value shortly after.
    useEffect(() => {
        setEdgeBg(null);
    }, [currentId]);

    // Effective background. A forced bg (theme mode system/light/dark) wins
    // over everything — the whole window, including the terminal canvas, takes
    // that color so the mode is visually consistent. Otherwise: TUI edge color
    // if present (and spread enabled), else terminal theme bg.
    const activeEdgeBg = forceBg ? null : (enabled ? edgeBg : null);
    const effectiveBg = forceBg ?? activeEdgeBg ?? currentTheme?.background;
    // Resolved light/dark decision. With a dark override (theme mode system/
    // light/dark) the rendering follows the mode even if the bg color says
    // otherwise (e.g. a light TUI bg spreading while mode is "dark"). Without
    // an override, derive from the bg as before.
    const resolvedDark = darkOverride ?? isColorDark(effectiveBg ?? "#000000");
    // Effective foreground: always pick a readable contrast color for the
    // EFFECTIVE background, regardless of theme mode. Text legibility must
    // follow the bg's real luminance — forcing fg to match the mode (e.g. white
    // text under "always dark" while the bg is actually light) makes text
    // unreadable. When a TUI overrides the bg, contrast against that; otherwise
    // prefer the resolved contrast color, falling back to the theme's fg.
    const effectiveFg = effectiveBg
        ? foregroundFor(effectiveBg)
        : currentTheme?.foreground;
    // Theme object with bg/fg overridden to the effective values, so children
    // that read theme.background / theme.foreground stay consistent.
    const effectiveTheme = currentTheme
        ? {...currentTheme, background: effectiveBg ?? currentTheme.background, foreground: effectiveFg ?? currentTheme.foreground}
        : currentTheme;

    // Sync HeroUI theme class with the resolved light/dark decision. When a
    // fullscreen TUI sets its own background and no override is active, the
    // decision follows that color; with an override it follows the mode.
    useEffect(() => {
        if (!effectiveBg) return;
        const root = document.documentElement;
        root.classList.toggle("dark", resolvedDark);
        root.classList.toggle("light", !resolvedDark);
        root.setAttribute("data-theme", resolvedDark ? "dark" : "light");
    }, [effectiveBg, resolvedDark]);

    return {
        theme: effectiveTheme,
        bg: effectiveBg,
        fg: effectiveFg,
        dark: resolvedDark,
        isSpread: activeEdgeBg !== null,
        setEdgeBg,
    };
}
