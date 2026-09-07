import {useCallback, useEffect, useRef, useState} from "react";
import {debug, info} from "@tauri-apps/plugin-log";
import {
    type CompletionCandidate,
    filterCandidates,
    insertionBytes,
    isPlainTypingKey,
    parseCompletionPayload,
    shouldRetrigger,
} from "../lib/completions.ts";
import {writeToTerminal} from "../lib/terminalApi.ts";

/** Rows a PageUp/PageDown jump; matches the popup's visible-rows cap. */
const PAGE_SIZE = 8;

/** How long after the last keystroke the as-you-type mode sends its
 *  completion request. Long enough to coalesce typing bursts into one
 *  shell round-trip, short enough to feel immediate (the local filter and
 *  the warm cache give instant feedback in between). */
const REQUEST_DEBOUNCE_MS = 100;

/** How many fetched word→candidates sets to keep for instant backtracking. */
const CACHE_CAP = 32;

/** Warm-cache bounds: contexts kept per terminal, word sets kept per context. */
const INDEX_CTX_CAP = 64;
const INDEX_WORD_CAP = 16;

/** A cached set fetched within this window is considered FRESH: serving from
 *  it skips the correction request entirely. Every in-band request TAB blocks
 *  the shell's line editor (measured: even a backgrounded job from a fish key
 *  binding stalls echo identically to a foreground one), so the request fires
 *  only when the local data is stale, unknown, or the user pressed TAB. */
const FRESH_TTL_MS = 60_000;

/** A cached candidate set with its fetch time. */
interface CachedSet {
    candidates: CompletionCandidate[];
    fetchedAt: number;
}

function isFresh(entry: CachedSet): boolean {
    return Date.now() - entry.fetchedAt < FRESH_TTL_MS;
}

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
    /** Live cell height — the flipped-up popup pins its bottom edge one cell
     *  above the anchor (the cursor row's top). */
    cellHeight: number;
    /** Horizontal clamp for the anchor (container width − popup margin), so
     *  word-growth shifts can't push the popup out of the terminal. */
    maxX: number;
}

/** The open popup's model. `word` is LIVE: it grows/shrinks as the user keeps
 *  typing (or backspaces) with the popup open, narrowing `filtered`; `baseWord`
 *  is what the shell matched — backspacing below it invalidates the set (the
 *  true candidates for the shorter word may include files the shell never
 *  sent), so the popup consults the caches instead of guessing. `ctx` is the
 *  line context both came from. */
export interface CompletionState {
    ctx: string;
    word: string;
    baseWord: string;
    candidates: CompletionCandidate[];
    filtered: CompletionCandidate[];
    selected: number;
    anchor: CompletionAnchor;
}

/** The line as the frontend tracks it between shell responses: the context
 *  plus the word typed so far. Anchored by every shell response, evolved by
 *  plain typing/backspacing, invalidated by anything else (cursor moves,
 *  control keys, acceptance). Drives warm-cache lookups for the instant-open. */
