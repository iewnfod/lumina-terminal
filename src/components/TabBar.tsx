import {useEffect, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type RefObject} from "react";
import {AnimatePresence, motion} from "framer-motion";
import { Plus, X, Settings, Info, Sparkles } from "lucide-react";
import Icon from "../assets/icon.svg";
import { isMacOS } from "../lib/platform.ts";
import {ABOUT_TAB_ID, CHROME_TITLE_BAR_HEIGHT, SETTINGS_TAB_ID} from "../constants.ts";
import { useSurfaceColors } from "../hooks/surfaceColors.ts";
import {useGlass} from "../hooks/useGlass.ts";
import {glassSurface} from "../lib/glass.ts";
import {springSoft, whileHoverTap} from "../lib/motion.ts";
import {useI18n} from "../hooks/i18n.tsx";
import ShellIcon from "./ShellIcon.tsx";
import AppIcon from "./AppIcon.tsx";
import {ShellType} from "../lib/shellIcon.ts";
import {AppIconId} from "../lib/appIcon.ts";
import {isColorDark} from "../lib/color.ts";
import {info} from "@tauri-apps/plugin-log";
import {emit, emitTo, listen} from "@tauri-apps/api/event";
import {cursorPosition, getCurrentWindow} from "@tauri-apps/api/window";
import {
    DRAG_END_EVENT,
    DRAG_HOVER_EVENT,
    DRAG_START_EVENT,
    TAB_DRAG_MIME,
    type TabDragHover,
} from "../lib/tearoff.ts";
import {mountTabDragOverlay} from "../lib/tabDragOverlay.ts";
import {dropTargetFor, reorderByDrop} from "../lib/tabReorder.ts";

export interface TabInfo {
    id: string;
    name: string;
    /** Optional small subtitle shown under the title (e.g. running command). */
    subtitle?: string;
    /** When true, the running command is a privileged/elevated operation
     * (sudo/su/doas/pkexec or root); a red dot is shown before it. */
    commandPrivileged?: boolean;
    /** Shell category used to pick the leading tab icon. Falls back to the
     * generic terminal icon when absent. Ignored for Settings/About tabs. */
    shellType?: ShellType;
    /** App brand icon shown when a recognized app is running in this terminal.
     * Takes precedence over {@link shellType}; absent → shell icon is used.
     * Computed by App from the running command (see `lib/appIcon.ts`). */
    appIcon?: AppIconId;
}

