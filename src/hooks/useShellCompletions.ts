import {useCallback, useRef, useState} from "react";
import {debug, info} from "@tauri-apps/plugin-log";
import {
    type CompletionCandidate,
    filterCandidates,
    insertionBytes,
    parseCompletionPayload,
    shouldRetrigger,
} from "../lib/completions.ts";
import {writeToTerminal} from "../lib/terminalApi.ts";

/** Rows a PageUp/PageDown jump; matches the popup's visible-rows cap. */
const PAGE_SIZE = 8;

/** Where the popup should anchor, in the terminal container's pixel space. */
export interface CompletionAnchor {
    /** Left edge of the cell right after the cursor (the word's end). */
    x: number;
    /** Top edge of the row right below the cursor. */
    y: number;
    /** Free space between the anchor and the container's bottom / top edges. */
    spaceBelow: number;
    spaceAbove: number;
    /** Live cell width, so the anchor can follow the cursor as the user types. */
    cellWidth: number;
    /** Horizontal clamp for the anchor (container width − popup margin), so
     *  word-growth shifts can't push the popup out of the terminal. */
    maxX: number;
}

/** The open popup's model. `word` is LIVE: it grows/shrinks as the user keeps
 *  typing (or backspaces) with the popup open, narrowing `filtered`; `baseWord`
 *  is what the shell matched — backspacing below it invalidates the set (the
 *  true candidates for the shorter word may include files the shell never
 *  sent), so the popup closes instead of guessing. */
export interface CompletionState {
    word: string;
    baseWord: string;
    candidates: CompletionCandidate[];
    filtered: CompletionCandidate[];
    selected: number;
    anchor: CompletionAnchor;
}

/** Rebuild the derived slice (filtered set + clamped selection) after a word
 *  change. Returns null when nothing matches anymore — the caller closes. */
function refine(prev: CompletionState, word: string, anchor?: CompletionAnchor): CompletionState | null {
    const filtered = filterCandidates(prev.candidates, word);
    if (filtered.length === 0) return null;
    return {
        ...prev,
        word,
        filtered,
        selected: Math.min(prev.selected, filtered.length - 1),
        ...(anchor ? {anchor} : {}),
    };
}

interface UseShellCompletionsOptions {
    /** PTY id accepting the insertion bytes is written to. */
    ptyId: string;
    /** The `enableShellCompletions` config at spawn time — new terminals only,
     *  matching when the backend installs the shell hooks. */
    enabled: boolean;
}

/**
 * The terminal-suggest popup state machine: consumes raw
 * `OSC 1337;Completions=` payloads (routed from useCurrentCommand's stream
 * parser), renders-vs-inserts, and owns the keyboard while the popup is open.
 *
 * - A single candidate completes silently (matching native TAB behavior —
 *   no popup for an unambiguous match), cascading when it is a directory.
 * - While open, typing extends the word and filters the set locally (exact —
 *  `v*` ⊇ `vi*`); Backspace shrinks it down to the shell-reported base word;
 *  any other key (cursor moves, Ctrl-combos) closes and falls through.
 * - Tab accepts AND sends a follow-up TAB so the shell re-offers against the
 *   new word (drill down through directories, keep narrowing commands); Enter
 *   accepts and finishes — except directories, which always cascade (see
 *   shouldRetrigger for why acceptance never re-triggers unconditionally).
 * - Acceptance writes DEL × word-length + the insert text into the PTY — the
 *   same contract the backend e2e test (tests/completion_hooks.rs) verifies
 *   against a live zsh line editor.
 */