interface ShadowLine {
    ctx: string;
    word: string;
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

/** Shift an anchor horizontally by n code points of typing (clamped). */
function anchorShifted(anchor: CompletionAnchor, points: number): CompletionAnchor {
    return {
        ...anchor,
        x: Math.min(Math.max(0, anchor.x + points * anchor.cellWidth), anchor.maxX),
    };
}

interface UseShellCompletionsOptions {
    /** PTY id accepting the insertion bytes is written to. */
    ptyId: string;
    /** The `enableShellCompletions` config at SPAWN time — must match when the
     *  backend installed the shell hooks, since every request is a TAB byte
     *  that would otherwise hit the shell's native completion. */
    enabled: boolean;
    /** The `shellCompletionsOnType` config (live) — IDE-style as-you-type
     *  requests after a typing pause. Only honored while `enabled`. */
    onType?: boolean;
    /** Live "the shell sits at its prompt" signal (Term's current-command
     *  state). Requests are suppressed otherwise — a TAB injected into a
     *  running program (vim, htop, …) would land as raw input. */
    atPrompt?: () => boolean;
}

/**
 * The terminal-suggest popup state machine: consumes raw
 * `OSC 1337;Completions=` payloads (routed from useCurrentCommand's stream
 * parser), renders-vs-inserts, and owns the keyboard while the popup is open.
 *
 * - A single candidate completes silently (matching native TAB behavior —
 *   no popup for an unambiguous match), cascading when it is a directory.
 *   Disabled in as-you-type mode, where every offer is request-driven and an
 *   auto-insert would fight the user's typing ("ech" would become "echo" mid-
 *  keystroke).
 * - While open, typing extends the word and filters the set locally (exact —
 *  `v*` ⊇ `vi*`); Backspace shrinks it down to the shell-reported base word;
 *  any other key (cursor moves, Ctrl-combos) closes and falls through.
 * - Tab accepts AND sends a follow-up TAB so the shell re-offers against the
 *   new word (drill down through directories, keep narrowing commands); Enter
 *   accepts and finishes — except directories, which always cascade (see
 *   shouldRetrigger for why acceptance never re-triggers unconditionally).
 * - As-you-type mode (`onType`): every plain keystroke (or Backspace), popup
 *  open or not, schedules a debounced request — a TAB byte whose OSC refreshes
 *   the popup. Explicit dismissals (Escape, final Enter) cancel the pending
 *   request and drop in-flight responses, so the popup can't "come back" on
 *   its own; scheduled requests clear that suppression when they fire.
 * - Warm cache: every shell response is indexed under its LINE CONTEXT
 *  (`git `, `cargo `, ""…) and word. Revisiting a known context opens the
 *  popup INSTANTLY from the index (same context + stored word that the typed
 *  word extends ⇒ exact superset — the same argument as the local filter),
 *  and the shell's response corrects it when it lands. This kills the
 *  first-appearance round-trip for every context the user has already used
 *  this session — the shell stays the single source of truth, no sidecar
 *  process, no bundled completion database.
 * - Acceptance writes DEL × word-length + the insert text into the PTY — the
 *   same contract the backend e2e test (tests/completion_hooks.rs) verifies
 *   against a live zsh line editor.
 */
export function useShellCompletions({ptyId, enabled, onType, atPrompt}: UseShellCompletionsOptions) {
    const [state, setState] = useState<CompletionState | null>(null);
    // Latest-ref bridge so the (stable) key filter and offer callback observe
    // the current state without re-installing the bindings handler.
    const stateRef = useRef<CompletionState | null>(null);
    stateRef.current = state;
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;
    const onTypeRef = useRef(!!onType);
    onTypeRef.current = !!onType;
    const atPromptRef = useRef(atPrompt);
    atPromptRef.current = atPrompt;

    // Pending debounced as-you-type request (timer handle).
    const requestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Set by deliberate dismissals so an in-flight request's OSC can't reopen
    // the popup; cleared whenever we intentionally send a request TAB.
    const suppressedRef = useRef(false);
    // Word → candidate-set cache (bounded LRU by insertion order). Every
    // shell-fetched set lands here; backspacing below the shell-reported base
    // word consults it so previously fetched words restore SYNCHRONOUSLY
    // instead of closing the popup and waiting for a round-trip (the fetch is
    // async and in-band — the shell's line editor is single-threaded, so a
    // completion TAB mid-typing delays the echo of everything behind it;
    // serving from cache keeps the main PTY untouched).
    const cacheRef = useRef(new Map<string, CachedSet>());
    // Warm cache across words: line-context → (word → cached set). The
    // instant-open's candidate source for contexts already seen this session.
    const indexRef = useRef(new Map<string, Map<string, CachedSet>>());
    // Line tracking between shell responses (see ShadowLine).
    const shadowRef = useRef<ShadowLine | null>(null);
    // The most recent shell-provided anchor + the word length it was anchored
    // at — the instant-open shifts it by the characters typed since, instead
    // of asking Term for geometry mid-keystroke.
    const lastAnchorRef = useRef<{anchor: CompletionAnchor; wordLen: number} | null>(null);

    useEffect(() => {
        return () => {
            if (requestTimerRef.current !== null) clearTimeout(requestTimerRef.current);
        };
    }, []);

    /** Store a fetched set under its word (MRU-ordered, bounded). */
    const cachePut = useCallback((word: string, candidates: CompletionCandidate[]) => {
        const cache = cacheRef.current;
        cache.delete(word);
        cache.set(word, {candidates, fetchedAt: Date.now()});
        if (cache.size > CACHE_CAP) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
    }, []);

    /** Index a fetched set under (ctx, word) for the instant-open (bounded). */
    const indexPut = useCallback((ctx: string, word: string, candidates: CompletionCandidate[]) => {
        const index = indexRef.current;
        let words = index.get(ctx);
        if (!words) {
            words = new Map();
            index.set(ctx, words);
        }
        words.delete(word);
        words.set(word, {candidates, fetchedAt: Date.now()});
        if (words.size > INDEX_WORD_CAP) {
            const oldest = words.keys().next().value;
            if (oldest !== undefined) words.delete(oldest);
        }
        if (index.size > INDEX_CTX_CAP) {
            const oldest = index.keys().next().value;
            if (oldest !== undefined) index.delete(oldest);
        }
    }, []);

    const close = useCallback(() => {
        setState((prev) => {
            if (prev) debug(`Completion popup closed (word=${prev.word})`).catch(() => {});
            return null;
        });
    }, []);

    /** Dismiss for real: no reopen from in-flight responses, no pending fire.
     *  Keeps the shadow line — typing continues from where the line is. */
    const dismiss = useCallback(() => {
        if (requestTimerRef.current !== null) {
            clearTimeout(requestTimerRef.current);
            requestTimerRef.current = null;
        }
        suppressedRef.current = true;
        close();
    }, [close]);

    /** Fire one completion request at the shell: a TAB byte, which the hooks
     *  answer with a fresh OSC (no insertion — the shim captures instead of
     *  completing). This is also the moment an earlier dismissal lifts, since
     *  the response to THIS request is legitimately fresh. */
    const sendRequest = useCallback(() => {
        // Never inject a TAB into a running program — the shell-integration
        // preexec signal says whether we're at a prompt.
        const atPrompt = atPromptRef.current;
        if (atPrompt && !atPrompt()) return;
        suppressedRef.current = false;
        debug("Completion request sent (TAB)").catch(() => {});
        writeToTerminal(ptyId, "\t").then();
    }, [ptyId]);

    /** Schedule a debounced request (as-you-type mode); coalesces bursts. */
    const scheduleRequest = useCallback(() => {
        if (requestTimerRef.current !== null) clearTimeout(requestTimerRef.current);
        requestTimerRef.current = setTimeout(() => {
            requestTimerRef.current = null;
            sendRequest();
        }, REQUEST_DEBOUNCE_MS);
    }, [sendRequest]);

    /** As-you-type request trigger shared by the open/closed key paths. */
    const maybeScheduleRequest = useCallback(() => {
        if (onTypeRef.current && enabledRef.current) scheduleRequest();
    }, [scheduleRequest]);

    /** Write the accept bytes: erase the live word, type the insert, and
     *  optionally a follow-up TAB so the shell re-offers fresh candidates.
     *  When the insert already equals the word the erase+retype is skipped. */
    const accept = useCallback(
        (candidate: CompletionCandidate, word: string, retrigger: boolean) => {
            if (requestTimerRef.current !== null) {
                clearTimeout(requestTimerRef.current);
                requestTimerRef.current = null;
            }
            const replace = candidate.insert === word ? "" : insertionBytes(word, candidate);
            const bytes = retrigger ? replace + "\t" : replace;
            debug(
                `Completion accepted: word=${JSON.stringify(word)} insert=${JSON.stringify(candidate.insert)}` +
                    ` retrigger=${retrigger}`,
            ).catch(() => {});
            if (bytes !== "") {
                if (retrigger) suppressedRef.current = false;
                writeToTerminal(ptyId, bytes).then();
            }
        },
        [ptyId],
    );

    /** Feed one raw Completions payload (called from the output stream). The
     *  anchor is computed by the caller (Term), which owns the xterm geometry.
     *  Replaces any open popup — a follow-up TAB's fresh set lands here —
     *  unless the response is already behind the user's typing, in which case
     *  it merges into the live word instead of snapping the popup back. */
    const offer = useCallback(
        (payload: string, anchor: CompletionAnchor) => {
            if (!enabledRef.current) return;
            if (suppressedRef.current) {
                debug("Completion offer dropped (dismissed)").catch(() => {});
                return;
            }
            // A response may land after the user already ran a command (the
            // request raced their Enter) — don't pop a suggest list over a
            // running program.
            const atPrompt = atPromptRef.current;
            if (atPrompt && !atPrompt()) return;
            const {ctx, word, candidates} = parseCompletionPayload(payload);
            if (candidates.length === 0 || word === "") {
                // No candidates — or nothing typed at the cursor (empty line,
                // or right after a space): the shell answers those with a
                // full "everything" list, which is pure noise. Don't popup.
                close();
                return;
            }
            cachePut(word, candidates);
            indexPut(ctx, word, candidates);
            lastAnchorRef.current = {anchor, wordLen: [...word].length};
            // The response IS the ground truth of where the line is.
            shadowRef.current = {ctx, word};
            const live = stateRef.current;
            const typedAhead = !!live && live.ctx === ctx && live.word !== word && live.word.startsWith(word);
            if (typedAhead) {
                // A debounced request raced further typing: the fresh set is
                // for a PREFIX of the live word, so filter it locally (exact —
                // the set is a superset for any longer word) and keep the live
                // word/anchor/selection instead of regressing the popup.
                const filtered = filterCandidates(candidates, live.word);
                if (filtered.length === 0) {
                    close();
                    return;
                }
                setState({
                    ...live,
                    baseWord: word,
                    candidates,
                    filtered,
                    selected: Math.min(live.selected, filtered.length - 1),
                });
                return;
            }
            if (candidates.length === 1 && !onTypeRef.current) {
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
                ctx,
                word,
                baseWord: word,
                candidates,
                filtered: candidates,
                selected: 0,
                anchor,
            });
        },
        [accept, cachePut, close, indexPut],
    );

