import {useEffect, useRef} from "react";
import {motion} from "framer-motion";
import type {Variants} from "framer-motion";
import {FileText, Flag, Folder, Terminal} from "lucide-react";
import type {CompletionCandidate, CompletionKind} from "../lib/completions.ts";
import {candidateLabel, completionKind} from "../lib/completions.ts";
import type {CompletionState} from "../hooks/useShellCompletions.ts";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {useGlass} from "../hooks/useGlass.ts";
import {glassSurface, elevationShadow} from "../lib/glass.ts";
import {foregroundFor} from "../lib/color.ts";
import {durationFast, easeGlass, easeSpring, durationBase} from "../lib/motion.ts";

interface CompletionPopupProps {
    /** The open popup's model (word + candidates + selection + anchor). */
    state: CompletionState;
    /** Effective background hex the popup floats over (App's effective bg). */
    fillBg?: string;
    /** Select a row (hover) — selection follows the mouse like VSCode's list. */
    onHover: (index: number) => void;
    /** Accept a row (click). */
    onAccept: (candidate: CompletionCandidate, index: number) => void;
}

/** Visible rows before the list scrolls; PageUp/PageDown jump this many. */
const VISIBLE_ROWS = 8;
const ROW_HEIGHT = 28;

const KIND_ICON: Record<CompletionKind, typeof Folder> = {
    folder: Folder,
    command: Terminal,
    option: Flag,
    file: FileText,
};

/** Pop in just below the anchor: a short slide + fade reading as rising from
 *  the command line, mirroring SearchBar's local-variants pattern. */
const popFromAnchor: Variants = {
    hidden: {opacity: 0, y: 4, scale: 0.98},
    show: {
        opacity: 1,
        y: 0,
        scale: 1,
        transition: {duration: durationBase, ease: easeSpring},
    },
    exit: {
        opacity: 0,
        y: 2,
        scale: 0.98,
        transition: {duration: durationFast, ease: easeGlass},
    },
};

export default function CompletionPopup({state, fillBg, onHover, onAccept}: CompletionPopupProps) {
    const {filtered, selected, anchor, word} = state;
    const bg = fillBg ?? "#000000";
    const colors = useSurfaceColors(bg);
    const {supportsGlass} = useGlass();
    const fg = foregroundFor(bg);
    const muted = colors.inactiveText;
    const glass = glassSurface(bg, supportsGlass, {blurPx: 20});

    // Keep the highlighted row in view when the selection moves via keys.
    const selectedRowRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        selectedRowRef.current?.scrollIntoView({block: "nearest"});
    }, [selected]);

    // The list drops under the cursor line when there's room for a couple of
    // rows; near the bottom edge it flips above the line instead.
    const below = anchor.spaceBelow >= ROW_HEIGHT * 3;
    const maxHeight = Math.min(
        VISIBLE_ROWS,
        Math.max(2, Math.floor((below ? anchor.spaceBelow : anchor.spaceAbove) / ROW_HEIGHT)),
    ) * ROW_HEIGHT;
    const top = below ? anchor.y : Math.max(0, anchor.y - ROW_HEIGHT - maxHeight);
    // A short word list shouldn't slam the popup against the right edge; cap
    // the width at the space remaining, min 240px.
    const width = 360;

    return (
        <motion.div
            key="completion-popup"
            variants={popFromAnchor}
            initial="hidden"
            animate="show"
            exit="exit"
            className="absolute z-20 overflow-hidden rounded-[var(--radius-md)]"
            style={{
                ...glass,
                left: anchor.x,
                top,
                width,
                maxHeight,
                color: fg,
                boxShadow: elevationShadow("md"),
                transformOrigin: below ? "top left" : "bottom left",
            }}
            // The popup never takes focus — the terminal keeps it so keys keep
            // flowing through the interception chain. Pointer handlers only.
            onPointerDown={(e) => e.stopPropagation()}
        >
            <div className="overflow-y-auto" style={{maxHeight}}>
                {filtered.map((candidate, index) => {
                    const kind = completionKind(candidate);
                    const Icon = KIND_ICON[kind];
                    const isSelected = index === selected;
                    return (
                        <div
                            key={`${candidate.insert}\u0000${index}`}
                            ref={isSelected ? selectedRowRef : undefined}
                            className="flex cursor-pointer items-center gap-2 px-2.5 text-sm"
                            style={{
                                height: ROW_HEIGHT,
                                background: isSelected ? colors.accentOverlay : undefined,
                                color: fg,
                            }}
                            onMouseEnter={() => onHover(index)}
                            onClick={() => onAccept(candidate, index)}
                        >
                            <Icon size={14} style={{color: muted, flexShrink: 0}}/>
                            <span
                                className="min-w-0 flex-shrink truncate font-mono"
                                style={{color: fg}}
                                title={candidateLabel(candidate)}
                            >
                                {candidateLabel(candidate)}
                            </span>
                            <span
                                className="ml-auto min-w-0 flex-shrink truncate text-xs"
                                style={{color: muted}}
                                title={candidate.description}
                            >
                                {candidate.description}
                            </span>
                        </div>
                    );
                })}
            </div>
            {/* The live word being completed (grows as the user types while the
                popup is open, narrowing the list) — a subtle footer so the
                popup reads as "completions for <word>" without stealing list
                space. */}
            <div
                className="flex items-center justify-between px-2.5 py-1 text-[11px] select-none"
                style={{color: muted, borderTop: `1px solid ${colors.glassBorder}`}}
            >
                <span className="truncate font-mono">{word}</span>
                <span className="whitespace-nowrap pl-2">
                    {selected + 1}/{filtered.length}
                </span>
            </div>
        </motion.div>
    );
}
