/**
 * Profile-launcher domain API (sibling to terminalApi.ts / commandIconApi.ts):
 * invoke wrappers for the backend's launcher generation
 * (src-tauri/src/launchers.rs) plus the config→spec derivation that feeds
 * it. The backend regenerates every launcher from the full spec list on
 * each call (idempotent overwrite + prune of orphaned files), so callers
 * just re-run {@link syncLaunchersFromConfig} after any config save.
 */
import {info} from "@tauri-apps/plugin-log";
import {invokeLogged} from "./apiCore.ts";
import {LauncherIconPayload, resolveLauncherIcon} from "./launcherIcon.ts";
import {GlobalConfig} from "../types/config.ts";

/** One launcher to generate — mirrors the Rust `LauncherSpec`
 *  (serde camelCase in src-tauri/src/launchers.rs). */
export interface LauncherSpec {
    /** Profile name for `--profile`. */
    profile: string;
    /** Display name + `-T` title; empty = profile name (backend decides). */
    title: string;
    workingDirectory?: string;
    sidebar?: "show" | "hide";
    icon?: LauncherIconPayload;
}

/** What a sync did — mirrors the Rust `LauncherSyncReport`. */
export interface LauncherSyncReport {
    created: string[];
    removed: string[];
    dir: string;
}

/** Regenerate every launcher in `specs` and prune orphaned ones. */
export function syncProfileLaunchers(specs: LauncherSpec[]): Promise<LauncherSyncReport> {
    return invokeLogged<LauncherSyncReport>("sync_profile_launchers", {specs}, {
        message: "Failed to sync profile launchers",
    });
}

/** The directory launchers are written to on this platform (created if
 * missing) — for the settings page's "open launcher folder" action. */
export function getLauncherDir(): Promise<string> {
    return invokeLogged<string>("get_launcher_dir", {}, {
        message: "Failed to resolve the launcher directory",
    });
}

/** Derive the full spec list from a config: one spec per profile that has
 * a `launcher` section. Async because icon payloads may fetch SVGs and
 * rasterize PNGs. */
export async function launcherSpecsFromConfig(
    config: Pick<GlobalConfig, "profiles" | "commandIcons">,
): Promise<LauncherSpec[]> {
    const specs: LauncherSpec[] = [];
    for (const profile of config.profiles) {
        if (!profile.launcher) continue;
        specs.push({
            profile: profile.name,
            title: profile.launcher.title?.trim() || "",
            workingDirectory: profile.launcher.workingDirectory?.trim() || undefined,
            sidebar: profile.launcher.sidebar ?? "hide",
            icon: await resolveLauncherIcon(profile, config),
        });
    }
    return specs;
}

/** The save/delete hook: rebuild specs from the given (already-committed)
 * profiles and hand them to the backend. Empty spec list = remove all
 * launchers, so deleting a profile (or turning the feature off) cleans up
 * on the next save. Fire-and-forget — rejections are logged inside the
 * wrappers, the UI never blocks on launcher generation. */
export function syncLaunchersFromConfig(
    config: Pick<GlobalConfig, "profiles" | "commandIcons">,
): void {
    launcherSpecsFromConfig(config)
        .then((specs) => syncProfileLaunchers(specs))
        .then((report) => {
            info(
                `Profile launchers synced: ${report.created.length} created/updated, ` +
                    `${report.removed.length} removed`,
            ).catch(() => {});
        })
        .catch(() => {
            // Already logged by syncProfileLaunchers/resolveLauncherIcon.
        });
}
