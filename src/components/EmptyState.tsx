import {Kbd} from "@heroui/react";
import {motion} from "framer-motion";
import {useMemo, type CSSProperties} from "react";
import Icon from "../assets/icon.svg";
import {useI18n} from "../hooks/i18n.tsx";
import {profileNewTabShortcut} from "../lib/bindings.ts";
import {fadeSlideUp, staggerContainer, whileHoverTap} from "../lib/motion.ts";
import {getShellType} from "../lib/shellIcon.ts";
import type {Binding} from "../types/config.ts";
import type {TerminalProfile} from "../types/terminal.ts";
import ShellIcon from "./ShellIcon.tsx";

export interface EmptyStateProps {
    /** Text color (the effective foreground) — matches Settings/About, which
     *  receive `effectiveFg` from App. */
    foregroundColor: string;
    /** Profiles to offer as quick-launch entries. */
    profiles: TerminalProfile[];
    /** Parsed bindings — used to derive each profile's "new tab" shortcut hint
     *  (the default uses the generic binding; others use their profile-specific
     *  binding), sharing one source of truth with the command palette (§3.2). */
    bindings: Binding[];
    /** Open a new tab with the given profile. */
    onNewTab: (profile: TerminalProfile) => void;
}

/**
 * Shown in the main content area when the last tab is closed while "keep window
 * on last tab closed" is on (so the window stays but `ids` is empty). Fills the
 * otherwise-blank chrome glass with a centered profile quick-launch list, so the
 * user can get back to work in one click — the default profile also shows its
 * shortcut hint, which is the fastest path now that global hotkeys are live in
 * this state.
 *
 * The whole surface is a window drag region (`data-tauri-drag-region`); the
 * profile buttons are interactive, so clicks still open a tab (Tauri skips
 * interactive children of a drag region).
 */
export default function EmptyState({foregroundColor, profiles, bindings, onNewTab}: EmptyStateProps) {
    const t = useI18n();
    // Default profile first — it's the one the generic new-tab shortcut opens.
    const ordered = useMemo(() => {
        const def = profiles.find((p) => p.default) ?? profiles[0];
        if (!def) return [];
        return [def, ...profiles.filter((p) => p !== def)];
    }, [profiles]);

    return (
        <motion.div
            data-tauri-drag-region
            variants={staggerContainer(0.05, 0.04)}
            initial="hidden"
            animate="show"
            className="h-full w-full flex flex-col items-center justify-center gap-6 select-none p-10 text-center"
        >
            <motion.img
                variants={fadeSlideUp}
                alt=""
                src={Icon}
                className="h-20 w-20 rounded-2xl pointer-events-none"
            />
            <motion.div variants={fadeSlideUp} className="flex flex-col items-center gap-1.5 pointer-events-none">
                <h2 className="text-lg font-semibold" style={{color: foregroundColor}}>
                    {t["Welcome to Lumina Term"]}
                </h2>
                <p className="text-sm opacity-60" style={{color: foregroundColor}}>
                    {t["Choose a profile to start"]}
                </p>
            </motion.div>
            <motion.div
                variants={fadeSlideUp}
                className="flex flex-col gap-1 w-full max-w-sm max-h-[40vh] overflow-y-auto px-2 pb-2"
            >
                {ordered.map((profile) => {
                    const shortcut = profileNewTabShortcut(bindings, profile);
                    return (
                        <motion.button
                            key={profile.name}
                            type="button"
                            onClick={() => onNewTab(profile)}
                            {...whileHoverTap}
                            className="flex flex-row items-center gap-3 w-full px-4 py-2.5 rounded-[var(--radius-md)] cursor-pointer text-left hover:bg-[var(--es-row-hover)]"
                            style={{
                                color: foregroundColor,
                                "--es-row-hover": "rgba(128,128,128,0.16)",
                            } as CSSProperties}
                        >
                            <ShellIcon shell={getShellType(profile)} size={18} />
                            <span className="text-sm grow truncate">{profile.name}</span>
                            {shortcut && shortcut.length > 0 && (
                                <div className="flex items-center gap-0.5 select-none opacity-70">
                                    {shortcut.map((key, j) => (
                                        <Kbd key={j}>
                                            {key.abbr ? (
                                                <Kbd.Abbr
                                                    // @ts-ignore
                                                    keyValue={key.abbr}
                                                />
                                            ) : null}
                                            <Kbd.Content>{key.content}</Kbd.Content>
                                        </Kbd>
                                    ))}
                                </div>
                            )}
                        </motion.button>
                    );
                })}
            </motion.div>
        </motion.div>
    );
}
