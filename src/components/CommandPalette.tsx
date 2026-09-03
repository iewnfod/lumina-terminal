import {ReactNode, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties} from "react";
import {
    Modal,
    Kbd,
    Label,
} from "@heroui/react";
import {motion} from "framer-motion";
import {
    Search,
} from "lucide-react";
import { useI18n } from "../hooks/i18n.tsx";
import { info, debug } from "@tauri-apps/plugin-log";
import {glassSurface, glassBorder, elevationShadow} from "../lib/glass.ts";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {useGlass} from "../hooks/useGlass.ts";
import {whileHoverTap} from "../lib/motion.ts";

export interface CommandAction {
    id: string;
    label: string;
    description?: string;
    icon: ReactNode;
    shortcut?: { abbr?: string; content: string }[];
    category?: string;
    keywords?: string[];
    onSelect: () => void;
}

interface CommandPaletteProps {
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;
    actions: CommandAction[];
    /** Effective background the palette floats over (from useEffectiveTheme).
     *  Drives the glass material + derived surface colors so the palette reads
     *  as part of the same chrome as the tab/title bars. */
    backgroundColor: string;
    /** Effective foreground color (readable contrast for backgroundColor). */
    foregroundColor: string;
    /** True when the bg comes from a fullscreen TUI's spread edge color — the
     *  glass drops its tint so the TUI color passes through unmodified. */
    bgSpread?: boolean;
}

