import {useEffect, useRef} from "react";
import {motion} from "framer-motion";
import type {Variants} from "framer-motion";
import type {CSSProperties} from "react";
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
/** Rough height of the word/counter footer, reserved out of the flip space. */
const FOOTER_HEIGHT = 24;
/** Right-edge margin the anchor's maxX mirror keeps free (mirrors Term). */
const RIGHT_MARGIN = 80;
/** Breathing room between the popup and the cursor line, both directions. */
const POSITION_GAP = 4;

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
    // rows; near the bottom edge it flips above the line instead. Flipped-up
    // placement anchors the popup's BOTTOM edge to the cursor row's top via
    // CSS `bottom` — height-independent, so a short list still hugs the line
    // (a `top` computed from the max height would leave it floating mid-air
    // whenever the content is shorter than the cap). `bottom` is measured
    // from the container's bottom edge: cursorRowTop above it = spaceBelow +
    // one cursor cell.
    const below = anchor.spaceBelow >= ROW_HEIGHT * 3;
    const avail = (below ? anchor.spaceBelow : anchor.spaceAbove) - FOOTER_HEIGHT;
    const maxHeight = Math.min(VISIBLE_ROWS, Math.max(1, Math.floor(avail / ROW_HEIGHT))) * ROW_HEIGHT;
    // Don't run past the right edge: the anchor's maxX mirrors the container
    // width minus its margin. Keep the comfortable width and slide the whole
    // popup left (right-aligned to the edge) when the cursor sits near it.
    const containerWidth = anchor.maxX + RIGHT_MARGIN;
    const width = Math.min(360, Math.max(220, containerWidth - anchor.x - 8));
    const left = Math.min(anchor.x, Math.max(0, containerWidth - width - 8));

    // style position: below grows downward from the anchor; above pins the
    // popup's bottom edge to the top of the cursor row.
    const placement: CSSProperties = below
        ? {top: anchor.y + POSITION_GAP}
        : {bottom: anchor.spaceBelow + anchor.cellHeight + POSITION_GAP};

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
                left,
                ...placement,
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
                            {/* Label keeps its full content width (flex-initial,
                                base = auto) and only truncates when it alone
                                overflows the row; the description flexes from
                                basis 0, so it fills merely the leftover space
                                and yields first — the command stays readable,
                                the description shows as much as fits. */}
                            <span
                                className="min-w-0 flex-initial truncate font-mono"
                                style={{color: fg}}
                                title={candidateLabel(candidate)}
                            >
                                {candidateLabel(candidate)}
                            </span>
                            {candidate.description !== "" && (
                                <span
                                    className="min-w-0 flex-1 truncate text-right text-xs"
                                    style={{color: muted}}
                                    title={candidate.description}
                                >
                                    {candidate.description}
                                </span>
                            )}
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