interface TabBarProps {
    tabs: TabInfo[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onNew: () => void;
    /** Called when the user drags a terminal tab out of the window and
     * releases it. `opts.mergeTarget` (another window's label) → merge into
     * that window; `opts.position` (screen CSS px) → place a new window's
     * top-left there; absent → spawn a new window at the OS default. Ignored
     * for Settings/About. */
    onTearOff?: (id: string, opts?: {mergeTarget?: string; position?: {x: number; y: number}}) => void;
    /** Called when a tab is dropped back inside this sidebar to reorder it.
     * `beforeId` is the tab it should sit in front of, or null for the end. */
    onReorder?: (id: string, beforeId: string | null) => void;
    /** App-owned ref tracking the last hover heartbeat during a drag from
     * this window. Foreign windows set `merge: true` only over their sidebar;
     * content drops set `merge: false` (cancel). Passed down so TabBar
     * doesn't re-derive it. */
    mergeTargetRef?: RefObject<TabDragHover | null>;
    /** App-owned ref where the last in-window cursor screen position (CSS px)
     * during a drag is recorded. dragend reads it to position a torn-off window
     * at the release point. Passed down so TabBar doesn't re-derive it. */
    dragScreenPosRef?: RefObject<{x: number; y: number} | null>;
    backgroundColor: string;
    foregroundColor: string;
    /** Theme-aware red used for danger indicators (privileged-command dot). */
    dangerColor: string;
    /** True when the bg comes from a fullscreen TUI's spread edge color. The
     *  glass material then drops its tint so the TUI color passes through the
     *  chrome unmodified (no extra darkening/lightening). */
    bgSpread?: boolean;
    collapsed: boolean;
    /** Brand text shown in the sidebar's top-left. Falls back to "Lumina" when
     *  absent (e.g. tear-off windows, or the main window launched with no
     *  `-T/--title`). Overridden by the launch `--title` on the main window. */
    brandTitle?: string;
    defaultProfileName?: string;
    /** When set, an update is available — show a banner above "New Tab". */
    updateVersion?: string | null;
    onUpdateClick?: () => void;
}

export default function TabBar(props: TabBarProps) {
    const { tabs, activeId, onSelect, onClose, onNew, onTearOff, onReorder, mergeTargetRef, dragScreenPosRef, backgroundColor, foregroundColor, dangerColor, bgSpread, collapsed, brandTitle, defaultProfileName, updateVersion, onUpdateClick } = props;
    const t = useI18n();

    // ---- Drag-to-reorder state ----
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
    // Sidebar root — sentinel uses its bounding rect to decide merge vs cancel.
    const sidebarRef = useRef<HTMLDivElement | null>(null);

    // Sentinel mode: while ANOTHER Lumina window is dragging a tab, THIS window
    // mounts a full-window overlay and reports hover via DRAG_HOVER_EVENT.
    // `merge: true` only when the cursor is over our sidebar; over terminal /
    // title bar / settings we report `merge: false` so the source cancels
    // instead of merging or spawning a window on top of our content.
    // Armed only when the drag started elsewhere; stands down on DRAG_END_EVENT.
    useEffect(() => {
        let unlistenStart: (() => void) | undefined;
        let unlistenEnd: (() => void) | undefined;
        let cancelled = false;
        let disarm: (() => void) | undefined;
        const myLabel = getCurrentWindow().label;

        const arm = (sourceLabel: string) => {
            disarm?.();
            let lastReport = 0;
            const removeOverlay = mountTabDragOverlay((ev) => {
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
            disarm = removeOverlay;
            info(`Sentinel armed for source ${sourceLabel}`);
        };

        listen<{sourceLabel: string}>(DRAG_START_EVENT, (event) => {
            const sourceLabel = event.payload?.sourceLabel;
            if (!sourceLabel || sourceLabel === myLabel) return; // source is us
            arm(sourceLabel);
        }).then((un) => {
            if (cancelled) un();
            else unlistenStart = un;
        }).catch((e) => {
            info(`Failed to listen for ${DRAG_START_EVENT}: ${e}`).catch(() => {});
        });

        listen(DRAG_END_EVENT, () => {
            disarm?.();
            disarm = undefined;
        }).then((un) => {
            if (cancelled) un();
            else unlistenEnd = un;
        }).catch((e) => {
            info(`Failed to listen for ${DRAG_END_EVENT}: ${e}`).catch(() => {});
        });

        return () => {
            cancelled = true;
            disarm?.();
            unlistenStart?.();
            unlistenEnd?.();
        };
    }, []);

    const colors = useSurfaceColors(backgroundColor);
    const {supportsGlass} = useGlass();

    // Rows to render: the drag preview when one is in flight, otherwise the
    // props order. Mapped by id so a tab whose data changed mid-drag (e.g. its
    // running command) still renders fresh, and an id that vanished (tab
    // closed elsewhere) simply drops out.
    const orderedTabs = previewIds
        ? previewIds
            .map((id) => tabs.find((tab) => tab.id === id))
            .filter((tab): tab is TabInfo => tab !== undefined)
        : tabs;

    // The sidebar wears the glass material over the terminal canvas. On
    // platforms where backdrop-filter is unreliable (Linux/Wayland), this
    // falls back to an opaque derived surface — same visual role, no blur.
    const glass = glassSurface(backgroundColor, supportsGlass, {blurPx: 16, spread: bgSpread});

    // ---- Reorder drop zone ----
    // Bound to the WHOLE sidebar, not just the scrollable tab list. Dragging a
    // tab to the very top means passing over the sidebar's header row; if that
    // counted as leaving, the preview would snap back and a release there would
    // land on no drop target at all. Rows are still measured from listRef, so a
    // pointer above every row resolves to the first slot and one below them all
    // resolves to the last.
    /**
     * The order that would result from releasing tab `id` at `clientY`, paired
     * with the order currently on screen. `next === order` means nothing would
     * move (reorderByDrop hands back its input for a no-op).
     */
    const landingOrder = (id: string, clientY: number) => {
        const rects = Array.from(
            listRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [],
        ).map((row) => row.getBoundingClientRect());
        const order = orderedTabs.map((tab) => tab.id);
        const next = reorderByDrop(order, order.indexOf(id), dropTargetFor(rects, clientY));
        return {order, next};
    };

    const handleDragOver = (e: ReactDragEvent) => {
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
    };

    const handleDragLeave = (e: ReactDragEvent) => {
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
    };

    /** Commit a reorder for `id` at viewport `clientY`. Shared by `drop` and
     *  the dragend fallback when WebKit skips the drop event. */
    const commitReorderAt = (id: string, clientY: number) => {
        const {next} = landingOrder(id, clientY);
        const index = next.indexOf(id);
        const beforeId = index >= 0 ? next[index + 1] ?? null : null;
        dropHandledRef.current = true;
        onReorder?.(id, beforeId);
    };

    /**
     * HTML5 drag never synthesizes mouseleave for rows the pointer crossed, so
     * CSS `:hover` / `group-hover` (and framer whileHover) can stick after
     * drop. Briefly disabling hit-testing forces the engine to clear them;
     * the next real mousemove re-applies hover only under the cursor.
     */
    const clearStuckHover = () => {
        const el = sidebarRef.current;
        if (!el) return;
        el.style.pointerEvents = "none";
        requestAnimationFrame(() => {
            el.style.pointerEvents = "";
        });
    };

    const handleDrop = (e: ReactDragEvent) => {
        if (!draggingId) return;
        e.preventDefault();
        // Resolve the landing slot from the release point rather than trusting
        // the preview. The preview is throttled, so a quick flick can end
        // before it ever moved, and a drag that briefly left the sidebar has no
        // preview at all — in both cases the drop must still land at the cursor.
        setPreviewIds(null);
        commitReorderAt(draggingId, e.clientY);
    };

    return (
        <div
            ref={sidebarRef}
            className="flex flex-col h-full select-none transition-[width,min-width,opacity] duration-[var(--duration-slow)] ease-[var(--ease-spring)] overflow-hidden"
            style={{
                width: collapsed ? 0 : 180,
                minWidth: collapsed ? 0 : 180,
                ...glass,
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {/* On macOS this intentionally stays empty: the native Overlay
                traffic lights occupy this full-width chrome row. Keeping it
                equal to TitleBar prevents the first terminal tab from sliding
                underneath the window controls. */}
            <div
                data-tauri-drag-region
                className="shrink-0 px-3 flex flex-row items-center"
                style={{
                    height: CHROME_TITLE_BAR_HEIGHT,
                    color: foregroundColor,
                }}
            >
                <div className="flex flex-row items-center gap-1.5" data-tauri-drag-region>
                    {!isMacOS() && (
                        <>
                            <img
                                src={Icon}
                                alt=""
                                className="h-5 w-5 pointer-events-none"
                            />
                            <span className="text-sm font-medium truncate leading-tight">
                                {brandTitle ?? "Lumina"}
                            </span>
                        </>
                    )}
                </div>
            </div>

            <div
                ref={listRef}
                className={`flex-1 overflow-y-auto overflow-x-hidden px-1.5 ${isMacOS() ? "pt-1.5" : ""}`}
                data-tauri-drag-region
            >
                {orderedTabs.map((tab) => {
                    const isActive = tab.id === activeId;
                    // Only real terminal tabs are draggable for tear-off;
                    // Settings/About have no standalone-window semantics.
                    const isTerminalTab =
                        tab.id !== SETTINGS_TAB_ID && tab.id !== ABOUT_TAB_ID;
                    const isDragging = draggingId === tab.id;
                    return (
                        <div
                            key={tab.id}
                            data-tab-id={tab.id}
                            className="relative my-0.5 cursor-pointer"
                            style={{opacity: isDragging ? 0.4 : 1}}
                            title={tab.name}
                            // All tabs are draggable (so Settings/About can be
                            // reordered), but only terminal tabs carry the
                            // tear-off/merge machinery below.
                            draggable
                            onDragStart={(e: ReactDragEvent) => {
                                setDraggingId(tab.id);
                                // Seed the preview with the current order so
                                // dragover only ever rearranges a live array.
                                setPreviewIds(tabs.map((t) => t.id));
                                // Re-arm the throttle: it is per-drag, not
                                // global. Leaving the previous gesture's
                                // timestamp in place would swallow this drag's
                                // first dragover, and a short flick may not get
                                // another one.
                                lastMeasureRef.current = 0;
                                lastDragClientRef.current = null;
                                dropHandledRef.current = false;
                                dragCancelledRef.current = false;
                                // effectAllowed + setData are required for the
                                // browser to start a drag — without them the
                                // browser treats this as an empty drag and NEVER
                                // fires dragover/drop, so the reorder preview
                                // would not work for any tab. Must run for every
                                // tab (incl. Settings/About) before the early
                                // return below. Use a proprietary MIME only —
                                // `text/plain` makes macOS Finder drop a
                                // .textClipping on the Desktop and lets text
                                // fields treat the gesture as copy/paste.
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData(TAB_DRAG_MIME, tab.id);
                                // Settings/About have no standalone-window
                                // semantics, so the tear-off/merge heartbeat
                                // stops here — they only reorder.
                                if (!isTerminalTab) return;
                                // Clear any stale merge target from a previous
                                // drag — only heartbeats during THIS drag count.
                                if (mergeTargetRef) mergeTargetRef.current = null;
                                if (dragScreenPosRef) dragScreenPosRef.current = null;
                                dragCleanupRef.current?.();
                                // Document dragover (with preventDefault) still
                                // refreshes the self-heartbeat over non-canvas
                                // chrome. Over xterm/WebGL it is unreliable on
                                // macOS — dragend uses screenX/Y + cursorPosition.
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
                            }}
                            onDragEnd={(e: ReactDragEvent) => {
                                // dragCleanupRef holds the document listeners
                                // a terminal-tab dragstart attached; for a
                                // Settings/About drag it's null. Guarded so the
                                // broadcast/tear-off path runs for terminal tabs
                                // only, but the shared reorder cleanup below it
                                // runs for every tab.
                                if (isTerminalTab) {
                                    dragCleanupRef.current?.();
                                    dragCleanupRef.current = null;
                                    emit(DRAG_END_EVENT).catch((err) =>
                                        info(`Failed to broadcast ${DRAG_END_EVENT}: ${err}`).catch(() => {})
                                    );
                                }
                                // A drop inside the sidebar already consumed
                                // this gesture. The heartbeat below would
                                // resolve to "cancel" anyway, but being explicit
                                // keeps a dropped tab from ever being torn off by
                                // a stale heartbeat.
                                if (dropHandledRef.current) {
                                    dropHandledRef.current = false;
                                    setDraggingId(null);
                                    setPreviewIds(null);
                                    clearStuckHover();
                                    return;
                                }
                                // Live preview moves the drag-source node in the
                                // DOM (React reorders by key). On WebKitGTK that
                                // often suppresses the `drop` event entirely —
                                // preview looks right, then dragend clears it
                                // and the list snaps back. If we still have a
                                // preview (dragleave would have cleared it on
                                // the way out) and the user didn't hit Escape,
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
                                    info(`dragend fallback reorder (drop event missing) id=${tab.id}`);
                                    commitReorderAt(tab.id, point.y);
                                    dropHandledRef.current = false;
                                    setDraggingId(null);
                                    setPreviewIds(null);
                                    clearStuckHover();
                                    return;
                                }
                                setDraggingId(null);
                                setPreviewIds(null);
                                clearStuckHover();
                                // Escape cancels the WHOLE gesture, not just the
                                // reorder fallback above — without this guard a
                                // drag that left the sidebar and was then
                                // Escape-cancelled would fall through to tear-off
                                // (endInsideSelf=false → action="new").
                                if (dragCancelledRef.current) {
                                    info(`dragend cancelled by Escape → skip tear-off`);
                                    return;
                                }
                                // Settings/About tabs are reorder-only; they
                                // never tear off into their own window.
                                if (!isTerminalTab || !onTearOff) return;
                                // Capture release coords sync from the DragEvent
                                // (always present, unlike mid-drag dragover which
                                // dies over xterm on macOS WebKit).
                                const endScreen = {x: e.screenX, y: e.screenY};
                                // Prefer DragEvent.screenX/Y for "still over us":
                                // during an HTML5 drag on macOS, Tauri's
                                // cursorPosition() often still reports a point
                                // inside the source window even after release on
                                // the desktop — that falsely cancelled every tear-off.
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

                                    // Stale heartbeat + release still over us →
                                    // cancel (do not spawn on top of ourselves).
                                    if (action === "new" && endInsideSelf) {
                                        action = "cancel";
                                        info(`dragend release still inside window → cancel`);
                                    }

                                    // Place the new window at the release point.
                                    // Prefer Tauri cursor (physical→logical) when
                                    // available; otherwise DragEvent.screenX/Y.
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
                                        info(`Drag → merge tab ${tab.id} into ${mergeTarget}`);
                                        onTearOff(tab.id, {mergeTarget});
                                    } else if (action === "new") {
                                        info(`Drag → tear off tab ${tab.id} into new window at ${dropPos.x},${dropPos.y}`);
                                        onTearOff(tab.id, {position: dropPos});
                                    }
                                })();
                            }}
                        >
                            {/* Inner motion layer carries the spring scale animation.
                                Kept separate from the outer drag div because
                                motion.div redeclares onDragStart/onDragEnd for its
                                own pan system, which collides with the HTML5 tear-off
                                drag above. whileHoverTap mirrors the new-tab button
                                (springSnappy physics) for a consistent press feel.

                                `layout` is what makes reordering read as blocks
                                sliding out of the way: when the preview order
                                changes the wrapper jumps to its new slot, and
                                this layer glides there instead. Unlike motion's
                                pan gestures, layout animation is transform-only
                                and never touches pointer events, so it coexists
                                with the HTML5 drag. "position" (not full
                                layout) so rows of different heights don't get
                                their size interpolated too. */}
                            <motion.div
                                // Suppress hover/tap while a drag is in flight:
                                // the pointer crosses rows without mouseleave, so
                                // CSS :hover and framer whileHover would otherwise
                                // paint every crossed tab and can stick after drop.
                                {...(draggingId ? {} : whileHoverTap)}
                                layout="position"
                                transition={springSoft}
                                className={`lum-tab-row group relative flex flex-row items-center justify-between px-3 py-2.5 rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-base)] ease-[var(--ease-glass)] ${draggingId ? "" : "hover:bg-[var(--lum-tab-hover)]"} ${isActive ? "bg-[var(--lum-tab-active)]" : ""}`}
                                style={{
                                    "--lum-tab-hover": isActive ? colors.accentOverlay : colors.hoverOverlay,
                                    "--lum-tab-active": colors.accentOverlay,
                                } as CSSProperties}
                                onClick={() => onSelect(tab.id)}
                            >
                            <div className="flex flex-col items-start flex-1 w-[70%] overflow-hidden">
                                <div className="flex items-start gap-2 w-full">
                                    {tab.id === SETTINGS_TAB_ID && (
                                        <Settings size={14} className="shrink-0 mt-0.5" />
                                    )}
                                    {tab.id === ABOUT_TAB_ID && (
                                        <Info size={14} className="shrink-0 mt-0.5" />
                                    )}
                                    {tab.id !== SETTINGS_TAB_ID && tab.id !== ABOUT_TAB_ID && (
                                        tab.appIcon ? (
                                            <AppIcon
                                                app={tab.appIcon}
                                                dark={isColorDark(backgroundColor)}
                                                size={14}
                                                className="shrink-0 mt-0.5"
                                            />
                                        ) : (
                                            <ShellIcon
                                                shell={tab.shellType ?? "default"}
                                                size={14}
                                                className="shrink-0 mt-0.5"
                                            />
                                        )
                                    )}
                                    <div className="flex flex-col min-w-0">
                                    <span
                                        className="text-sm truncate leading-tight"
                                        style={{
                                            color: isActive ? foregroundColor : colors.inactiveText,
                                        }}
                                    >
                                        {tab.name}
                                    </span>
                                    </div>
                                </div>
                                {tab.subtitle && (
                                    <div
                                        className="text-xs leading-tight flex items-center gap-1.5 min-w-0 overflow-hidden max-w-full"
                                        style={{
                                            color: colors.inactiveText,
                                            opacity: 0.6,
                                        }}
                                    >
                                        {tab.commandPrivileged && (
                                            <span
                                                className="inline-block w-2 h-2 rounded-full shrink-0 translate-y-0.5"
                                                style={{ backgroundColor: dangerColor }}
                                                title="Privileged / elevated command"
                                            />
                                        )}
                                        <span className="truncate min-w-0 w-full">{tab.subtitle}</span>
                                    </div>
                                )}
                            </div>
                            <button
                                className={`lum-tab-close cursor-pointer opacity-0 rounded-[var(--radius-xs)] p-1 shrink-0 transition-all duration-[var(--duration-fast)] ml-1 ${draggingId ? "" : "group-hover:opacity-100 hover:bg-[var(--lum-tab-active)]"}`}
                                style={{
                                    "--lum-tab-active": colors.activeOverlay,
                                    color: isActive ? foregroundColor : colors.inactiveText,
                                } as CSSProperties}
                                // draggable={false} so a press-drag starting on the
                                // close button doesn't initiate the parent tab's
                                // HTML5 tear-off drag — a click (no movement) still
                                // closes normally via the handler below.
                                draggable={false}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onClose(tab.id);
                                }}
                            >
                                <X size={12} />
                            </button>
                            </motion.div>
                        </div>
                    );
                })}
            </div>

