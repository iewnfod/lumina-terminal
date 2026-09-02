/**
 * Hot-reload re-resolution for live terminal profiles.
 *
 * useTerminalManager stores each tab's profile as the RESOLVED snapshot
 * produced at creation time (parseProfile: global defaults merged, themePath
 * expanded into an inline theme). When the user edits config.profiles or the
 * global profile — via the settings UI or by hand-editing config.toml —
 * running tabs must see the change. This walks the live snapshot map,
 * re-resolves each entry against the fresh sources by profile name, and
 * returns the updated map (or null when nothing changed, so the caller can
 * skip a pointless state write).
 *
 * Deliberately generic and dependency-free (structural `{name}` typing only)
 * so `node --test` can load it directly, without the Tauri/xterm import
 * graph that lib/term.ts pulls in.
 */

/**
 * Re-resolve every live entry by name against `sources`.
 *  - An entry whose profile was deleted or renamed away KEEPS its snapshot:
 *    editing a profile must never kill its running tabs.
 *  - Entries whose re-resolved content is unchanged keep the same object;
 *    an all-unchanged pass returns null.
 * `resolve` is invoked once per matched entry, in insertion order.
 */
export async function reResolveByName<T extends {name: string}>(
    entries: Record<string, T>,
    sources: readonly T[],
    resolve: (source: T) => Promise<T>,
): Promise<Record<string, T> | null> {
    const ids = Object.keys(entries);
    if (ids.length === 0) return null;
    const byName = new Map<string, T>(sources.map((source) => [source.name, source]));
    let changed = false;
    const next: Record<string, T> = {...entries};
    for (const id of ids) {
        const snapshot = entries[id];
        const source = byName.get(snapshot.name);
        if (!source) continue;
        const resolved = await resolve(source);
        if (JSON.stringify(resolved) === JSON.stringify(snapshot)) continue;
        next[id] = resolved;
        changed = true;
    }
    return changed ? next : null;
}
