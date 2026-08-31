/**
 * Launcher icon payload resolution (the frontend half of the profile
 * "wrap as app" feature; see src-tauri/src/launchers.rs for the backend).
 *
 * Decides WHICH icon a profile's launcher should use — an explicit
 * `profile.launcher.icon` override, else the auto-derived app icon for the
 * profile's startup command (lib/appIcon.ts, user rules included) — and
 * produces it in the form the backend accepts for the host platform:
 *   - Linux    SVG text (the .desktop `Icon=` points at a vector file)
 *   - win/mac  a canvas-rasterized PNG (wrapped into .ico/.icns backend-side)
 *   - custom   `custom:<file>` icons are passed through by stored file name;
 *              the backend reads them from its own command-icons dir
 *
 * Pure logic + DOM canvas rasterization, no React (lib/ layering rule).
 */
import {getAppIconSrc} from "../assets/app-icons/index.ts";
import {customIconName, getAppIcon, isCustomIconId} from "./appIcon.ts";
import {isLinux} from "./platform.ts";
import {GlobalConfig} from "../types/config.ts";
import {TerminalProfile} from "../types/terminal.ts";

/** Icon payload for one launcher spec — mirrors the Rust `LauncherIcon`
 *  (src-tauri/src/launchers.rs): exactly one field set. */
export interface LauncherIconPayload {
    /** SVG document text. */
    svg?: string;
    /** Rasterized PNG, base64. */
    pngBase64?: string;
    /** File name inside the app's command-icons dir. */
    commandIconFile?: string;
}

/** Raster size for SVG → PNG conversion. 512 covers retina dock/menu icons;
 * the file stays small because brand SVGs compress to a few KB of PNG. */
const RASTER_SIZE = 512;

/** Rasterize an SVG document to a base64 PNG via an offscreen canvas.
 * WebKit refuses to size SVGs without intrinsic width/height, so missing
 * dimensions are injected before decoding. Rejects when the SVG fails to
 * load or the canvas is unavailable — callers treat that as "no icon". */
async function svgToPngBase64(svg: string, size = RASTER_SIZE): Promise<string> {
    if (!/<svg[^>]*\bwidth=/.test(svg)) {
        svg = svg.replace(/<svg\b/, `<svg width="${size}" height="${size}"`);
    }
    const blob = new Blob([svg], {type: "image/svg+xml"});
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("SVG failed to decode"));
            img.src = url;
        });
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("2d canvas context unavailable");
        ctx.drawImage(img, 0, 0, size, size);
        const dataUrl = canvas.toDataURL("image/png");
        return dataUrl.slice(dataUrl.indexOf(",") + 1);
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** Build the icon payload for an already-chosen icon id (built-in id or
 * `custom:<file>`). Returns undefined when the id can't be turned into a
 * payload (unknown built-in, fetch/raster failure) — the backend then uses
 * the app's own icon. */
async function iconPayloadFor(id: string): Promise<LauncherIconPayload | undefined> {
    if (isCustomIconId(id)) {
        // The backend reads custom icons from its own dir by file name —
        // svg and png both work, no frontend processing needed.
        return {commandIconFile: customIconName(id)};
    }
    const src = getAppIconSrc(id, false);
    if (!src) return undefined;
    try {
        const svg = await (await fetch(src)).text();
        // Linux writes the SVG verbatim (crisp on HiDPI); macOS/Windows
        // can't rasterize SVG backend-side, so hand over a PNG instead.
        if (isLinux()) return {svg};
        return {pngBase64: await svgToPngBase64(svg)};
    } catch {
        return undefined;
    }
}

/** Resolve the launcher icon payload for a profile: the explicit
 * `launcher.icon` override when set, else the auto-derived icon for the
 * startup command (user command→icon rules first, then the built-in
 * table), else undefined (= the app's own bundled icon). */
export async function resolveLauncherIcon(
    profile: TerminalProfile,
    config: Pick<GlobalConfig, "commandIcons">,
): Promise<LauncherIconPayload | undefined> {
    const explicit = profile.launcher?.icon?.trim();
    const id = explicit || getAppIcon(profile.startupCommand ?? "", config.commandIcons) || "";
    if (!id) return undefined;
    return iconPayloadFor(id);
}
