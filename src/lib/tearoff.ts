import {LazyStore} from "@tauri-apps/plugin-store";
import {WebviewWindow} from "@tauri-apps/api/webviewWindow";
import {LogicalPosition} from "@tauri-apps/api/dpi";
import {error, info} from "@tauri-apps/plugin-log";
import {TerminalProfile} from "../types/terminal.ts";
import {TEAROFF_STORE_PATH} from "../constants.ts";
import {isMacOS} from "./platform.ts";

/** Custom DnD MIME for tab tear-off. Do NOT also set `text/plain` — on macOS
 * that makes Finder create a .textClipping on the Desktop and lets text
 * fields treat the drag as a copy/paste. */
export const TAB_DRAG_MIME = "application/x-lumina-tab";

/**
 * Tab tear-off support — moving a live terminal tab out of its window into a
 * brand-new OS window while keeping the PTY process alive.
 *
 * Flow:
 *   1. The source window calls {@link stashTearoff} to persist the torn-off
 *      tab's profile, PTY id, and serialized scrollback under a throwaway key.
 *   2. {@link createTearoffWindow} spawns a `WebviewWindow` whose label is the
 *      same key, and whose URL is the app's own index.html.
 *   3. The new window boots the same React tree; {@link useTearoffSession}
 *      (see hooks/) detects it is a torn-off window by its label and calls
 *      {@link consumeTearoff} to read+delete the payload, then renders a
 *      single `Term` in reattach mode (replays scrollback, then
 *      `reattachTerminal` — see lib/terminalApi.ts).
 *
 * The label is both the window identity and the store key, so no separate
 * hand-off channel (deep-link / argv) is needed. `state/tearoff.json` is a
 * dedicated LazyStore — NOT the user's config.toml — so tear-off never
 * pollutes the persisted app config.
 */

export const TEAROFF_LABEL_PREFIX = "tearoff-";

// ---- Cross-window event names (single source of truth, §3.2) ----
// These couple the source/target windows of a tab drag. Keep them together so
// a rename touches one place. Names follow the `lumina-` convention used by
// OPEN_ABOUT_EVENT in App.tsx and must be alphanumeric + `-/:_`.

/** Source → all windows: a tab drag started. Payload: `{sourceLabel}`.
 * Non-source windows enter "sentinel" mode (watch their own dragenter/leave). */
export const DRAG_START_EVENT = "lumina-tab-drag-start";
/** Target (sentinel) → source: which window the cursor is currently over.
 * Payload: `{label: string, merge: boolean}` — `merge: true` only when the
 * cursor is over that window's sidebar (TabBar); `merge: false` means the
 * cursor is over the window's content (terminal / title bar / settings) and
 * the source must cancel rather than merge or spawn. */
export const DRAG_HOVER_EVENT = "lumina-tab-drag-hover";

/** Last-known hover during a tab drag (App-owned ref, written by TabBar /
 * DRAG_HOVER listeners). `merge` is only meaningful for foreign windows. */
export interface TabDragHover {
    label: string;
    time: number;
    /** True → drop should merge into `label`'s sidebar; false → cancel. */
    merge: boolean;
}
/** Source → all windows: the drag ended (any branch). Sentinels stand down. */
export const DRAG_END_EVENT = "lumina-tab-drag-end";
/** Source → target window: please accept this tab. Payload: `{stashKey, sourceLabel}`.
 * The target consumes the stashed payload (keyed by `stashKey`) and reattaches. */
export const MERGE_TAB_EVENT = "lumina-merge-tab";
/** Target → source: I consumed the tab, you may remove it from your state.
 * Payload: `{stashKey}`. Source removes its tab only after this ack. */
export const MERGE_ACK_EVENT = "lumina-merge-ack";

const store = new LazyStore(TEAROFF_STORE_PATH);

export interface TearoffPayload {
    /** Already-resolved profile (post `parseProfile`) to render in the new window. */
    profile: TerminalProfile;
    /** The live PTY id to reattach (kept alive on the backend). */
    ptyId: string;
    /** Serialized xterm buffer (from @xterm/addon-serialize), replayed on mount. */
    scrollback: string;
}

/** True if `label` follows the torn-off-window convention `tearoff-<uuid>`. */
export function isTearoffLabel(label: string): boolean {
    return label.startsWith(TEAROFF_LABEL_PREFIX);
}

/** Mint a fresh, unique torn-off window label (also used as the store key). */
export function newTearoffLabel(): string {
    return TEAROFF_LABEL_PREFIX + crypto.randomUUID();
}

/**
 * Persist a tear-off payload under `label`. The new window reads (and
 * deletes) it on boot via {@link consumeTearoff}. Failures are logged and
 * swallowed so a torn-off window's boot is never blocked by a store hiccup.
 */
