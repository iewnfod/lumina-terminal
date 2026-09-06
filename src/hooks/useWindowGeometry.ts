import {useCallback, useEffect, useRef} from "react";
import type {Event} from "@tauri-apps/api/event";
import {getCurrentWindow, PhysicalPosition, PhysicalSize} from "@tauri-apps/api/window";
import {info, debug, error} from "@tauri-apps/plugin-log";
import {useGlobalConfig} from "./config.tsx";
import {useIsWayland} from "./useIsWayland.ts";
import {useTauriSubscription} from "./useTauriListen.ts";
import {notifyInitialWindowSizeSettled} from "../lib/initialWindowSize.ts";

/**
 * Main-window geometry: restore saved position/size on startup, then persist
 * position/size back to config on move/resize. Tear-off windows are
 * transient (positioned by createTearoffWindow), so this is a no-op for them.
 *
 * Wayland forbids knowing/setting absolute window position, so the position
 * restore + persist paths are short-circuited there (they'd only ever read
 * and write 0,0). Size is unaffected.
 *
 * The restore is gated to run at most once per window lifetime; toggling the
 * settings later does NOT re-jump the window.
 */
export function useWindowGeometry(isMainWindow: boolean) {
    const {config, updateConfig, isLoading} = useGlobalConfig();
    const isWayland = useIsWayland();

    // True while the startup geometry restore is applying setPosition/setSize.
    // The onMoved/onResized listeners skip while this is set, so restoring the
    // saved geometry doesn't get written straight back (feedback loop). Cleared
    // on a short timeout after the restore calls return.
    const applyingRestoredGeometryRef = useRef(false);
    // Guards the restore effect to run at most once per window lifetime.
    const restoredGeometryOnceRef = useRef(false);

    // One-shot restore: when config has loaded and either toggle is on, apply
    // the saved position/size before the user sees the window. When a SIZE is
    // restored, this path owns the initial window size: the Term / empty-state
    // sizers skip for it (see their skipForRemembered guards) and it is this
    // effect that releases the main window's show gate once the restore has
    // settled (lib/initialWindowSize.ts), so the window appears at the
    // remembered size rather than resizing after it is shown. Gated by
    // restoredGeometryOnceRef so toggling the settings later does NOT re-jump
    // the window — restore is strictly a startup behavior.
    useEffect(() => {
        if (!isMainWindow) return;
        if (restoredGeometryOnceRef.current) return;
        // Must not run before the config store resolves: DEFAULT_CONFIG has
        // both remember* toggles off, so acting on it would consume the
        // once-guard above without restoring anything, and the re-run after
        // load would bail on the guard — the saved geometry would never apply.
        if (isLoading) return;
        restoredGeometryOnceRef.current = true;

        const wantPos = !isWayland && config.rememberWindowPosition && config.rememberedWindowPosition;
        const wantSize = config.rememberWindowSize && config.rememberedWindowSize;
        if (!wantPos && !wantSize) return;

        applyingRestoredGeometryRef.current = true;
        const win = getCurrentWindow();
        const tasks: Promise<unknown>[] = [];
        if (wantPos) {
            const {x, y} = config.rememberedWindowPosition!;
            tasks.push(win.setPosition(new PhysicalPosition(x, y)));
            info(`Restoring main window position: ${x},${y}`);
        }
        if (wantSize) {
            const {width, height} = config.rememberedWindowSize!;
            tasks.push(win.setSize(new PhysicalSize(width, height)));
            info(`Restoring main window size: ${width}x${height}`);
        }
        Promise.all(tasks).catch((e) =>
            error(`Failed to restore main window geometry: ${e}`).catch(() => {})
        ).finally(() => {
            // Release the show gate once the remembered size has landed (or
            // failed — the gate must never hold the window hidden). Position-
            // only restores leave the gate to the sizers, which run normally.
            if (wantSize) notifyInitialWindowSizeSettled();
            // Release the feedback-lock after the OS has settled the move/resize
            // events our calls produced. 200ms is generous for compositor dispatch.
            setTimeout(() => {
                applyingRestoredGeometryRef.current = false;
            }, 200);
        });
    }, [config, isMainWindow, isWayland, isLoading]);

    // Runtime persistence: while either toggle is on, write position/size back
    // to config on move/resize. Skips writes during the startup restore
    // (applyingRestoredGeometryRef) and when the value hasn't changed (avoid
    // spurious writes + secondary feedback). Re-arms only when the toggles
    // flip — the last-known geometry is read via refs so a write doesn't
    // re-arm (which would churn listeners on every move tick).
    const lastPosRef = useRef(config.rememberedWindowPosition);
    lastPosRef.current = config.rememberedWindowPosition;
    const lastSizeRef = useRef(config.rememberedWindowSize);
    lastSizeRef.current = config.rememberedWindowSize;
    const subscribeMoved = useCallback(
        (handler: (event: Event<PhysicalPosition>) => void) => getCurrentWindow().onMoved(handler),
        [],
    );
    const subscribeResized = useCallback(
        (handler: (event: Event<PhysicalSize>) => void) => getCurrentWindow().onResized(handler),
        [],
    );
    // Position is untrackable on Wayland (onMoved yields 0,0), so never arm
    // the move listener there — otherwise it'd persist garbage.
    const rememberPos = isMainWindow && !isWayland && config.rememberWindowPosition;
    const rememberSize = isMainWindow && config.rememberWindowSize;
    useTauriSubscription(rememberPos ? subscribeMoved : null, ({payload}) => {
        if (applyingRestoredGeometryRef.current) return;
        const next = {x: payload.x, y: payload.y};
        const prev = lastPosRef.current;
        if (prev && prev.x === next.x && prev.y === next.y) return;
        updateConfig({rememberedWindowPosition: next});
        debug(`Persisted main window position: ${next.x},${next.y}`);
    }, "main-window move listener");
    useTauriSubscription(rememberSize ? subscribeResized : null, ({payload}) => {
        if (applyingRestoredGeometryRef.current) return;
        const next = {width: payload.width, height: payload.height};
        const prev = lastSizeRef.current;
        if (prev && prev.width === next.width && prev.height === next.height) return;
        updateConfig({rememberedWindowSize: next});
        debug(`Persisted main window size: ${next.width}x${next.height}`);
    }, "main-window resize listener");
}
