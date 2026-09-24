import {useEffect, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {error} from "@tauri-apps/plugin-log";

// Module-level cache: the session type never changes during an app run, so we
// resolve the backend `is_wayland` call once and reuse the result for every
// caller. Mirrors the useShells/useSshConfig caching pattern.
let cached: boolean | null = null;
let pending: Promise<boolean> | null = null;

/**
 * True when the app is running under a Wayland session; `undefined` while the
 * one-shot backend probe is still in flight. Wayland forbids clients from
 * knowing or setting their absolute window position, so features depending on
 * that (notably "remember window position") should hide themselves when this
 * is true. Consumers that only branch on the final answer should treat
 * `undefined` as "not yet known" — e.g. by waiting (the geometry restore
 * below) — rather than guessing `false`, which would consume one-shot
 * Wayland guards before the probe lands.
 */
export function useIsWayland(): boolean | undefined {
    const [isWayland, setIsWayland] = useState<boolean | undefined>(cached ?? undefined);

    useEffect(() => {
        if (cached !== null) {
            setIsWayland(cached);
            return;
        }
        if (!pending) {
            pending = invoke<boolean>("is_wayland")
                .then((result) => {
                    cached = result;
                    return result;
                })
                .catch((e) => {
                    // Fall back to false (assume not Wayland) so features stay
                    // visible rather than vanishing on a probe failure.
                    error(`Failed to probe Wayland session: ${e}`).catch(() => {});
                    cached = false;
                    return false;
                });
        }
        pending.then(setIsWayland);
    }, []);

    return isWayland;
}
