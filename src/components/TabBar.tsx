import {type CSSProperties, type RefObject} from "react";
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
import {useTabDragController} from "../hooks/useTabDragController.ts";
import {type TabDragHover} from "../lib/tearoff.ts";
import ShellIcon from "./ShellIcon.tsx";
import AppIcon from "./AppIcon.tsx";
import {ShellType} from "../lib/shellIcon.ts";
import {AppIconId} from "../lib/appIcon.ts";
import {isColorDark} from "../lib/color.ts";

export interface TabInfo {
    id: string;
    name: string;
    /** Optional small subtitle shown under the title (e.g. running command). */
    subtitle?: string;
    /** When true, the running command is a privileged/elevated operation
     *  (sudo/su/doas/pkexec or root); a red dot is shown before it. */
    commandPrivileged?: boolean;
    /** Shell category used to pick the leading tab icon. Falls back to the
     *  generic terminal icon when absent. Ignored for Settings/About tabs. */
    shellType?: ShellType;
    /** App brand icon shown when a recognized app is running in this terminal.
     *  Takes precedence over {@link shellType}; absent → shell icon is used.
     *  Computed by App from the running command (see `lib/appIcon.ts`). */
    appIcon?: AppIconId;
}

interface TabBarProps {
    tabs: TabInfo[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onNew: () => void;
    /** Called when the user drags a terminal tab out of the window and
     *  releases it. `opts.mergeTarget` (another window's label) → merge into
     *  that window; `opts.position` (screen CSS px) → place a new window's
     *  top-left there; absent → spawn a new window at the OS default. Ignored
     *  for Settings/About. */
    onTearOff?: (id: string, opts?: {mergeTarget?: string; position?: {x: number; y: number}}) => void;
    /** Called when a tab is dropped back inside this sidebar to reorder it.
     *  `beforeId` is the tab it should sit in front of, or null for the end. */
    onReorder?: (id: string, beforeId: string | null) => void;
    /** App-owned ref tracking the last hover heartbeat during a drag from
     *  this window. Foreign windows set `merge: true` only over their sidebar;
     *  content drops set `merge: false` (cancel). Passed down so TabBar
     *  doesn't re-derive it. */
    mergeTargetRef?: RefObject<TabDragHover | null>;
    /** App-owned ref where the last in-window cursor screen position (CSS px)
     *  during a drag is recorded. dragend reads it to position a torn-off window
     *  at the release point. Passed down so TabBar doesn't re-derive it. */
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

    // The whole drag domain — reorder preview + drop commit, tear-off/merge
    // dispatch on release outside the list, and the foreign-drag sentinel —
    // lives in hooks/useTabDragController.ts. This component is pure
    // rendering: one HTML5 drag serves both outcomes.
    const {draggingId, orderedIds, sidebarRef, listRef, sidebarDragProps, rowDragProps} = useTabDragController({
        tabIds: tabs.map((tab) => tab.id),
        onReorder,
        onTearOff,
        mergeTargetRef,
        dragScreenPosRef,
    });

    const colors = useSurfaceColors(backgroundColor);
    const {supportsGlass} = useGlass();

    // Rows to render: the drag preview order when one is in flight, otherwise
    // the props order. Mapped by id so a tab whose data changed mid-drag (e.g.
    // its running command) still renders fresh, and an id that vanished (tab
    // closed elsewhere) simply drops out.
    const orderedTabs = orderedIds
        .map((id) => tabs.find((tab) => tab.id === id))
        .filter((tab): tab is TabInfo => tab !== undefined);

    // The sidebar wears the glass material over the terminal canvas. On
    // platforms where backdrop-filter is unreliable (Linux/Wayland), this
    // falls back to an opaque derived surface — same visual role, no blur.
    const glass = glassSurface(backgroundColor, supportsGlass, {blurPx: 16, spread: bgSpread});

    return (
        <div
            ref={sidebarRef}
            className="flex flex-col h-full select-none transition-[width,min-width,opacity] duration-[var(--duration-slow)] ease-[var(--ease-spring)] overflow-hidden"
            style={{
                width: collapsed ? 0 : 180,
                minWidth: collapsed ? 0 : 180,
                ...glass,
            }}
            {...sidebarDragProps}
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
                            // tear-off/merge machinery (see the controller).
                            {...rowDragProps(tab.id)}
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
                                className={`lum-tab-row group relative flex flex-row items-center justify-between px-3 py-2.5 rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-base)] ease-[var(--duration-glass)] ${draggingId ? "" : "hover:bg-[var(--lum-tab-hover)]"} ${isActive ? "bg-[var(--lum-tab-active)]" : ""}`}
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