    /** Open the popup instantly from the warm index for the shadow line's
     *  context (as-you-type mode only — TAB mode never opens unrequested).
     *  Any stored word that the typed word EXTENDS yields an exact superset
     *  (same context, longer word narrows). Returns "fresh" when the served
     *  set was fetched within the TTL (the caller skips the correction
     *  request — an in-band TAB would stall the line editor for nothing),
     *  "stale" when it opened from an old set (refresh wanted), or null when
     *  there was nothing to serve. */
    const tryInstantOpen = useCallback((word: string): "fresh" | "stale" | null => {
        if (!onTypeRef.current) return null;
        const shadow = shadowRef.current;
        const last = lastAnchorRef.current;
        if (!shadow || !last) return null;
        const words = indexRef.current.get(shadow.ctx);
        if (!words) return null;
        // Longest stored base the typed word extends — broadest fresh set.
        let bestWord: string | null = null;
        for (const stored of words.keys()) {
            if (word.startsWith(stored) && (bestWord === null || stored.length > bestWord.length)) {
                bestWord = stored;
            }
        }
        if (bestWord === null) return null;
        const entry = words.get(bestWord)!;
        const filtered = filterCandidates(entry.candidates, word);
        if (filtered.length === 0) return null;
        debug(`Completion popup instant-open (ctx=${JSON.stringify(shadow.ctx)} word=${word})`).catch(() => {});
        setState({
            ctx: shadow.ctx,
            word,
            baseWord: bestWord,
            candidates: entry.candidates,
            filtered,
            selected: 0,
            anchor: anchorShifted(last.anchor, [...word].length - last.wordLen),
        });
        return isFresh(entry) ? "fresh" : "stale";
    }, []);

