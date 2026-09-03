import {useEffect, useMemo, useRef, useState} from "react";
import {motion, type Variants} from "framer-motion";
import {SearchAddon, type ISearchOptions} from "@xterm/addon-search";
import type {Terminal} from "@xterm/xterm";
import {CaseSensitive, ChevronDown, ChevronUp, Regex, Search, WholeWord, X} from "lucide-react";
import IconButton from "./ui/IconButton.tsx";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {useGlass} from "../hooks/useGlass.ts";
import {useI18n} from "../hooks/i18n.tsx";
import {glassSurface, elevationShadow} from "../lib/glass.ts";
import {foregroundFor} from "../lib/color.ts";
import {durationBase, durationFast, easeSpring, easeGlass} from "../lib/motion.ts";
import {info, error} from "@tauri-apps/plugin-log";

interface SearchBarProps {
    searchAddon: SearchAddon | null;
    /** The xterm instance to refocus when the bar closes (Escape / ✕). */
    terminal: Terminal | null;
    /** Effective background hex the bar floats over (App's effective bg). */
    fillBg?: string;
    /** Bumped by the parent every time the search action fires. Each change
     *  (re)focuses the input — including when the bar is already open, so the
     *  shortcut focuses the bar rather than closing it. */
    focusTick: number;
    onClose: () => void;
}

/** Debounce for live search so typing in a large scrollback stays responsive. */
const SEARCH_DEBOUNCE_MS = 120;

/** Slide-down reveal anchored at the top: the bar unfolds from the titlebar
 *  edge rather than floating up from the terminal content. scaleY (0→1) with a
 *  top transform-origin makes it read as a drawer pulling out of the chrome,
 *  paired with a short opacity fade so it doesn't pop. */
const slideDownFromChrome: Variants = {
    hidden: {opacity: 0, y: -8, scaleY: 0.6},
    show: {
        opacity: 1,
        y: 0,
        scaleY: 1,
        transition: {duration: durationBase, ease: easeSpring},
    },
    exit: {
        opacity: 0,
        y: -8,
        scaleY: 0.6,
        transition: {duration: durationFast, ease: easeGlass},
    },
};