export async function stashTearoff(label: string, payload: TearoffPayload): Promise<void> {
    try {
        await store.set(label, payload);
        await store.save();
        info(`Stashed tear-off payload for ${label}`);
    } catch (e) {
        error(`Failed to stash tear-off payload for ${label}: ${e}`).catch(() => {});
    }
}

/**
 * Read and delete the tear-off payload for `label` (one-shot). Returns null
 * when no payload exists (e.g. the window was opened some other way) or when
 * the store read fails — the latter is logged but not thrown so the window
 * still boots into a sane fallback state.
 */
export async function consumeTearoff(label: string): Promise<TearoffPayload | null> {
    try {
        const payload = await store.get<TearoffPayload>(label);
        if (!payload) {
            info(`No tear-off payload for ${label} (empty store key)`);
            return null;
        }
        await store.delete(label);
        await store.save();
        info(`Consumed tear-off payload for ${label}`);
        return payload;
    } catch (e) {
        error(`Failed to consume tear-off payload for ${label}: ${e}`).catch(() => {});
        return null;
    }
}

/**
 * Spawn the torn-off window. Starts hidden; the React layer calls `show()`
 * after config load — see hooks/config.tsx, which runs for every window
 * including this one. `sourceInnerSize` (the originating window's content
 * size) seeds the new window so the torn-off tab lands at a familiar size.
 *
 * Chrome mirrors the platform main-window config: on macOS that means native
 * decorations with an Overlay title bar + traffic lights (see
 * `tauri.macos.conf.json`); elsewhere we keep the custom undecorated chrome
 * that TitleBar draws itself.
 */
export async function createTearoffWindow(
    label: string,
    sourceInnerSize?: { width: number; height: number },
    position?: { x: number; y: number },
): Promise<WebviewWindow> {
    const width = Math.max(sourceInnerSize?.width ?? 900, 600);
    const height = Math.max(sourceInnerSize?.height ?? 600, 400);
    // Position the new window's top-left at the drop point when known. This is
    // the last in-window dragover screen position — Wayland forbids reading
    // the global cursor, so we can't track it after it leaves a webview, but
    // for a "thrown-out" tab the last-known position is a good approximation.
    // screenX/Y are CSS px = logical px under Tauri, matching WindowOptions.
    // Clamp so a drop near a screen edge doesn't push the window off-screen;
    // the OS would also do this, but being explicit avoids a window whose
    // title bar is unreachable on some compositors.
    const mac = isMacOS();
    const opts: Record<string, unknown> = {
        url: "index.html",
        title: "Lumina Terminal",
        width,
        height,
        minWidth: 600,
        minHeight: 400,
        transparent: true,
        // macOS: native Overlay title bar + traffic lights (matches
        // tauri.macos.conf.json). Other platforms: undecorated; TitleBar
        // draws custom window controls.
        decorations: mac,
        ...(mac
            ? {
                // TitleBarStyle JS union is lowercase; matches Overlay in
                // tauri.macos.conf.json.
                titleBarStyle: "overlay",
                hiddenTitle: true,
                // Same inset as tauri.macos.conf.json so the lights clear the
                // custom title-bar buttons (sidebar toggle).
                trafficLightPosition: {x: 18, y: 18},
            }
            : {}),
        visible: false,
        resizable: true,
        shadow: true,
    };
    // Clamp so a drop near a screen edge doesn't push the window off-screen.
    const pos = position
        ? {x: Math.max(0, position.x), y: Math.max(0, position.y)}
        : null;
    if (pos) {
        opts.x = pos.x;
        opts.y = pos.y;
    }
    const webview = new WebviewWindow(label, opts);
    // The constructor is fire-and-forget; surface creation failure (e.g.
    // capability denied) through the error event so it is never silent.
    webview.once("tauri://error", (e) => {
        error(`Failed to create tear-off window ${label}: ${e?.payload}`).catch(() => {});
    });
    // Some platforms ignore WindowOptions.x/y when `visible: false`; re-apply
    // after the surface exists so the torn-off window actually lands at the
    // release point instead of cascading over the source window.
    if (pos) {
        webview.once("tauri://created", () => {
            webview.setPosition(new LogicalPosition(pos.x, pos.y)).catch((e) =>
                error(`Failed to set tear-off window position for ${label}: ${e}`).catch(() => {})
            );
        });
    }
    info(`Creating tear-off window ${label} (${width}x${height}${pos ? ` at ${pos.x},${pos.y}` : ""}${mac ? ", mac overlay decorations" : ""})`);
    return webview;
}