    /** Evolve the shadow line for a plain keystroke (popup closed path). */
    const shadowType = useCallback((char: string) => {
        const shadow = shadowRef.current;
        if (shadow) shadow.word += char;
    }, []);

    const shadowBackspace = useCallback(() => {
        const shadow = shadowRef.current;
        if (shadow && shadow.word !== "") shadow.word = [...shadow.word].slice(0, -1).join("");
    }, []);

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
            if (!current) {
                // Popup closed: plain keystrokes are still completion triggers
                // in as-you-type mode, and an explicit TAB (tab-mode) is a
                // request whose response must not stay suppressed. The warm
                // cache can also open the popup instantly for a known context.
                if (isPlainTypingKey(event) || event.key === "Backspace") {
                    if (isPlainTypingKey(event)) {
                        const word = (shadowRef.current?.word ?? "") + event.key;
                        shadowType(event.key);
                        // Fresh warm-cache hit ⇒ the filtered view IS the
                        // truth; skip the request so the line editor never
                        // stalls behind a needless completion TAB.
                        if (tryInstantOpen(word) !== "fresh") maybeScheduleRequest();
                    } else {
                        shadowBackspace();
                        maybeScheduleRequest();
                    }
                }
                if (event.key === "Tab") suppressedRef.current = false;
                return true;
            }
            switch (event.key) {
                case "Tab": {
                    // Accept + drill down: the follow-up TAB makes the shell
                    // re-offer against the inserted word (popup re-opens via
                    // the next OSC).
                    event.preventDefault();
                    accept(current.filtered[current.selected], current.word, true);
                    shadowRef.current = null;
                    close();
                    return false;
                }
                case "Enter": {
                    // Accept and finish. Directories are the exception — they
                    // always have a next level, so they cascade.
                    event.preventDefault();
                    const candidate = current.filtered[current.selected];
                    const retrigger = shouldRetrigger(candidate);
                    accept(candidate, current.word, retrigger);
                    shadowRef.current = null;
                    if (retrigger) close();
                    else dismiss();
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
                    dismiss();
                    return false;
                case "Backspace": {
                    // The shell's line editor deletes the char (key passes
                    // through). Above the shell-reported base word the set is
                    // still an exact superset — refine locally, NO request (an
                    // in-band TAB would block the echo of keys behind it).
                    // Below it the local set is invalid: serve a previously
                    // fetched set for the shorter word from cache SYNCHRONOUSLY
                    // (background-refresh via request), and only on a miss
                    // close and let the (debounced) request re-query.
                    shadowBackspace();
                    const word = [...current.word].slice(0, -1).join("");
                    const anchor = anchorShifted(current.anchor, -1);
                    if (word.length >= current.baseWord.length) {
                        setState((prev) => (prev ? refine(prev, word, anchor) : prev));
                        return true;
                    }
                    const cached = cacheRef.current.get(word);
                    if (cached && cached.candidates.length > 0) {
                        setState({
                            ctx: current.ctx,
                            word,
                            baseWord: word,
                            candidates: cached.candidates,
                            filtered: cached.candidates,
                            selected: 0,
                            anchor,
                        });
                        // The cache may predate a cd / env change — refresh in
                        // the background, but only when actually stale.
                        if (!isFresh(cached)) maybeScheduleRequest();
                    } else {
                        setState(null);
                        maybeScheduleRequest();
                    }
                    return true;
                }
                default: {
                    // Plain typing extends the word and narrows the set (the
                    // char still reaches the shell — the line and the popup
                    // stay in sync). While the local filter survives this is
                    // EXACT (v* ⊇ vi*) — no request, so the shell's line
                    // editor never chews a completion TAB mid-typing. Only a
                    // dead filter (word boundary, no match, case the shell's
                    // matcher would have folded) asks for a fresh set.
                    if (isPlainTypingKey(event)) {
                        shadowType(event.key);
                        maybeScheduleRequest();
                        const word = current.word + event.key;
                        const anchor = anchorShifted(current.anchor, 1);
                        const next = refine(current, word, anchor);
                        if (next) {
                            setState({...next, selected: 0});
                        } else {
                            // Word boundary (space, …) or no local match: seed
                            // the shadow for the NEXT word so the warm cache
                            // can open instantly, then close + re-query.
                            if (event.key === " ") {
                                shadowRef.current = {
                                    ctx: current.ctx === "" ? current.word : `${current.ctx} ${current.word}`,
                                    word: "",
                                };
                            }
                            debug(`Completion popup closed by filter (word=${word})`).catch(() => {});
                            setState(null);
                            maybeScheduleRequest();
                        }
                        return true;
                    }
                    // Anything else (cursor moves, Ctrl- combos, …): close and
                    // let the key reach the shell unchanged. Full dismiss, so
                    // a pending as-you-type request can't resurrect the popup
                    // right after e.g. a Ctrl+C. Shadow dies too — the line
                    // may have changed in untrackable ways.
                    shadowRef.current = null;
                    dismiss();
                    return true;
                }
            }
        },
        [accept, close, dismiss, maybeScheduleRequest, moveSelection, shadowBackspace, shadowType, tryInstantOpen],
    );

    /** Select a row by index (mouse hover/click from the popup component). */
    const select = useCallback((index: number) => {
        setState((prev) =>
            prev && index >= 0 && index < prev.filtered.length && index !== prev.selected
                ? {...prev, selected: index}
                : prev,
        );
    }, []);

    /** Accept a specific candidate (popup row click). Like Enter: accept and
     *  finish, except directories which cascade. No-op when closed. */
    const acceptCandidate = useCallback(
        (candidate: CompletionCandidate) => {
            const current = stateRef.current;
            if (!current) return;
            const retrigger = shouldRetrigger(candidate);
            accept(candidate, current.word, retrigger);
            shadowRef.current = null;
            if (retrigger) close();
            else dismiss();
        },
        [accept, close, dismiss],
    );

    return {state, offer, handleKey, select, acceptCandidate, close, dismiss};
}