export default function SearchBar({searchAddon, terminal, fillBg, focusTick, onClose}: SearchBarProps) {
    const t = useI18n();
    const bg = fillBg ?? "#000000";
    const colors = useSurfaceColors(bg);
    const {supportsGlass} = useGlass();

    const [query, setQuery] = useState("");
    const [matchCase, setMatchCase] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [useRegex, setUseRegex] = useState(false);
    const [resultIndex, setResultIndex] = useState(-1);
    const [resultCount, setResultCount] = useState(0);

    const inputRef = useRef<HTMLInputElement>(null);
    const queryRef = useRef(query);
    queryRef.current = query;
    const addonRef = useRef(searchAddon);
    addonRef.current = searchAddon;
    const terminalRef = useRef(terminal);
    terminalRef.current = terminal;

    const glass = useMemo(
        () => glassSurface(bg, supportsGlass, {blurPx: 24}),
        [bg, supportsGlass],
    );

    const searchOptions = (forward: boolean): ISearchOptions => ({
        regex: useRegex,
        wholeWord,
        caseSensitive: matchCase,
        incremental: forward,
        decorations: {
            matchOverviewRuler: "rgba(255,255,255,0.25)",
            activeMatchColorOverviewRuler: "var(--color-brand-cinnabar, #ff461f)",
            matchBackground: "rgba(255,255,255,0.18)",
            activeMatchBackground: "rgba(255,70,31,0.45)",
        },
    });

    const runSearch = (forward: boolean) => {
        const addon = addonRef.current;
        const term = queryRef.current;
        if (!addon) return;
        try {
            const opts = searchOptions(forward);
            if (forward) addon.findNext(term, opts);
            else addon.findPrevious(term, opts);
        } catch (e) {
            // Most likely an invalid regex. Don't spam the log — only warn once.
            error(`Search failed: ${e}`).catch(() => {});
        }
    };

    // Debounced live search on query/option change.
    useEffect(() => {
        const handle = setTimeout(() => runSearch(true), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(handle);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, matchCase, wholeWord, useRegex]);

    // Track result count/index from the addon.
    useEffect(() => {
        if (!searchAddon) return;
        const disposable = searchAddon.onDidChangeResults((e) => {
            if (!e) return;
            setResultIndex(e.resultIndex);
            setResultCount(e.resultCount);
        });
        return () => disposable.dispose();
    }, [searchAddon]);

    // Auto-focus the input shortly after the bar appears (after the
    // slide-down animates), and again whenever the parent bumps focusTick —
    // the search shortcut re-triggered, which focuses the bar instead of
    // closing it. The effect also runs on mount, so every open path focuses.
    useEffect(() => {
        const handle = setTimeout(() => inputRef.current?.focus(), 60);
        return () => clearTimeout(handle);
    }, [focusTick]);

    // Strip the active-match decoration so the normal selection shows through
    // again, but keep decorations so matches stay highlighted while idle. We
    // only clear all decorations on unmount (close). On unmount we also return
    // focus to the terminal so keystrokes resume going to the PTY.
    useEffect(() => {
        return () => {
            try {
                addonRef.current?.clearDecorations();
            } catch (e) {
                info(`SearchBar clearDecorations on unmount: ${e}`).catch(() => {});
            }
            // Defer so the input is gone from the DOM before refocusing,
            // otherwise the browser may keep focus on the (unmounting) field.
            setTimeout(() => {
                try {
                    terminalRef.current?.focus();
                } catch (e) {
                    info(`SearchBar refocus on close: ${e}`).catch(() => {});
                }
            }, 0);
        };
    }, []);

    const hasResults = resultCount > 0 && resultIndex >= 0;
    const fg = foregroundFor(bg);
    const muted = colors.inactiveText;

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            runSearch(!e.shiftKey);
            inputRef.current?.focus();
        }
    };

    return (
        <motion.div
            key="searchbar"
            variants={slideDownFromChrome}
            initial="hidden"
            animate="show"
            exit="exit"
            className="absolute top-0 right-0 z-20 flex items-center gap-1.5 px-3 py-2 rounded-bl-[var(--radius-md)]"
            style={{
                ...glass,
                color: fg,
                boxShadow: elevationShadow("sm"),
                maxWidth: "min(520px, 92%)",
                transformOrigin: "top right",
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
                // Escape anywhere inside the bar (the input or a focused
                // option button) closes it — the only way out besides ✕.
                if (e.key === "Escape") {
                    e.preventDefault();
                    onClose();
                }
            }}
            >
                <Search size={16} style={{color: muted, flexShrink: 0}}/>
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={t["Search in terminal..."]}
                    className="flex-1 min-w-0 bg-transparent outline-none border-none text-sm"
                    style={{color: fg, caretColor: fg}}
                />

                {/* Result counter */}
                <span
                    className="text-xs tabular-nums select-none whitespace-nowrap"
                    style={{color: muted, minWidth: 56, textAlign: "center"}}
                >
                    {query
                        ? (hasResults
                            ? t["{n} of {m}"].replace("{n}", String(resultIndex + 1)).replace("{m}", String(resultCount))
                            : t["No results"])
                        : ""}
                </span>

                <div className="h-5 w-px" style={{background: colors.glassBorder}}/>

                {/* Option toggles */}
                <IconButton
                    size={28}
                    isActive={matchCase}
                    title={t["Match Case"]}
                    aria-label={t["Match Case"]}
                    hoverOverlay={colors.hoverOverlay}
                    activeOverlay={colors.accentOverlay}
                    onClick={() => setMatchCase((v) => !v)}
                >
                    <CaseSensitive size={15}/>
                </IconButton>
                <IconButton
                    size={28}
                    isActive={wholeWord}
                    title={t["Whole Word"]}
                    aria-label={t["Whole Word"]}
                    hoverOverlay={colors.hoverOverlay}
                    activeOverlay={colors.accentOverlay}
                    onClick={() => setWholeWord((v) => !v)}
                >
                    <WholeWord size={15}/>
                </IconButton>
                <IconButton
                    size={28}
                    isActive={useRegex}
                    title={t["Regular Expression"]}
                    aria-label={t["Regular Expression"]}
                    hoverOverlay={colors.hoverOverlay}
                    activeOverlay={colors.accentOverlay}
                    onClick={() => setUseRegex((v) => !v)}
                >
                    <Regex size={15}/>
                </IconButton>

                <div className="h-5 w-px" style={{background: colors.glassBorder}}/>

                {/* Previous / Next / Close */}
                <IconButton
                    size={28}
                    aria-label={t["Find previous"]}
                    title={t["Find previous"]}
                    disabled={!hasResults}
                    hoverOverlay={colors.hoverOverlay}
                    activeOverlay={colors.accentOverlay}
                    onClick={() => runSearch(false)}
                >
                    <ChevronUp size={16}/>
                </IconButton>
                <IconButton
                    size={28}
                    aria-label={t["Find next"]}
                    title={t["Find next"]}
                    disabled={!hasResults}
                    hoverOverlay={colors.hoverOverlay}
                    activeOverlay={colors.accentOverlay}
                    onClick={() => runSearch(true)}
                >
                    <ChevronDown size={16}/>
                </IconButton>
                <IconButton
                    size={28}
                    title={t["Close search"]}
                    aria-label={t["Close search"]}
                    hoverOverlay={colors.hoverOverlay}
                    activeOverlay={colors.accentOverlay}
                    onClick={onClose}
                >
                    <X size={15}/>
                </IconButton>
        </motion.div>
    );
}
