import type {CSSProperties} from "react";
import {LucideMaximize, LucideMinimize, LucideMinus, LucideX, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Search, Settings} from "lucide-react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {Tooltip} from "@heroui/react";
import {ITheme} from "@xterm/xterm";
import {isMacOS} from "../lib/platform.ts";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {useGlass} from "../hooks/useGlass.ts";
import {useAlwaysOnTop} from "../hooks/useAlwaysOnTop.ts";
import {useIsWayland} from "../hooks/useIsWayland.ts";
import {useI18n} from "../hooks/i18n.tsx";
import {glassSurface} from "../lib/glass.ts";
import { info } from "@tauri-apps/plugin-log";
import IconButton from "./ui/IconButton.tsx";
import {CHROME_TITLE_BAR_HEIGHT} from "../constants.ts";

interface WindowControlProps {
    size: number;
    isMaximized: boolean;
    hoverOverlay: string;
    activeOverlay: string;
    /** Brand-tinted wash for the close button on hover. */
    closeHover: string;
    fg: string;
}

function WindowControl({size, isMaximized, hoverOverlay, activeOverlay, closeHover, fg}: WindowControlProps) {
    const handleMinimize = () => {
        info("Window minimized");
        getCurrentWindow().minimize().then();
    }

    const handleMaximize = () => {
        info("Window maximized");
        getCurrentWindow().maximize().then();
    }

    const handleUnmaximize = () => {
        info("Window unmaximized");
        getCurrentWindow().unmaximize().then();
    }

    const handleClose = () => {
        info("Window close requested");
        getCurrentWindow().close().then();
    }

    return (
        <div className="flex flex-row justify-end items-center" style={{height: size}}>
            <IconButton
                size={size}
                hoverOverlay={hoverOverlay}
                activeOverlay={activeOverlay}
                style={{color: fg, borderRadius: 0}}
                onClick={handleMinimize}
            >
                <LucideMinus size={16}/>
            </IconButton>
            {isMaximized ? (
                <IconButton
                    size={size}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    style={{color: fg, borderRadius: 0}}
                    onClick={handleUnmaximize}
                >
                    <LucideMinimize size={16}/>
                </IconButton>
            ) : (
                <IconButton
                    size={size}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    style={{color: fg, borderRadius: 0}}
                    onClick={handleMaximize}
                >
                    <LucideMaximize size={16}/>
                </IconButton>
            )}
            <IconButton
                size={size}
                hoverOverlay={closeHover}
                activeOverlay={closeHover}
                style={{color: fg, borderRadius: 0}}
                onClick={handleClose}
            >
                <LucideX size={16}/>
            </IconButton>
        </div>
    );
}

interface PinButtonProps {
    size: number;
    hoverOverlay: string;
    activeOverlay: string;
    fg: string;
    style?: CSSProperties;
}

/** Toggles "always on top" for this window. Shared by both title-bar layouts;
 *  the per-platform sizing/radius comes in as props rather than being decided
 *  here.
 *
 *  Disabled under Wayland: tao maps `setAlwaysOnTop` to GTK's keep-above hint,
 *  which only X11 honors, so the toggle would silently do nothing. Mirrors how
 *  "remember window position" hides itself on Wayland. */
function PinButton({size, hoverOverlay, activeOverlay, fg, style}: PinButtonProps) {
    const t = useI18n();
    const {pinned, toggle} = useAlwaysOnTop();
    const isWayland = useIsWayland();

    const label = isWayland
        ? t["Always on top is not supported on Wayland"]
        : pinned ? t["Unpin from Top"] : t["Pin on Top"];

    return (
        <Tooltip delay={300} closeDelay={0}>
            <Tooltip.Trigger>
                {/* The button is wrapped so the tooltip still opens on hover
                    when it is disabled — disabled buttons dispatch no pointer
                    events of their own. */}
                <span className="inline-flex">
                    <IconButton
                        size={size}
                        isActive={pinned}
                        hoverOverlay={hoverOverlay}
                        activeOverlay={activeOverlay}
                        style={{color: fg, ...style}}
                        onClick={toggle}
                        disabled={isWayland}
                        aria-label={label}
                    >
                        {pinned ? <PinOff size={18} /> : <Pin size={18} />}
                    </IconButton>
                </span>
            </Tooltip.Trigger>
            <Tooltip.Content>
                <p className="text-xs">{label}</p>
            </Tooltip.Content>
        </Tooltip>
    );
}

