import {useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type RefObject} from "react";
import {emit, emitTo} from "@tauri-apps/api/event";
import {cursorPosition, getCurrentWindow} from "@tauri-apps/api/window";
import {info} from "@tauri-apps/plugin-log";
import {ABOUT_TAB_ID, SETTINGS_TAB_ID} from "../constants.ts";
import {
    DRAG_END_EVENT,
    DRAG_HOVER_EVENT,
    DRAG_START_EVENT,
    TAB_DRAG_MIME,
    type TabDragHover,
} from "../lib/tearoff.ts";
import {mountTabDragOverlay} from "../lib/tabDragOverlay.ts";
import {dropTargetFor, reorderByDrop} from "../lib/tabReorder.ts";
import {useTauriListen} from "./useTauriListen.ts";

interface TabDragControllerOptions {
    /** Tab ids in list order (the props order, not the drag preview). */
    tabIds: string[];
    /** Commit a reorder for `id` at `beforeId` (null for the end). */
    onReorder?: (id: string, beforeId: string | null) => void;
    /** Tear a terminal tab off — merge into another window or spawn a new one. */
    onTearOff?: (id: string, opts?: {mergeTarget?: string; position?: {x: number; y: number}}) => void;
    /** App-owned ref tracking the last hover heartbeat during a drag from this
     *  window. Foreign windows set `merge: true` only over their sidebar;
     *  content drops set `merge: false` (cancel). */
    mergeTargetRef?: RefObject<TabDragHover | null>;
    /** App-owned ref where the last in-window cursor screen position (CSS px)
     *  during a drag is recorded; dragend positions a torn-off window there. */
    dragScreenPosRef?: RefObject<{x: number; y: number} | null>;
}

/**
 * The sidebar tab drag domain, extracted from TabBar.tsx so the component is
 * pure rendering. One HTML5 drag serves two outcomes: dropped INSIDE the
 * list it reorders (live preview order, committed on drop); released OUTSIDE
 * it tears off / merges (cross-window heartbeat via Tauri events). Also owns
 * the sentinel side: while ANOTHER Lumina window drags a tab, this window
 * mounts a full-window overlay and reports hover so the source can merge.
 */
