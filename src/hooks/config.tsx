import {createContext, ReactNode, useContext, useEffect, useState} from "react";
import {Binding, GlobalConfig} from "../types/config.ts";
import {LazyStore} from "@tauri-apps/plugin-store";
import {TerminalProfile} from "../types/terminal.ts";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {CONFIG_SAVE_PATH, DEFAULT_CONFIG} from "../constants.ts";
import { info, debug, error } from "@tauri-apps/plugin-log";

const store = new LazyStore(CONFIG_SAVE_PATH);

interface GlobalConfigContextType {
    config: GlobalConfig;
    /** Merge `newConfig` into the current config and persist it to disk.
     *  Returns a Promise that resolves once the store flush has settled, so
     *  callers that need the write durable before tearing down (e.g. the
     *  session close hook remembering a choice) can await it. */
    updateConfig: (newConfig: Partial<GlobalConfig>) => Promise<void>;
    newProfile: (profile: TerminalProfile) => void;
    isLoading: boolean;
}

export const GlobalConfigContext = createContext<GlobalConfigContextType | null>(null);

/**
 * One-time migration for the removed `copyWithCtrl` toggle: users who had it
 * enabled get an explicit `copy` binding on plain Ctrl+C, preserving their
 * "Ctrl+C copies" behavior now that copy is a normal user-bindable action
 * (default Ctrl/Cmd+Shift+C). The legacy flag is stripped so the migration
 * runs exactly once. Idempotent by construction — safe to call on every load.
 */
function migrateLegacyCopyWithCtrl(config: GlobalConfig): GlobalConfig {
    if (config.copyWithCtrl !== true) return config;
    const bindings: Binding[] = config.bindings ? [...config.bindings] : [];
    const alreadyBound = bindings.some(
        (b) => b.action === "copy" && b.key.toLowerCase() === "c" && b.with.includes("ctrl"),
    );
    if (!alreadyBound) {
        bindings.push({key: "c", with: ["ctrl"], action: "copy"});
    }
    const {copyWithCtrl: _legacy, ...rest} = config;
    info("Migrated legacy copyWithCtrl=true into a copy binding on Ctrl+C");
    return {...rest, bindings};
}

export function useGlobalConfig() {
    const context = useContext(GlobalConfigContext);
    if (!context) {
        throw new Error("useGlobalConfig must be used within a GlobalConfigProvider");
    }
    return context;
}

export function GlobalConfigProvider({ children }: { children: ReactNode }) {
    const [config, setConfig] = useState<GlobalConfig>(DEFAULT_CONFIG);
    const [isLoading, setIsLoading] = useState<boolean>(true);

    useEffect(() => {
        const loadConfig = async () => {
            info("Loading config...");
            const savedConfig = await store.get<GlobalConfig>("config");
            let loadedConfig = DEFAULT_CONFIG;
            if (savedConfig) {
                loadedConfig = { ...loadedConfig, ...savedConfig };
            }
            loadedConfig = migrateLegacyCopyWithCtrl(loadedConfig);
            setConfig(loadedConfig);
            store.set("config", loadedConfig).then();
            info(`Config loaded: language=${loadedConfig.language}, profiles=${loadedConfig.profiles.length}`);
            setIsLoading(false);
            // Preload the global profile's font for ligature support so the
            // first terminal (and all subsequent ones sharing the global font)
            // find it already parsed — no startup lag from findFont + loadBuffer.
            // The module-level font cache in ligatures.ts dedupes this.
            if (loadedConfig.globalProfile?.ligatures && loadedConfig.globalProfile?.fontFamily) {
                import("../lib/ligatures.ts")
                    .then(({preloadFont}) => preloadFont(loadedConfig.globalProfile!.fontFamily!))
                    .catch(() => {});
            }
        };
        loadConfig().catch((e) => {
            error(`Failed to load config: ${e}`).catch(() => {});
            setIsLoading(false);
        });
    }, []);

    const saveConfig = (newConfig: GlobalConfig): Promise<void> => {
        // Resolve once the flush to disk has settled (success or failure). The
        // store APIs reject on errors; we log and swallow so a disk hiccup
        // never throws into callers — the Promise resolves either way, which
        // lets the session close hook await durability before destroying the
        // window.
        return store.set("config", newConfig).then(() => store.save()).then(
            () => {},
            (e: unknown) => {
                error(`Failed to persist config to disk: ${e}`).catch(() => {});
            },
        );
    };

    const updateConfig = (newConfig: Partial<GlobalConfig>): Promise<void> => {
        debug(`updateConfig: ${JSON.stringify(newConfig)}`);
        // We need the *current* prevState to build the merged config before
        // persisting; capture it from the functional updater, then flush. The
        // returned Promise resolves once the disk flush settles so callers
        // (e.g. the session close hook remembering a choice) can await
        // durability before tearing down the window.
        const flush = new Promise<void>((resolve) => {
            setConfig((prevState) => {
                const updated: GlobalConfig = {...prevState, ...newConfig};
                saveConfig(updated).then(() => resolve());
                return updated;
            });
        });
        return flush;
    };

    const newProfile = (profile: TerminalProfile) => {
        setConfig((prevState) => {
            const isFirst = prevState.profiles.length === 0 && !profile.default;
            const updatedProfile = isFirst ? { ...profile, default: true } : profile;
            const updatedProfiles = [...prevState.profiles, updatedProfile];
            const updated: GlobalConfig = {...prevState, profiles: updatedProfiles};
            saveConfig(updated);
            return updated;
        });
    };

    useEffect(() => {
        if (!isLoading) {
            const window = getCurrentWindow();
            window.show().then(() => {
                window.setFocus().then(undefined, (e: unknown) => {
                    error(`Failed to set window focus: ${e}`).catch(() => {});
                });
                info("Window shown, config loaded");
            }).catch((e: unknown) => {
                error(`Failed to show window: ${e}`).catch(() => {});
            });
        }
    }, [isLoading]);

    return (
        <GlobalConfigContext.Provider value={{config, updateConfig, newProfile, isLoading}}>
            {children}
        </GlobalConfigContext.Provider>
    );
}
