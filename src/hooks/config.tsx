import {createContext, ReactNode, useContext, useEffect, useRef, useState} from "react";
import {Binding, GlobalConfig} from "../types/config.ts";
import {TerminalProfile} from "../types/terminal.ts";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {appDataDir} from "@tauri-apps/api/path";
import {readTextFile, watch} from "@tauri-apps/plugin-fs";
import {CONFIG_SAVE_PATH, DEFAULT_CONFIG} from "../constants.ts";
import {readConfigDocument, writeConfigDocument, getConfigFilePath} from "../lib/configFile.ts";
import {parseConfigToml, semanticEqual} from "../lib/configFormat.ts";
import { info, debug, error, warn } from "@tauri-apps/plugin-log";

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

/**
 * One-time migration for `profileLastOpened`: the empty-state recency map is
 * runtime state, not a user setting, and now lives in profile-usage.json (see
 * lib/profileUsage.ts). Strip the legacy key so it disappears from the user's
 * config.toml; recency history rebuilds naturally as profiles are opened.
 * Idempotent by construction — safe to call on every load.
 */
function stripLegacyProfileLastOpened(config: GlobalConfig): GlobalConfig {
    if (config.profileLastOpened === undefined) return config;
    const {profileLastOpened: _legacy, ...rest} = config;
    info("Migrated profileLastOpened out of config.toml (recency is now tracked in profile-usage.json)");
    return rest;
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
            let loadedConfig = DEFAULT_CONFIG;
            const result = await readConfigDocument();
            if (result.kind === "loaded") {
                loadedConfig = { ...loadedConfig, ...result.config };
            } else if (result.kind === "absent") {
                // First run: materialize config.toml with the defaults so
                // users can discover and hand-edit it.
                saveConfig(loadedConfig);
            }
            // "unreadable": run on defaults but leave the broken file alone.
            let migrated = migrateLegacyCopyWithCtrl(loadedConfig);
            migrated = stripLegacyProfileLastOpened(migrated);
            if (migrated !== loadedConfig) {
                // The one-time migration changed something — persist it so
                // the legacy flag is stripped from the file for good.
                saveConfig(migrated);
                loadedConfig = migrated;
            }
            // NOTE: a successful plain load does NOT write back — the file is
            // only written on first run, migrations, and real config changes.
            // (When a write does happen, renderConfigToml patches the existing
            // document in place, so hand-written order and comments survive.)
            setConfig(loadedConfig);
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

    // The exact text of our most recent successful write. The hot-reload
    // watcher compares incoming file content against it to recognize (and
    // skip) the app's own writes, so saving never loops back into a reload.
    const lastWrittenTextRef = useRef<string | null>(null);
    // Config write operations currently in flight. While any write is
    // mid-flight the hot-reload watcher re-arms instead of reading: reading
    // then would race our own half-applied write and misclassify it.
    const writesInFlightRef = useRef(0);
    // Mirror of the current config state for non-reactive readers (the
    // watcher's semantic-equality guard).
    const configRef = useRef(config);
    configRef.current = config;

    const saveConfig = (newConfig: GlobalConfig): Promise<void> => {
        // Resolve once the flush to disk has settled (success or failure).
        // The write rejects on errors; we log and swallow so a disk hiccup
        // never throws into callers — the Promise resolves either way, which
        // lets the session close hook await durability before destroying the
        // window.
        writesInFlightRef.current++;
        return writeConfigDocument(newConfig).then(
            (text) => {
                lastWrittenTextRef.current = text;
                writesInFlightRef.current--;
            },
            (e: unknown) => {
                writesInFlightRef.current--;
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

    // Hot reload: watch the app data dir for config.toml edits and apply
    // them live. The directory (not the file) is watched so editors that
    // save via atomic rename still surface — a file watch would follow the
    // replaced inode and go quiet. Reload is guarded three ways so the
    // app's own writes NEVER loop back into a state churn:
    //  1. writes in flight → re-arm and wait (no read races our own write);
    //  2. text identical to our last write → our own completed write;
    //  3. parsed content semantically equal to the current state → skip.
    // Guard 3 is the load-bearing one: the byte-level record (2) can miss
    // after racing writes, and ANY setConfig — even with identical content
    // — replaces every config-derived object reference, which re-seeds all
    // settings drafts and wipes the user's unsaved UI edits. A broken
    // hand-edit keeps the current state with a warn (the same "never
    // overwrite a bad file" semantics as the startup loader). Runs once
    // config has loaded; tear-off windows each run their own watcher and
    // converge independently (this also gives cross-window config sync —
    // a window whose state already matches the new content skips silently).
    useEffect(() => {
        if (isLoading) return;
        let disposed = false;
        let unwatch: (() => void) | undefined;
        let debounce: ReturnType<typeof setTimeout> | undefined;
        const scheduleReload = () => {
            if (debounce !== undefined) clearTimeout(debounce);
            // Editors and our own writer can each fire several events per
            // save; collapse them into one deferred read.
            debounce = setTimeout(() => {
                debounce = undefined;
                if (writesInFlightRef.current > 0) {
                    // A write is mid-flight; its completion event may have
                    // fired already, so re-arm ourselves rather than read a
                    // half-raced state.
                    scheduleReload();
                    return;
                }
                getConfigFilePath().then((configPath) => readTextFile(configPath)).then((text) => {
                    if (text === lastWrittenTextRef.current) return;
                    const parsed = parseConfigToml(text) as unknown as GlobalConfig;
                    let merged = migrateLegacyCopyWithCtrl({...DEFAULT_CONFIG, ...parsed});
                    merged = stripLegacyProfileLastOpened(merged);
                    if (semanticEqual(merged, configRef.current)) return;
                    setConfig(merged);
                    info("Config hot-reloaded from disk").catch(() => {});
                }).catch((e: unknown) => {
                    warn(`Config hot-reload failed (keeping current state): ${e}`).catch(() => {});
                });
            }, 300);
        };
        appDataDir().then((dataDir) => watch(dataDir, (event) => {
            if (!event.paths?.some((p) => p.endsWith(CONFIG_SAVE_PATH))) return;
            scheduleReload();
        })).then((unwatchFn) => {
            if (disposed) unwatchFn();
            else unwatch = unwatchFn;
        }).catch((e: unknown) => {
            error(`Failed to watch the config file for hot reload: ${e}`).catch(() => {});
        });
        return () => {
            disposed = true;
            unwatch?.();
            if (debounce !== undefined) clearTimeout(debounce);
        };
    }, [isLoading]);

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

    // Children mount only once the real config has loaded. The window is
    // still hidden at that point (the show() below fires on the same
    // isLoading flip), so this renders nothing visible — it just prevents a
    // wasted DEFAULT_CONFIG render pass (profiles=[] → a full WelcomePage
    // tree that config arrival immediately discards) and keeps side-effect
    // hooks in App (update check, proxy/MCP watchers) from acting on default
    // values the user may have turned off.
    return (
        <GlobalConfigContext.Provider value={{config, updateConfig, newProfile, isLoading}}>
            {isLoading ? null : children}
        </GlobalConfigContext.Provider>
    );
}
