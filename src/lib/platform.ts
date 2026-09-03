import {platform} from "@tauri-apps/plugin-os";

export function isMacOS() {
    return platform() === "macos";
}

export function isLinux() {
    return platform() === "linux";
}

export function isWindows() {
    return platform() === "windows";
}
