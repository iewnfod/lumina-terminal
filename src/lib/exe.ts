/**
 * Shared executable-name helper — the single source for extracting a
 * comparable command/executable name from a path string (previously
 * duplicated byte-for-byte in appIcon.ts and shellIcon.ts).
 */

/** Extract the executable basename (no dir, no `.exe`) from a path string. */
export function exeBasename(exe: string): string {
    const base = exe.split(/[\\/]/).pop() ?? exe;
    return base.toLowerCase().replace(/\.exe$/, "");
}