export function useShellCompletions({ptyId, enabled}: UseShellCompletionsOptions) {
    const [state, setState] = useState<CompletionState | null>(null);
    // Latest-ref bridge so the (stable) key filter and offer callback observe
    // the current state without re-installing the bindings handler.
    const stateRef = useRef<CompletionState | null>(null);
    stateRef.current = state;
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;

    const close = useCallback(() => {
        setState((prev) => {
            if (prev) debug(`Completion popup closed (word=${prev.word})`).catch(() => {});
            return null;
        });
    }, []);

    /** Write the accept bytes: erase the live word, type the insert, and
     *  optionally a follow-up TAB so the shell re-offers fresh candidates.
     *  When the insert already equals the word the erase+retype is skipped. */
    const accept = useCallback(
        (candidate: CompletionCandidate, word: string, retrigger: boolean) => {
            const replace = candidate.insert === word ? "" : insertionBytes(word, candidate);
            const bytes = retrigger ? replace + "\t" : replace;
            debug(
                `Completion accepted: word=${JSON.stringify(word)} insert=${JSON.stringify(candidate.insert)}` +
                    ` retrigger=${retrigger}`,
            ).catch(() => {});
            if (bytes !== "") writeToTerminal(ptyId, bytes).then();
        },
        [ptyId],
    );

    /** Feed one raw Completions payload (called from the output stream). The
     *  anchor is computed by the caller (Term), which owns the xterm geometry.
     *  Replaces any open popup — a follow-up TAB's fresh set lands here. */
    const offer = useCallback(
        (payload: string, anchor: CompletionAnchor) => {
            if (!enabledRef.current) return;
            const {word, candidates} = parseCompletionPayload(payload);
            if (candidates.length === 0) {
                close();
                return;
            }
            if (candidates.length === 1) {
                // Unambiguous: complete silently like native TAB, no popup.
                // Directories cascade (contents of the just-entered dir);
                // anything else would loop (accept → re-offer the same word).
                close();
                const only = candidates[0];
                if (only.insert !== word || shouldRetrigger(only)) {
                    accept(only, word, shouldRetrigger(only));
                }
                return;
            }
            info(`Completion popup opened: ${candidates.length} candidates for word=${word}`).catch(() => {});
            setState({
                word,
                baseWord: word,
                candidates,
                filtered: candidates,
                selected: 0,
                anchor,
            });
        },
        [accept, close],
    );

    const moveSelection = useCallback((delta: number | "start" | "end") => {
        setState((prev) => {
            if (!prev) return prev;
            const n = prev.filtered.length;
            const next =
                delta === "start" ? 0
                : delta === "end" ? n - 1
                : (prev.selected + delta + n) % n;
            return next === prev.selected ? prev : {...prev, selected: next};
        });
    }, []);

    /**
     * The loadBindings keydown pre-filter (lib/bindings.ts). Returns false
     * only for keys the open popup consumes; typing/backspace refine the set
     * and pass through; every other key closes the popup and falls through.
     */
    const handleKey = useCallback(
        (event: KeyboardEvent): boolean => {
            const current = stateRef.current;
            if (!current) return true;
            switch (event.key) {
                case "Tab": {
                    // Accept + drill down: the follow-up TAB makes the shell
                    // re-offer against the inserted word (popup re-opens via
                    // the next OSC).
                    event.preventDefault();
                    accept(current.filtered[current.selected], current.word, true);
                    close();
                    return false;
                }
                case "Enter": {
                    // Accept and finish. Directories are the exception — they
                    // always have a next level, so they cascade.
                    event.preventDefault();
                    const candidate = current.filtered[current.selected];
                    accept(candidate, current.word, shouldRetrigger(candidate));
                    close();
                    return false;
                }
                case "ArrowUp":
                    event.preventDefault();
                    moveSelection(-1);
                    return false;
                case "ArrowDown":
                    event.preventDefault();
                    moveSelection(1);
                    return false;
                case "Home":
                    event.preventDefault();
                    moveSelection("start");
                    return false;
                case "End":
                    event.preventDefault();
                    moveSelection("end");
                    return false;
                case "PageUp":
                    event.preventDefault();
                    moveSelection(-PAGE_SIZE);
                    return false;
                case "PageDown":
                    event.preventDefault();
                    moveSelection(PAGE_SIZE);
                    return false;
                case "Escape":
                    event.preventDefault();
                    close();
                    return false;
                case "Backspace": {
                    // The shell's line editor deletes the char (key passes
                    // through); shrink the live word. Below the shell-reported
                    // base word the candidate set is no longer a superset of
                    // the truth — close and let a fresh TAB re-query.
                    if (current.word.length <= current.baseWord.length) {
                        close();
                        return true;
                    }
                    const word = [...current.word].slice(0, -1).join("");
                    const anchor = {
                        ...current.anchor,
                        x: Math.max(0, current.anchor.x - current.anchor.cellWidth),
                    };
                    setState((prev) => (prev ? refine(prev, word, anchor) : prev));
                    return true;
                }
                default: {
                    // Plain typing extends the word and narrows the set (the
                    // char still reaches the shell — the line and the popup
                    // stay in sync). Modifiers/cursor keys close instead.
                    if (
                        event.key.length === 1 &&
                        !event.ctrlKey && !event.metaKey && !event.altKey
                    ) {
                        const word = current.word + event.key;
                        const anchor = {
                            ...current.anchor,
                            x: Math.min(current.anchor.x + current.anchor.cellWidth, current.anchor.maxX),
                        };
                        setState((prev) => {
                            if (!prev) return prev;
                            const next = refine(prev, word, anchor);
                            if (!next) {
                                debug(`Completion popup closed by filter (word=${word})`).catch(() => {});
                                return null;
                            }
                            return {...next, selected: 0};
                        });
                        return true;
                    }
                    // Anything else (cursor moves, Ctrl- combos, …): close and
                    // let the key reach the shell unchanged.
                    close();
                    return true;
                }
            }
        },
        [accept, close, moveSelection],
    );

    /** Select a row by index (mouse hover/click from the popup component). */
    const select = useCallback((index: number) => {
        setState((prev) =>
            prev && index >= 0 && index < prev.filtered.length && index !== prev.selected
                ? {...prev, selected: index}
                : prev,
        );
    }, []);

    /** Accept a specific candidate (popup row click). Like Enter: final,
     *  except directories which cascade. No-op when closed. */
    const acceptCandidate = useCallback(
        (candidate: CompletionCandidate) => {
            const current = stateRef.current;
            if (!current) return;
            accept(candidate, current.word, shouldRetrigger(candidate));
            close();
        },
        [accept, close],
    );

    return {state, offer, handleKey, select, acceptCandidate, close};
}