            <div className="shrink-0 px-1.5 pb-1.5">
                {/* Update-available banner: shows above "New Tab" when an update
                    is available. Hidden when the sidebar is collapsed (no room).
                    Wears the brand gradient (cinnabar→lavender, from the app icon)
                    via the --color-brand-gradient-soft token as a subtle accent so
                    it stands out from the neutral tab chrome. One motion element
                    carries the whole banner — spring enter/exit AND the
                    whileHoverTap scale — so the gradient frame and its content
                    scale together, same as a tab row. */}
                <AnimatePresence>
                    {!collapsed && updateVersion && (
                        <motion.div
                            initial={{opacity: 0, y: 8}}
                            animate={{opacity: 1, y: 0}}
                            exit={{opacity: 0, y: 8}}
                            transition={springSoft}
                            {...whileHoverTap}
                            className="my-1 rounded-[var(--radius-sm)] overflow-hidden cursor-pointer"
                            style={{background: "var(--color-brand-gradient-soft)"}}
                            onClick={onUpdateClick}
                            title={t["New version available: v{version}"].replace("{version}", updateVersion)}
                        >
                            <div
                                className="lum-tab-update flex flex-row items-center gap-2 w-full px-3 py-2 rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-base)] bg-white/40 hover:bg-white/20"
                                style={{color: foregroundColor}}
                            >
                                <Sparkles size={14} className="shrink-0" style={{color: "var(--color-brand-lavender)"}} />
                                <span className="text-xs truncate">
                                    {t["New version available: v{version}"].replace("{version}", updateVersion)}
                                </span>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                <motion.button
                    {...whileHoverTap}
                    className="lum-tab-new flex flex-row items-center gap-2 w-full px-3 py-2.5 mt-1 transition-colors duration-[var(--duration-fast)] cursor-pointer rounded-[var(--radius-sm)] hover:bg-[var(--lum-new-hover)]"
                    style={{
                        "--lum-new-hover": colors.hoverOverlay,
                        color: colors.inactiveText,
                    } as CSSProperties}
                    onClick={onNew}
                >
                    <Plus size={16} />
                    <div className="flex flex-col w-full justify-start items-start">
                        <span className="text-sm">{t["New Tab"]}</span>
                        {defaultProfileName && (
                            <div
                                className="text-xs truncate"
                                style={{color: colors.inactiveText, opacity: 0.5}}
                            >
                                {defaultProfileName}
                            </div>
                        )}
                    </div>
                </motion.button>
            </div>
        </div>
    );
}
