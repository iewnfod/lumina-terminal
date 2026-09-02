import {appDataDir, join} from '@tauri-apps/api/path';
import {exists, readTextFile, rename, writeTextFile} from '@tauri-apps/plugin-fs';
import {openPath} from "@tauri-apps/plugin-opener";
import {error, info, warn} from "@tauri-apps/plugin-log";
import {
    CONFIG_SAVE_PATH,
    LEGACY_CONFIG_BACKUP_PATH,
    LEGACY_CONFIG_SAVE_PATH,
} from "../constants.ts";
import {GlobalConfig} from "../types/config.ts";
import {parseConfigToml, renderConfigToml, unwrapLegacyJson} from "./configFormat.ts";

/**
 * Config-file IO — the read/migrate/write orchestration around
 * {@link lib/configFormat.ts} (pure parsing). The user's config lives in
 * `config.toml` (a plain TOML document, NOT a plugin-store file). The
 * legacy `config.json` is still parsed (both the old plugin-store wrapper
 * and a plain JSON root) and migrated on first read; after a successful
 * migration the old file is renamed to `config.json.bak` so nothing is
 * lost and it is clearly retired.
 */

export async function getConfigFilePath() {
    const dataDir = await appDataDir();
    return await join(dataDir, CONFIG_SAVE_PATH);
}

export async function openConfigFile() {
    const configPath = await getConfigFilePath();
    await openPath(configPath);
}

/** Outcome of {@link readConfigDocument}. */
export type ConfigFileResult =
    /** A config document was read (or migrated) — merge over defaults. */
    | {kind: "loaded"; config: GlobalConfig}
    /** Neither config.toml nor config.json exists — first run. */
    | {kind: "absent"}
    /** A file exists but could not be parsed. Run on defaults and do NOT
     *  write: overwriting would destroy the user's hand-edited file. */
    | {kind: "unreadable"};

/**
 * Read the user's config from disk, never throwing: IO/parse failures are
 * logged here and surfaced as "unreadable" so the caller can fall back to
 * defaults. Priority: config.toml wins; a leftover config.json is ignored
 * (running an old build again would have written it — its changes are not
 * resurrected). Migration (json → toml + .bak rename) only happens when
 * config.toml is absent, and is retried on the next launch if it fails.
 */
export async function readConfigDocument(): Promise<ConfigFileResult> {
    const dataDir = await appDataDir();
    const tomlPath = await join(dataDir, CONFIG_SAVE_PATH);
    const jsonPath = await join(dataDir, LEGACY_CONFIG_SAVE_PATH);

    if (await exists(tomlPath)) {
        try {
            const config = parseConfigToml(await readTextFile(tomlPath)) as unknown as GlobalConfig;
            info(`Loaded config from ${CONFIG_SAVE_PATH}`);
            return {kind: "loaded", config};
        } catch (e) {
            error(`Failed to parse ${CONFIG_SAVE_PATH} (${e}) — running on defaults; the broken file is left untouched`).catch(() => {});
            return {kind: "unreadable"};
        }
    }

    if (await exists(jsonPath)) {
        try {
            const config = unwrapLegacyJson(await readTextFile(jsonPath)) as unknown as GlobalConfig;
            await writeTextFile(tomlPath, renderConfigToml(undefined, config));
            try {
                await rename(jsonPath, await join(dataDir, LEGACY_CONFIG_BACKUP_PATH));
            } catch (e) {
                // The config itself is safe in config.toml now; a leftover
                // config.json is inert (toml wins) — just note it.
                warn(`Migrated config but could not rename legacy ${LEGACY_CONFIG_SAVE_PATH} to ${LEGACY_CONFIG_BACKUP_PATH}: ${e}`).catch(() => {});
            }
            info(`Migrated legacy ${LEGACY_CONFIG_SAVE_PATH} to ${CONFIG_SAVE_PATH} (backup: ${LEGACY_CONFIG_BACKUP_PATH})`);
            return {kind: "loaded", config};
        } catch (e) {
            error(`Failed to read or migrate legacy ${LEGACY_CONFIG_SAVE_PATH} (${e}) — running on defaults; the file is left untouched`).catch(() => {});
            return {kind: "unreadable"};
        }
    }

    return {kind: "absent"};
}

/**
 * Persist the config as a TOML document. The existing document is patched
 * in place (see renderConfigToml in lib/configFormat.ts) so hand-written
 * key order, layout and comments survive the write; only when the current
 * file no longer parses does the save fall back to regenerating it from
 * scratch (logged — the broken layout is unsalvageable anyway). Throws on
 * IO failure — the caller (hooks/config.tsx saveConfig) logs and swallows.
 * Last-write-wins.
 */
export async function writeConfigDocument(config: GlobalConfig): Promise<void> {
    const configPath = await getConfigFilePath();
    const existing = (await exists(configPath)) ? await readTextFile(configPath) : undefined;
    let text: string;
    try {
        text = renderConfigToml(existing, config);
    } catch (e) {
        warn(`${CONFIG_SAVE_PATH} no longer parses (${e}); regenerating it from scratch — hand-written layout/comments will be lost`).catch(() => {});
        text = renderConfigToml(undefined, config);
    }
    await writeTextFile(configPath, text);
}