export default function TitleBar({
    theme,
    bgSpread,
    tabBarVisible,
    onToggleTabBar,
    onOpenCommandPalette,
    onOpenSettings,
    isMaximized,
} : {
    theme: ITheme | null,
    /** True when the bg comes from a fullscreen TUI's spread edge color —
     *  the glass drops its tint so the TUI color passes through unmodified. */
    bgSpread?: boolean,
    tabBarVisible: boolean,
    onToggleTabBar: () => void,
    onOpenCommandPalette: () => void,
    onOpenSettings: () => void,
    isMaximized: boolean,
}) {
    const t = useI18n();
    const bg = theme?.background ?? "black";
    const fg = theme?.foreground ?? "white";

    const { hoverOverlay, activeOverlay } = useSurfaceColors(bg);
    const {supportsGlass} = useGlass();
    const glass = glassSurface(bg, supportsGlass, {blurPx: 14, spread: bgSpread});
    const macOSTitleButtonMarginLeft = tabBarVisible ? 8 : 88;
    const size = CHROME_TITLE_BAR_HEIGHT;
    // Brand cinnabar wash for the close button hover — replaces the isolated
    // `text-red-500` literal with the brand accent so window controls feel
    // part of the app identity.
    const closeHover = "rgba(255,70,31,0.18)";

    if (isMacOS()) {
        return (
            <div
                data-tauri-drag-region
                className="w-full flex flex-row items-center select-none shrink-0"
                style={{
                    height: size,
                    ...glass,
                    color: fg,
                }}
            >
                <IconButton
                    size={28}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    style={{color: fg, marginLeft: macOSTitleButtonMarginLeft}}
                    onClick={() => { info(`Tab bar ${tabBarVisible ? "hidden" : "shown"}`); onToggleTabBar(); }}
                >
                    {tabBarVisible ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
                </IconButton>
                <div className="flex-1" data-tauri-drag-region />
                <PinButton
                    size={28}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    fg={fg}
                />
                <IconButton
                    size={28}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    style={{color: fg}}
                    onClick={() => { info("Command palette opened from title bar"); onOpenCommandPalette(); }}
                    aria-label={t["Command Palette"]}
                >
                    <Search size={18} />
                </IconButton>
                <IconButton
                    size={28}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    style={{color: fg, marginRight: 8}}
                    onClick={() => { info("Settings opened from title bar"); onOpenSettings(); }}
                >
                    <Settings size={18} />
                </IconButton>
            </div>
        );
    }

    return (
        <div
            data-tauri-drag-region
            className="w-full flex flex-row items-center justify-between select-none shrink-0"
            style={{
                height: size,
                ...glass,
                color: fg,
            }}
        >
            <IconButton
                size={size}
                hoverOverlay={hoverOverlay}
                activeOverlay={activeOverlay}
                style={{color: fg, borderRadius: 0}}
                onClick={() => { info(`Tab bar ${tabBarVisible ? "hidden" : "shown"}`); onToggleTabBar(); }}
            >
                {tabBarVisible ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </IconButton>
            <div className="flex-1" data-tauri-drag-region />
            <div className="flex flex-row items-center h-full">
                <PinButton
                    size={size}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    fg={fg}
                    style={{borderRadius: 0}}
                />
                <IconButton
                    size={size}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    style={{color: fg, borderRadius: 0}}
                    onClick={() => { info("Command palette opened from title bar"); onOpenCommandPalette(); }}
                    aria-label={t["Command Palette"]}
                >
                    <Search size={18} />
                </IconButton>
                <IconButton
                    size={size}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    style={{color: fg, borderRadius: 0}}
                    onClick={() => { info("Settings opened from title bar"); onOpenSettings(); }}
                >
                    <Settings size={18} />
                </IconButton>
                <WindowControl size={size} isMaximized={isMaximized} hoverOverlay={hoverOverlay} activeOverlay={activeOverlay} closeHover={closeHover} fg={fg} />
            </div>
        </div>
    );
}