export function useTabDragController(options: TabDragControllerOptions) {
    const {tabIds, onReorder, onTearOff, mergeTargetRef, dragScreenPosRef} = options;

    // The tab being dragged FROM this window (null for foreign/external drags,
    // which must not reorder anything).
    const [draggingId, setDraggingId] = useState<string | null>(null);
    // Live preview of the order while dragging: the rows rearrange under the
    // cursor so the user sees the result before releasing. Held locally and
    // committed to the real tab list only on drop, so a drag doesn't re-render
    // the whole app on every crossing. null = not dragging, render props order.
    const [previewIds, setPreviewIds] = useState<string[] | null>(null);
    // Scroll container; its `[data-tab-id]` children are measured on dragover.
    const listRef = useRef<HTMLDivElement | null>(null);
    // Sidebar root — the sentinel uses its bounding rect to decide merge vs
    // cancel, and clearStuckHover pokes its pointer-events.
    const sidebarRef = useRef<HTMLDivElement | null>(null);
    // Throttles the preview's rect measurement — dragover fires continuously
    // and each pass forces layout. Reset on every dragstart so it can never
    // eat a new gesture's first event; the drop handler measures unthrottled,
    // so this only bounds how often the preview re-renders.
    const lastMeasureRef = useRef(0);
    // Set by a drop inside the sidebar so the dragend below skips tear-off
    // dispatch. Named for the gesture outcome (a drop was handled) rather than
    // for reordering: a no-op drop back into the source's own slot still sets
    // this, because "released inside the list" must never tear off.
    const dropHandledRef = useRef(false);
    // Escape during a drag cancels the WHOLE gesture — dragend must skip both
    // the reorder fallback AND tear-off (see dragend below).
    const dragCancelledRef = useRef(false);
    // Mirrors of drag state for dragend: the row's onDragEnd closure can be
    // stale relative to the latest preview, and WebKit sometimes zeros
    // clientX/Y on dragend while the last dragover still knew the point.
    const previewIdsRef = useRef<string[] | null>(null);
    const lastDragClientRef = useRef<{x: number; y: number} | null>(null);
    previewIdsRef.current = previewIds;
    // Cleanup for the overlay + listeners attached during a drag we started.
    // Kept in a ref so onDragEnd always reaches the latest cleanup across renders.
    const dragCleanupRef = useRef<(() => void) | null>(null);

    // Sentinel mode: while ANOTHER Lumina window is dragging a tab, THIS window
    // mounts a full-window overlay and reports hover via DRAG_HOVER_EVENT.
    // `merge: true` only when the cursor is over our sidebar; over terminal /
    // title bar / settings we report `merge: false` so the source cancels
    // instead of merging or spawning a window on top of our content.
    // Armed only when the drag started elsewhere; stands down on DRAG_END_EVENT.
    const disarmRef = useRef<(() => void) | undefined>(undefined);
    // Stand the overlay down when this window goes away mid-drag.
    useEffect(() => () => disarmRef.current?.(), []);
    useTauriListen<{sourceLabel: string}>(DRAG_START_EVENT, (payload) => {
        const myLabel = getCurrentWindow().label;
        const sourceLabel = payload?.sourceLabel;
        if (!sourceLabel || sourceLabel === myLabel) return; // source is us
        disarmRef.current?.();
        let lastReport = 0;
        disarmRef.current = mountTabDragOverlay((ev) => {
            const now = Date.now();
            if (now - lastReport < 120) return;
            lastReport = now;
            const rect = sidebarRef.current?.getBoundingClientRect();
            // Collapsed sidebar (width 0) never accepts merge.
            const overSidebar = !!rect
                && rect.width > 0
                && ev.clientX >= rect.left
                && ev.clientX <= rect.right
                && ev.clientY >= rect.top
                && ev.clientY <= rect.bottom;
            emitTo(sourceLabel, DRAG_HOVER_EVENT, {label: myLabel, merge: overSidebar}).catch((e) =>
                info(`Failed to emit hover to ${sourceLabel}: ${e}`).catch(() => {})
            );
        });
        info(`Sentinel armed for source ${sourceLabel}`);
    });
    useTauriListen(DRAG_END_EVENT, () => {
        disarmRef.current?.();
        disarmRef.current = undefined;
    });

    // Rows to render: the drag preview when one is in flight, otherwise the
    // props order.
    const orderedIds = previewIds ?? tabIds;
    // Latest-order mirror. The handlers below are memoized on stable deps
    // (draggingId / onReorder), so they outlive renders — a `landingOrder`
    // captured by closure would freeze the order at the render the callback
    // was created in, and reorderByDrop's from/to indices (which must refer to
    // the same list the DOM rects were measured against) would go stale: drops
    // would commit against the mount-time tab list and previews could jump by
    // one when crossing the item's original slot. Reading through the ref
    // keeps every call path (dragover preview, drop commit, dragend fallback)
    // on the CURRENT order.
    const orderedIdsRef = useRef(orderedIds);
    orderedIdsRef.current = orderedIds;

    /**
     * The order that would result from releasing tab `id` at `clientY`, paired
     * with the order currently on screen. `next === order` means nothing would
     * move (reorderByDrop hands back its input for a no-op).
     */
    const landingOrder = (id: string, clientY: number) => {
        const rects = Array.from(
            listRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [],
        ).map((row) => row.getBoundingClientRect());
        const order = orderedIdsRef.current.slice();
        const next = reorderByDrop(order, order.indexOf(id), dropTargetFor(rects, clientY));
        return {order, next};
    };

    // ---- Reorder drop zone ----
    // Bound to the WHOLE sidebar, not just the scrollable tab list. Dragging a
    // tab to the very top means passing over the sidebar's header row; if that
    // counted as leaving, the preview would snap back and a release there would
    // land on no drop target at all. Rows are still measured from listRef, so a
    // pointer above every row resolves to the first slot and one below them all
    // resolves to the last.
    const handleDragOver = useCallback((e: ReactDragEvent) => {
        // Only drags started on our own tabs reorder. A drag from another
        // Lumina window never reaches us as a DOM drag (merging goes over
        // Tauri events, and that window covers us with the sentinel overlay),
        // and external file drags must fall through untouched.
        if (!draggingId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        lastDragClientRef.current = {x: e.clientX, y: e.clientY};
        const now = Date.now();
        if (now - lastMeasureRef.current < 25) return;
        lastMeasureRef.current = now;
        const {order, next} = landingOrder(draggingId, e.clientY);
        // Nothing would move — bailing here is what keeps the rows from
        // oscillating around a boundary.
        if (next === order) return;
        setPreviewIds(next);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draggingId]);

    const handleDragLeave = useCallback((e: ReactDragEvent) => {
        // dragleave also fires when the pointer crosses into a child element,
        // which would undo the preview constantly. Decide by geometry rather
        // than relatedTarget — WebKitGTK often reports the latter as null even
        // for an inside-to-inside move.
        const rect = e.currentTarget.getBoundingClientRect();
        const inside = e.clientX >= rect.left && e.clientX <= rect.right
            && e.clientY >= rect.top && e.clientY <= rect.bottom;
        if (inside) return;
        // Left the sidebar — the gesture is heading for a tear-off, so let the
        // rows animate back to where they started.
        setPreviewIds(null);
    }, []);

    /** Commit a reorder for `id` at viewport `clientY`. Shared by `drop` and
     *  the dragend fallback when WebKit skips the drop event. */
    const commitReorderAt = useCallback((id: string, clientY: number) => {
        const {next} = landingOrder(id, clientY);
        const index = next.indexOf(id);
        const beforeId = index >= 0 ? next[index + 1] ?? null : null;
        dropHandledRef.current = true;
        onReorder?.(id, beforeId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onReorder]);

    /**
     * HTML5 drag never synthesizes mouseleave for rows the pointer crossed, so
     * CSS `:hover` / `group-hover` (and framer whileHover) can stick after
     * drop. Briefly disabling hit-testing forces the engine to clear them;
     * the next real mousemove re-applies hover only under the cursor.
     */
    const clearStuckHover = useCallback(() => {
        const el = sidebarRef.current;
        if (!el) return;
        el.style.pointerEvents = "none";
        requestAnimationFrame(() => {
            el.style.pointerEvents = "";
        });
    }, []);

    const handleDrop = useCallback((e: ReactDragEvent) => {
        if (!draggingId) return;
        e.preventDefault();
        // Resolve the landing slot from the release point rather than trusting
        // the preview. The preview is throttled, so a quick flick can end
        // before it ever moved, and a drag that briefly left the sidebar has no
        // preview at all — in both cases the drop must still land at the cursor.
        setPreviewIds(null);
        commitReorderAt(draggingId, e.clientY);
    }, [draggingId, commitReorderAt]);

    // Spread onto each tab row: starts the drag (reorder preview +, for
    // terminal tabs, the tear-off heartbeat machinery) and ends it (reorder
    // commit / fallback, or tear-off / merge / cancel dispatch).
    const rowDragProps = useCallback((id: string) => ({
        draggable: true as const,
        onDragStart: (e: ReactDragEvent) => {
            const isTerminalTab = id !== SETTINGS_TAB_ID && id !== ABOUT_TAB_ID;
            setDraggingId(id);
            // Seed the preview with the current order so dragover only ever
            // rearranges a live array.
            setPreviewIds(tabIds.slice());
            // Re-arm the throttle: it is per-drag, not global. Leaving the
            // previous gesture's timestamp in place would swallow this drag's
            // first dragover, and a short flick may not get another one.
            lastMeasureRef.current = 0;
            lastDragClientRef.current = null;
            dropHandledRef.current = false;
            dragCancelledRef.current = false;
            // effectAllowed + setData are required for the browser to start a
            // drag — without them the browser treats this as an empty drag and
            // NEVER fires dragover/drop, so the reorder preview would not work
            // for any tab. Must run for every tab (incl. Settings/About)
            // before the early return below. Use a proprietary MIME only —
            // `text/plain` makes macOS Finder drop a .textClipping on the
            // Desktop and lets text fields treat the gesture as copy/paste.
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData(TAB_DRAG_MIME, id);
            // Settings/About have no standalone-window semantics, so the
            // tear-off/merge heartbeat stops here — they only reorder.
            if (!isTerminalTab) return;
            // Clear any stale merge target from a previous drag — only
            // heartbeats during THIS drag count.
            if (mergeTargetRef) mergeTargetRef.current = null;
            if (dragScreenPosRef) dragScreenPosRef.current = null;
            dragCleanupRef.current?.();
            // Document dragover (with preventDefault) still refreshes the
            // self-heartbeat over non-canvas chrome. Over xterm/WebGL it is
            // unreliable on macOS — dragend uses screenX/Y + cursorPosition.
            const myLabel = getCurrentWindow().label;
            const onDragOver = (ev: DragEvent) => {
                ev.preventDefault();
                if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
                lastDragClientRef.current = {x: ev.clientX, y: ev.clientY};
                if (mergeTargetRef) {
                    mergeTargetRef.current = {
                        label: myLabel,
                        time: Date.now(),
                        merge: false,
                    };
                }
                if (dragScreenPosRef) {
                    dragScreenPosRef.current = {x: ev.screenX, y: ev.screenY};
                }
            };
            const onKeyDown = (ev: KeyboardEvent) => {
                if (ev.key === "Escape") dragCancelledRef.current = true;
            };
            document.addEventListener("dragover", onDragOver);
            document.addEventListener("keydown", onKeyDown);
            dragCleanupRef.current = () => {
                document.removeEventListener("dragover", onDragOver);
                document.removeEventListener("keydown", onKeyDown);
            };
            info(`dragstart: broadcasting ${DRAG_START_EVENT} sourceLabel=${myLabel}`);
            emit(DRAG_START_EVENT, {sourceLabel: myLabel}).catch((err) =>
                info(`Failed to broadcast ${DRAG_START_EVENT}: ${err}`).catch(() => {})
            );
        },
        onDragEnd: (e: ReactDragEvent) => {
            const isTerminalTab = id !== SETTINGS_TAB_ID && id !== ABOUT_TAB_ID;
            // dragCleanupRef holds the document listeners a terminal-tab
            // dragstart attached; for a Settings/About drag it's null. Guarded
            // so the broadcast/tear-off path runs for terminal tabs only, but
            // the shared reorder cleanup below it runs for every tab.
            if (isTerminalTab) {
                dragCleanupRef.current?.();
                dragCleanupRef.current = null;
                emit(DRAG_END_EVENT).catch((err) =>
                    info(`Failed to broadcast ${DRAG_END_EVENT}: ${err}`).catch(() => {})
                );
            }
            // A drop inside the sidebar already consumed this gesture. The
            // heartbeat below would resolve to "cancel" anyway, but being
            // explicit keeps a dropped tab from ever being torn off by a stale
            // heartbeat.
            if (dropHandledRef.current) {
                dropHandledRef.current = false;
                setDraggingId(null);
                setPreviewIds(null);
                clearStuckHover();
                return;
            }
            // Live preview moves the drag-source node in the DOM (React
            // reorders by key). On WebKitGTK that often suppresses the `drop`
            // event entirely — preview looks right, then dragend clears it and
            // the list snaps back. If we still have a preview (dragleave would
            // have cleared it on the way out) and the user didn't hit Escape,
            // commit from the release point here.
            const preview = previewIdsRef.current;
            const point = (e.clientX === 0 && e.clientY === 0)
                ? lastDragClientRef.current
                : {x: e.clientX, y: e.clientY};
            if (
                preview
                && !dragCancelledRef.current
                && onReorder
                && point
            ) {
                info(`dragend fallback reorder (drop event missing) id=${id}`);
                commitReorderAt(id, point.y);
                dropHandledRef.current = false;
                setDraggingId(null);
                setPreviewIds(null);
                clearStuckHover();
                return;
            }
            setDraggingId(null);
            setPreviewIds(null);
            clearStuckHover();
            // Escape cancels the WHOLE gesture, not just the reorder fallback
            // above — without this guard a drag that left the sidebar and was
            // then Escape-cancelled would fall through to tear-off
            // (endInsideSelf=false → action="new").
            if (dragCancelledRef.current) {
                info(`dragend cancelled by Escape → skip tear-off`);
                return;
            }
            // Settings/About tabs are reorder-only; they never tear off into
            // their own window.
            if (!isTerminalTab || !onTearOff) return;
            // Capture release coords sync from the DragEvent (always present,
            // unlike mid-drag dragover which dies over xterm on macOS WebKit).
            const endScreen = {x: e.screenX, y: e.screenY};
            // Prefer DragEvent.screenX/Y for "still over us": during an HTML5
            // drag on macOS, Tauri's cursorPosition() often still reports a
            // point inside the source window even after release on the desktop
            // — that falsely cancelled every tear-off.
            const endInsideSelf =
                endScreen.x >= window.screenX
                && endScreen.x < window.screenX + window.outerWidth
                && endScreen.y >= window.screenY
                && endScreen.y < window.screenY + window.outerHeight;
            void (async () => {
                const HOVER_FRESH_MS = 400;
                const now = Date.now();
                const mt = mergeTargetRef?.current ?? null;
                const myLabel = getCurrentWindow().label;
                let action: "merge" | "new" | "cancel";
                let mergeTarget: string | null = null;
                if (mt && now - mt.time <= HOVER_FRESH_MS) {
                    if (mt.label === myLabel || !mt.merge) {
                        action = "cancel";
                    } else {
                        action = "merge";
                        mergeTarget = mt.label;
                    }
                } else {
                    action = "new";
                }
                if (mergeTargetRef) mergeTargetRef.current = null;
                if (dragScreenPosRef) dragScreenPosRef.current = null;

                // Stale heartbeat + release still over us → cancel (do not
                // spawn on top of ourselves).
                if (action === "new" && endInsideSelf) {
                    action = "cancel";
                    info(`dragend release still inside window → cancel`);
                }

                // Place the new window at the release point. Prefer Tauri
                // cursor (physical→logical) when available; otherwise
                // DragEvent.screenX/Y.
                let dropPos = endScreen;
                if (action === "new") {
                    try {
                        const win = getCurrentWindow();
                        const [cursor, factor] = await Promise.all([
                            cursorPosition(),
                            win.scaleFactor(),
                        ]);
                        dropPos = {
                            x: cursor.x / factor,
                            y: cursor.y / factor,
                        };
                    } catch (err) {
                        info(`dragend cursorPosition failed, using screenX/Y: ${err}`).catch(() => {});
                    }
                }

                info(`dragend dispatch: action=${action} mergeTarget=${mergeTarget} lastHeartbeatMs=${mt ? now - mt.time : -1} lastLabel=${mt?.label ?? "<none>"} merge=${mt?.merge ?? false} myLabel=${myLabel} dropPos=${dropPos.x},${dropPos.y} endInsideSelf=${endInsideSelf}`);
                if (action === "merge" && mergeTarget) {
                    info(`Drag → merge tab ${id} into ${mergeTarget}`);
                    onTearOff(id, {mergeTarget});
                } else if (action === "new") {
                    info(`Drag → tear off tab ${id} into new window at ${dropPos.x},${dropPos.y}`);
                    onTearOff(id, {position: dropPos});
                }
            })();
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [tabIds, onReorder, onTearOff, commitReorderAt, clearStuckHover]);

    return {
        draggingId,
        orderedIds,
        sidebarRef,
        listRef,
        sidebarDragProps: {
            onDragOver: handleDragOver,
            onDragLeave: handleDragLeave,
            onDrop: handleDrop,
        },
        rowDragProps,
    };
}
