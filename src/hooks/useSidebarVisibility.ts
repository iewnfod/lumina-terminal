import {useCallback, useEffect, useRef, useState} from "react";
import type {GlobalConfig} from "../types/config.ts";
import {useCliArgs} from "./useCliArgs.ts";

/**
 * Sidebar visibility chain: the `showTabBar` setting drives it, unless a
 * one-shot CLI override (--sidebar show|hide) is active. `sidebarOverride` is
 * local state, so the CLI flag NEVER writes config.toml. Any explicit change
 * (toggle button / binding / palette / settings page) drops the override and
 * persists as usual.
 *
 * Extracted from App.tsx (the chain was ~70 lines of the composition root).
 * The CLI flag applies to the main window only — cliArgs is process-global,
 * so without the isMainWindow gate tear-off windows would inherit it.
 */
export function useSidebarVisibility(
    config: GlobalConfig,
    updateConfig: (partial: Partial<GlobalConfig>) => Promise<void>,
    isMainWindow: boolean,
): {
    tabBarVisible: boolean;
    /** The single write path for sidebar visibility: every toggle (binding,
     *  title-bar button, in-term action, command palette) goes through here
     *  so an active CLI override is always dropped before persisting. */
    setTabBarVisible: (visible: boolean) => void;
    toggleTabBar: () => void;
} {
    const [sidebarOverride, setSidebarOverride] = useState<boolean | null>(null);
    // Resolve the override chain: explicit toggle (local override) → one-shot
    // CLI flag (main window only) → the persisted setting.
    const cliArgs = useCliArgs();
    const cliSidebar = isMainWindow ? cliArgs?.sidebar : undefined;
    const tabBarVisible = sidebarOverride
        ?? (cliSidebar === "show" ? true : cliSidebar === "hide" ? false : null)
        ?? (config.showTabBar ?? false);

    const setTabBarVisible = useCallback((visible: boolean) => {
        setSidebarOverride(null);
        updateConfig({showTabBar: visible});
    }, [updateConfig]);
    const toggleTabBar = useCallback(() => {
        setTabBarVisible(!tabBarVisible);
    }, [tabBarVisible, setTabBarVisible]);

    // Also drop the override when the setting is changed through the settings
    // page (the toggles above clear it directly — writing the same value
    // again wouldn't be observed by this effect).
    const showTabBarRef = useRef(config.showTabBar);
    useEffect(() => {
        if (showTabBarRef.current !== config.showTabBar) {
            showTabBarRef.current = config.showTabBar;
            setSidebarOverride(null);
        }
    }, [config.showTabBar]);

    return {tabBarVisible, setTabBarVisible, toggleTabBar};
}