export default function CommandPalette({
    isOpen,
    onOpenChange,
    actions,
    backgroundColor,
    foregroundColor,
    bgSpread,
}: CommandPaletteProps) {
    const t = useI18n();
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // Derived surface colors + glass material — single sources of truth (§3.2).
    // The palette is a floating chrome surface, so it wears the same glass +
    // elevation treatment as the tab/title bars rather than HeroUI's flat
    // bg-overlay default.
    const colors = useSurfaceColors(backgroundColor);
    const {supportsGlass} = useGlass();
    const glass = useMemo(
        () => glassSurface(backgroundColor, supportsGlass, {blurPx: 24, spread: bgSpread}),
        [backgroundColor, supportsGlass, bgSpread],
    );
    const borderColor = glassBorder(backgroundColor);
    const shadow = elevationShadow("lg");

    // Filter actions based on search query
    const filteredActions = useMemo(() => {
        if (!query.trim()) return actions;
        const lowerQuery = query.toLowerCase().trim();
        return actions.filter(
            (action) =>
                action.label.toLowerCase().includes(lowerQuery) ||
                action.description?.toLowerCase().includes(lowerQuery) ||
                action.category?.toLowerCase().includes(lowerQuery) ||
                action.keywords?.some((kw) => kw.toLowerCase().includes(lowerQuery))
        );
    }, [actions, query]);

    // Group actions by category
    const groupedActions = useMemo(() => {
        const groups = new Map<string, CommandAction[]>();
        for (const action of filteredActions) {
            const category = action.category ?? "";
            if (!groups.has(category)) {
                groups.set(category, []);
            }
            groups.get(category)!.push(action);
        }
        return groups;
    }, [filteredActions]);

    // Total flat list for keyboard navigation
    const flatActions = useMemo(() => {
        const result: CommandAction[] = [];
        for (const [, actions] of groupedActions) {
            result.push(...actions);
        }
        return result;
    }, [groupedActions]);

    // Reset state when modal opens/closes
    useEffect(() => {
        if (isOpen) {
            debug("Command palette opened");
            setQuery("");
            setSelectedIndex(0);
            // Focus the search input after a short delay for the modal animation
            setTimeout(() => {
                inputRef.current?.focus();
            }, 100);
        }
    }, [isOpen]);

    // Scroll selected item into view
    useEffect(() => {
        if (listRef.current) {
            const selectedElement = listRef.current.querySelector(
                `[data-index="${selectedIndex}"]`
            ) as HTMLElement | null;
            if (selectedElement) {
                selectedElement.scrollIntoView({ block: "nearest" });
            }
        }
    }, [selectedIndex]);

    const handleSelect = useCallback(
        (index: number) => {
            const action = flatActions[index];
            if (action) {
                info(`Command palette action selected: ${action.label}`);
                action.onSelect();
                onOpenChange(false);
            }
        },
        [flatActions, onOpenChange]
    );

    // Use a native document-level listener while the modal is open.
    // This is more reliable than React onKeyDown because it avoids issues
    // with focus trapping, portal rendering, and input event consumption.
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            switch (e.key) {
                case "ArrowDown":
                    e.preventDefault();
                    setSelectedIndex((prev) =>
                        prev < flatActions.length - 1 ? prev + 1 : 0
                    );
                    break;
                case "ArrowUp":
                    e.preventDefault();
                    setSelectedIndex((prev) =>
                        prev > 0 ? prev - 1 : flatActions.length - 1
                    );
                    break;
                case "Enter":
                    e.preventDefault();
                    handleSelect(selectedIndex);
                    break;
                case "Escape":
                    if (query) {
                        e.preventDefault();
                        e.stopPropagation();
                        setQuery("");
                    }
                    // If no query, let the modal handle close via its own Escape handler
                    break;
            }
        };

        document.addEventListener("keydown", handleKeyDown, { capture: true });
        return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
    }, [isOpen, flatActions, selectedIndex, handleSelect, query]);

    // The dialog wears the glass material. HeroUI's Modal.Dialog forwards
    // `style`, so we apply the glass + border + shadow here; the default
    // bg-overlay is overridden by our explicit background.
    const dialogStyle = {
        ...glass,
        color: foregroundColor,
        border: `1px solid ${borderColor}`,
        boxShadow: shadow,
        overflow: "hidden",
    } as CSSProperties;

    // The search field is a single recessed pill containing the leading
    // search icon + the input, so the icon sits visually inside the field
    // rather than floating beside it. Mirrors the recessed-field treatment
    // used in the settings panels.
    const searchFieldStyle = {
        background: colors.recessedBg,
        color: foregroundColor,
    } as CSSProperties;

    return (
        <Modal.Backdrop
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            isDismissable={true}
            variant="blur"
        >
            <Modal.Container placement="center">
                <Modal.Dialog className="sm:max-w-lg w-full p-0" style={dialogStyle}>
                    {/* Search header — no HeroUI padding; we own the layout so the
                        input spans the full width of the glass surface. */}
                    <Modal.Header className="p-0 m-0">
                        <div
                            className="flex items-center gap-2 w-full px-3 py-3 border-b"
                            style={{borderColor}}
                        >
                            <div
                                className="flex items-center gap-2 flex-1 min-w-0 rounded-[min(32px,var(--radius-3xl))] px-3 py-2"
                                style={searchFieldStyle}
                            >
                                <Search
                                    size={16}
                                    className="shrink-0"
                                    style={{color: colors.inactiveText}}
                                />
                                <Label className="sr-only">{t["Search commands"]}</Label>
                                <input
                                    ref={inputRef}
                                    type="text"
                                    value={query}
                                    onChange={(e) => {
                                        setQuery(e.target.value);
                                        setSelectedIndex(0);
                                    }}
                                    placeholder={t["Type a command or search..."]}
                                    className="flex-1 min-w-0 bg-transparent outline-none border-none text-sm placeholder:opacity-50"
                                    style={{color: foregroundColor}}
                                    spellCheck={false}
                                    autoComplete="off"
                                />
                            </div>
                        </div>
                    </Modal.Header>
                    <Modal.Body className="max-h-96 overflow-y-auto p-2 m-0">
                        {flatActions.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12" style={{color: colors.inactiveText}}>
                                <Search size={32} className="mb-2 opacity-40" />
                                <p className="text-sm">{t["No commands found"]}</p>
                            </div>
                        ) : (
                            <div ref={listRef} className="flex flex-col">
                                {Array.from(groupedActions.entries()).map(([category, groupActions]) => (
                                    <div key={category} className="mb-1 last:mb-0">
                                        {category ? (
                                            <div
                                                className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider select-none"
                                                style={{color: colors.inactiveText}}
                                            >
                                                {category}
                                            </div>
                                        ) : null}
                                        {groupActions.map((action) => {
                                            const index = flatActions.indexOf(action);
                                            const isSelected = index === selectedIndex;
                                            return (
                                                <motion.div
                                                    key={action.id}
                                                    data-index={index}
                                                    {...whileHoverTap}
                                                    className={`lum-cmd-item group relative flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] cursor-pointer transition-colors duration-[var(--duration-fast)] ease-[var(--ease-glass)] ${isSelected ? "" : "hover:bg-[var(--lum-cmd-hover)] active:bg-[var(--lum-cmd-active)]"}`}
                                                    style={{
                                                        background: isSelected ? colors.accentOverlay : undefined,
                                                        // Hover/active overlays via CSS vars so framer-motion's
                                                        // transform animations don't fight inline background
                                                        // mutations (same pattern as IconButton).
                                                        "--lum-cmd-hover": colors.hoverOverlay,
                                                        "--lum-cmd-active": colors.activeOverlay,
                                                    } as CSSProperties}
                                                    onClick={() => handleSelect(index)}
                                                    onMouseEnter={() => setSelectedIndex(index)}
                                                >
                                                    <div
                                                        className="shrink-0 transition-colors duration-[var(--duration-fast)]"
                                                        style={{color: isSelected ? foregroundColor : colors.inactiveText}}
                                                    >
                                                        {action.icon}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-sm font-medium truncate">
                                                            {action.label}
                                                        </div>
                                                        {action.description && (
                                                            <div
                                                                className="text-xs truncate"
                                                                style={{color: colors.inactiveText}}
                                                            >
                                                                {action.description}
                                                            </div>
                                                        )}
                                                    </div>
                                                    {action.shortcut && (
                                                        <div className="hidden sm:flex items-center gap-0.5 shrink-0 select-none">
                                                            {action.shortcut.map((key, i) => (
                                                                <Kbd key={i}>
                                                                    {key.abbr ? (
                                                                        <Kbd.Abbr
                                                                            // @ts-ignore
                                                                            keyValue={key.abbr}
                                                                        />
                                                                    ) : null}
                                                                    <Kbd.Content>{key.content}</Kbd.Content>
                                                                </Kbd>
                                                            ))}
                                                        </div>
                                                    )}
                                                </motion.div>
                                            );
                                        })}
                                    </div>
                                ))}
                            </div>
                        )}
                    </Modal.Body>
                    <Modal.Footer className="pt-0 border-t" style={{borderColor}}>
                        <div
                            className="flex items-center justify-between w-full text-xs px-3 py-2 select-none"
                            style={{color: colors.inactiveText}}
                        >
                            <div className="flex items-center gap-3">
                                <span className="flex items-center gap-1">
                                    <Kbd>
                                        <Kbd.Abbr keyValue="up" />
                                    </Kbd>
                                    <Kbd>
                                        <Kbd.Abbr keyValue="down" />
                                    </Kbd>
                                    {t["Navigate"]}
                                </span>
                                <span className="flex items-center gap-1">
                                    <Kbd>
                                        <Kbd.Abbr keyValue="enter" />
                                    </Kbd>
                                    {t["Select"]}
                                </span>
                            </div>
                            <span className="flex items-center gap-1">
                                <Kbd>
                                    <Kbd.Abbr keyValue="escape" />
                                </Kbd>
                                {t["Close"]}
                            </span>
                        </div>
                    </Modal.Footer>
                </Modal.Dialog>
            </Modal.Container>
        </Modal.Backdrop>
    );
}
