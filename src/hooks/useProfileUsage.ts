import {useCallback, useEffect, useRef, useState} from "react";
import {loadProfileLastOpened, saveProfileLastOpened} from "../lib/profileUsage.ts";

/**
 * The per-profile "last opened" recency map, backed by profile-usage.json via
 * {@link lib/profileUsage.ts} (a dedicated store, NOT the user's config.toml).
 *
 * Loads once on mount; `record` stamps a profile as just-opened, updates the
 * in-memory map immediately so rapid successive opens never lose earlier
 * stamps, and persists asynchronously (failures are logged in the lib).
 * Consumed by useTerminalManager, which exposes the map for App → EmptyState's
 * recency sort.
 */
export function useProfileUsage(): {
    lastOpened: Record<string, number>;
    record: (profileName: string) => void;
} {
    const [lastOpened, setLastOpened] = useState<Record<string, number>>({});
    // Ref mirror so record() never reads a stale map across rapid successive
    // opens (the ref is updated immediately, ahead of the async persist).
    const lastOpenedRef = useRef<Record<string, number>>({});

    useEffect(() => {
        let cancelled = false;
        loadProfileLastOpened().then((map) => {
            if (cancelled) return;
            // Merge over the loaded map in case a record() landed before the
            // load resolved — its stamp must not be clobbered.
            const merged = {...map, ...lastOpenedRef.current};
            lastOpenedRef.current = merged;
            setLastOpened(merged);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const record = useCallback((profileName: string) => {
        const next = {...lastOpenedRef.current, [profileName]: Date.now()};
        lastOpenedRef.current = next;
        setLastOpened(next);
        saveProfileLastOpened(next);
    }, []);

    return {lastOpened, record};
}
