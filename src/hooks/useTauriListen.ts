import {useEffect, useRef} from "react";
import {listen} from "@tauri-apps/api/event";
import type {Event} from "@tauri-apps/api/event";
import {error} from "@tauri-apps/plugin-log";

/**
 * Subscribe to a Tauri event for the lifetime of the mounting component (or
 * until `event` changes). Replaces the hand-rolled
 * `let unlisten; listen(...).then(...).catch(...)` cleanup idiom that had
 * drifted across Term/TabBar/App/useTerminalManager — including the
 * `cancelled` guard some copies were missing: without it, a component that
 * unmounts before the listen() promise resolves leaks its listener forever.
 *
 * The handler is kept fresh through a ref, so callers may close over live
 * state without re-subscribing; mirror values into refs when the handler must
 * observe the latest render.
 */
export function useTauriListen<T>(event: string, handler: (payload: T) => void): void {
    // Latest-ref so the handler always sees the current closure without
    // tearing down and re-registering the listener on every render.
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let cancelled = false;
        listen<T>(event, (e) => handlerRef.current(e.payload)).then((un) => {
            // Unmounted before the subscription resolved — release it now.
            if (cancelled) un();
            else unlisten = un;
        }).catch((e) => {
            error(`Failed to listen for "${event}": ${e}`).catch(() => {});
        });
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [event]);
}

/**
 * Attach any Tauri-style subscription — `window.onMoved`/`onResized`/
 * `onFocusChanged`/`onCloseRequested`, `webview.onDragDropEvent`, … — i.e.
 * anything shaped `(handler) => Promise<unlisten>`. Same lifetime and
 * cancelled guard as useTauriListen. Pass `null` to attach conditionally:
 * nothing is subscribed, and a previously attached subscription is released.
 *
 * `subscribe` re-runs only when its identity changes, so memoize it
 * (useCallback) keyed on whatever gates it — e.g. the remember-toggles in
 * useWindowGeometry.
 */
export function useTauriSubscription<T>(
    subscribe: ((handler: (event: T) => void) => Promise<() => void>) | null,
    handler: (event: T) => void,
    label: string,
): void {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => {
        if (!subscribe) return;
        let unlisten: (() => void) | undefined;
        let cancelled = false;
        subscribe((event) => handlerRef.current(event)).then((un) => {
            if (cancelled) un();
            else unlisten = un;
        }).catch((e) => {
            error(`${label}: subscription failed: ${e}`).catch(() => {});
        });
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [subscribe, label]);
}

/** Convenience re-export so conditional subscribers can type their handlers
 *  without importing from @tauri-apps/api/event separately. */
export type {Event};
