import {useMemo} from "react";
import {Terminal as TerminalIcon, X, PanelLeftClose, PanelLeftOpen, Monitor, MonitorOff, Settings as SettingsIcon, Info, ExternalLink, Search} from "lucide-react";
import type {CommandAction} from "../components/CommandPalette.tsx";
import {TerminalProfile} from "../types/terminal.ts";
import {Binding, Actions} from "../types/config.ts";
import {bindingToShortcut, findBinding, profileNewTabShortcut} from "../lib/bindings.ts";

/**
 * Build the command-palette action list from the live config + bindings + i18n.
 * Extracted from App.tsx so App composes chrome rather than hand-authoring
 * ~120 lines of action data. Pure derivation — given the same inputs it
 * returns a stable list, so it lives as a hook-backed builder rather than
 * inline JSX in the orchestrator.
 */
export function useCommandPaletteActions(opts: {
    profiles: TerminalProfile[];
    currentId: string | null;
    terminals: Record<string, TerminalProfile>;
    parsedBindings: Binding[];
    tabBarVisible: boolean;
    closeWindowOnLastTab: boolean | undefined;
    t: Record<string, string>;
    newTerminal: (profile: TerminalProfile) => void;
    closeTerminal: (id: string) => void;
    tearOffTab: (id: string) => void;
    openSettings: () => void;
    openAbout: () => void;
    openSearch: () => void;
    updateConfig: (patch: {closeWindowOnLastTab?: boolean}) => void;
    /** Single sidebar-toggle path from App (drops any active CLI override
     *  before persisting) — never toggle showTabBar via updateConfig here. */
    toggleTabBar: () => void;
}): CommandAction[] {
    const {
        profiles, currentId, terminals, parsedBindings, tabBarVisible,
        closeWindowOnLastTab, t,
        newTerminal, closeTerminal, tearOffTab, openSettings, openAbout, openSearch, updateConfig, toggleTabBar,
    } = opts;

    return useMemo(() => {
        const actions: CommandAction[] = [];
        if (!profiles.length) return actions;

        // New terminal with each profile
        const newLabel = t["New {name}"];
        const newDesc = t['Create a new terminal with profile "{name}"'];
        for (const profile of profiles) {
            actions.push({
                id: `new-terminal-${profile.name}`,
                label: newLabel.replace("{name}", profile.name),
                description: newDesc.replace("{name}", profile.name),
                icon: <TerminalIcon size={18} />,
                shortcut: profileNewTabShortcut(parsedBindings, profile),
                category: t["Terminal"],
                keywords: ["new", "terminal", "新建", profile.name],
                onSelect: () => newTerminal(profile),
            });
        }

        // Close current tab
        if (currentId) {
            const closeBinding = findBinding(parsedBindings, "closeTab");
            actions.push({
                id: "close-tab",
                label: t["Close Current Tab"],
                description: t["Close the current terminal tab"],
                icon: <X size={18} />,
                shortcut: closeBinding ? bindingToShortcut(closeBinding) : undefined,
                category: t["Terminal"],
                keywords: ["close", "关闭", "tab", "kill"],
                onSelect: () => closeTerminal(currentId),
            });

            // Tear off current tab into its own window (terminal tabs only —
            // currentId is a real terminal here because Settings/About never
            // match the `id in terminals` filter below).
            if (currentId in terminals) {
                const tearoffBinding = findBinding(parsedBindings, "tearOffTab");
                actions.push({
                    id: "tear-off-tab",
                    label: t["Tear Off Tab"],
                    description: t["Tear off tab into a new window"],
                    icon: <ExternalLink size={18} />,
                    shortcut: tearoffBinding ? bindingToShortcut(tearoffBinding) : undefined,
                    category: t["Terminal"],
                    keywords: ["tear off", "window", "窗口", "拖出", "分离", "detach", "pop out"],
                    onSelect: () => tearOffTab(currentId),
                });

                // Find in terminal (terminal tabs only).
                const searchBinding = findBinding(parsedBindings, "search");
                actions.push({
                    id: "find-in-terminal",
                    label: t["Find in Terminal"],
                    icon: <Search size={18} />,
                    shortcut: searchBinding ? bindingToShortcut(searchBinding) : undefined,
                    category: t["Terminal"],
                    keywords: ["find", "search", "查找", "搜索", "grep"],
                    onSelect: () => openSearch(),
                });
            }
        }

        // Toggle tab bar
        actions.push({
            id: "toggle-tab-bar",
            label: tabBarVisible ? t["Hide Tab Bar"] : t["Show Tab Bar"],
            description: tabBarVisible
                ? t["Hide the sidebar tab bar"]
                : t["Show the sidebar tab bar"],
            icon: tabBarVisible ? (
                <PanelLeftClose size={18} />
            ) : (
                <PanelLeftOpen size={18} />
            ),
            category: t["View"],
            keywords: ["tab bar", "标签栏", "sidebar", "toggle", "hide", "show", "隐藏", "显示"],
            onSelect: () => toggleTabBar(),
        });

        // Toggle close window on last tab
        const closeOnLast = closeWindowOnLastTab !== false;
        actions.push({
            id: "toggle-close-window-last-tab",
            label: closeOnLast ? t["Keep Window on Last Tab Closed"] : t["Close Window on Last Tab Closed"],
            description: closeOnLast
                ? t["Keep the window open after closing the last tab"]
                : t["Close the window after closing the last tab"],
            icon: closeOnLast ? (
                <MonitorOff size={18} />
            ) : (
                <Monitor size={18} />
            ),
            category: t["View"],
            keywords: ["window", "窗口", "close", "关闭", "last", "最后", "tab", "exit"],
            onSelect: () => updateConfig({ closeWindowOnLastTab: !closeOnLast }),
        });

        // Open settings
        const settingsBinding = findBinding(parsedBindings, "openSettings");
        actions.push({
            id: "open-settings",
            label: t["Settings"],
            description: t["Open Settings"],
            icon: <SettingsIcon size={18} />,
            shortcut: settingsBinding ? bindingToShortcut(settingsBinding) : undefined,
            category: t["Settings"],
            keywords: ["settings", "设置", "config", "配置", "preferences", "options"],
            onSelect: () => {
                openSettings();
            },
        });

        // Open about
        actions.push({
            id: "open-about",
            label: t["About"],
            description: t["About"],
            icon: <Info size={18} />,
            category: t["Settings"],
            keywords: ["about", "关于", "info", "version", "版本"],
            onSelect: () => {
                openAbout();
            },
        });

        return actions;
    }, [profiles, currentId, terminals, tabBarVisible, closeWindowOnLastTab, parsedBindings, t, newTerminal, closeTerminal, tearOffTab, openSettings, openAbout, openSearch, updateConfig, toggleTabBar]);
}

/** Re-export so callers can name-import the action type alongside the hook. */
export type {Actions};
