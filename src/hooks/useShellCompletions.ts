import {useCallback, useEffect, useRef, useState} from "react";
import {debug, info} from "@tauri-apps/plugin-log";
import {
    type CompletionCandidate,
    type CompletionCacheEntry,
    filterCandidates,
    insertionBytes,
    isPlainTypingKey,
    parseCompletionPayload,
    shouldRetrigger,
    shouldShowCompletions,
    type SerializedCompletionIndex,
    mergeCompletionIndex,
} from "../lib/completions.ts";
import {loadCompletionIndex, persistCompletionIndex} from "../lib/completionCache.ts";
import {writeToTerminal} from "../lib/terminalApi.ts";

/** Rows a PageUp/PageDown jump; matches the popup's visible-rows cap. */
const PAGE_SIZE = 8;

/** How long after the last keystroke the as-you-type mode sends its
 *  completion request. Long enough to coalesce typing bursts into one
 *  shell round-trip, short enough to feel immediate (the local filter and
 *  the warm cache give instant feedback in between). */
const REQUEST_DEBOUNCE_MS = 100;

/** Warm-cache bounds: contexts kept per terminal, word sets kept per context
 *  (the in-memory index is unbounded by I/O cost; persistence prunes harder
 *  — see lib/completionCache.ts). */
const INDEX_CTX_CAP = 192;
const INDEX_WORD_CAP = 24;

/** How long after a fetch the write-back to the persistent cache waits, so a
 *  learning burst (several new contexts in a row) costs one save, not many. */
const PERSIST_DEBOUNCE_MS = 3000;

/** How long a fetched set is TRUSTED to skip the correction request entirely:
 *  every in-band request TAB blocks the shell's line editor (measured: even a
 *  backgrounded job from a fish key-binding stalls echo identically to a
 *  foreground one), so requests fire only for unknown data, data older than
 *  this horizon, or an explicit TAB (which always forces the shell's truth).
 *  A horizon this long trades freshness (files created since) for smoothness —
 *  the suggest list is advisory; TAB is the refresh escape hatch. */
const TRUST_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

function isFresh(entry: CompletionCacheEntry): boolean {
    return Date.now() - entry.fetchedAt < TRUST_HORIZON_MS;
}

/** UI cap on the popup's list. Rendering every match (a bare "c" at command
 *  position can yield hundreds) reconciles that many DOM rows per keystroke,
 *  which stalls the main thread right before the echo's paint frame — the
 *  popup felt instant while typed text visibly lagged. One hundred rows is
 *  well past what a filtered suggest list usefully shows; typing narrows. */
const MAX_LIST = 100;

/** Cap a filtered set for display/selection (identity when under the cap). */
function capList(list: CompletionCandidate[]): CompletionCandidate[] {
    return list.length > MAX_LIST ? list.slice(0, MAX_LIST) : list;
}

/** Join a context with a finished word: `""` + "git" → "git"; "git" + "add" → "git add". */
function joinCtx(ctx: string, word: string): string {
    return ctx === "" ? word : `${ctx} ${word}`;
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
    const filtered = capList(filterCandidates(prev.candidates, word));
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
    /** Profile whose persisted warm cache (lib/completionCache.ts) this
     *  terminal loads at mount and writes back to after fetches — same-shell
     *  tabs share coverage across sessions. */
    profileName?: string;
    /** The `shellCompletionsAppendSpace` config (live): accepted completions
     *  gain a trailing space (directories excluded) so arguments can be typed
     *  right away — mirroring the shells' own TAB. */
    appendSpace?: boolean;
    /** Live anchor getter (Term's cursor geometry). The instant-open reads it
     *  AT OPEN TIME so the popup lands where the cursor actually is — a
     *  stale copy of the last response's anchor made it appear at the old
     *  position and jump once the fresh response's anchor replaced it. */
    getAnchor?: () => CompletionAnchor | null;
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
export function useShellCompletions({ptyId, enabled, onType, atPrompt, profileName, getAnchor, appendSpace}: UseShellCompletionsOptions) {
    const [state, setState] = useState<CompletionState | null>(null);
    // Latest-ref bridge so the (stable) key filter and offer callback observe
    // the current state without re-installing the bindings handler.
    const stateRef = useRef<CompletionState | null>(null);
    stateRef.current = state;
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;
    const onTypeRef = useRef(!!onType);
    onTypeRef.current = !!onType;
    const appendSpaceRef = useRef(appendSpace !== false);
    appendSpaceRef.current = appendSpace !== false;
    const atPromptRef = useRef(atPrompt);
    atPromptRef.current = atPrompt;

    // Pending debounced as-you-type request (timer handle).
    const requestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Set by deliberate dismissals so an in-flight request's OSC can't reopen
    // the popup; cleared whenever we intentionally send a request TAB.
    const suppressedRef = useRef(false);
    // Warm index: line-context → (word → cached set). Serves both the
    // instant-open (a known context's stored word that the typed word
    // extends is an exact superset) and open-popup backtracking below the
    // shell-reported base word, so previously fetched positions restore
    // SYNCHRONOUSLY instead of closing and waiting for a round-trip (the
    // fetch is async and in-band — the shell's line editor is
    // single-threaded, so a completion TAB mid-typing delays the echo of
    // everything behind it; serving from the index keeps the main PTY
    // untouched). Keyed by (ctx, word) so the same word under different
    // contexts never aliases.
    const indexRef = useRef(new Map<string, Map<string, CompletionCacheEntry>>());
    // Line tracking between shell responses (see ShadowLine).
    const shadowRef = useRef<ShadowLine | null>(null);
    // Live anchor getter (Term owns the xterm geometry).
    const getAnchorRef = useRef(getAnchor);
    getAnchorRef.current = getAnchor;
    // Persistence: pending debounced save handle + whether anything changed
    // since the last flush.
    const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const persistDirtyRef = useRef(false);
    const profileNameRef = useRef(profileName);
    profileNameRef.current = profileName;

    /** Snapshot the in-memory index into its serializable form. */
    const serializeIndex = useCallback((): SerializedCompletionIndex => {
        const out: SerializedCompletionIndex = {};
        for (const [ctx, words] of indexRef.current) {
            out[ctx] = Object.fromEntries(words);
        }
        return out;
    }, []);

    /** Flush the debounced persistence now (merge-save; log-on-fail inside). */
    const flushPersist = useCallback(() => {
        const profile = profileNameRef.current;
        if (!profile || !persistDirtyRef.current) return;
        persistDirtyRef.current = false;
        persistCompletionIndex(profile, serializeIndex()).then();
    }, [serializeIndex]);

    // Load the profile's persisted index once at mount, merging UNDER the
    // session's own fetches (which are newer by construction), then keep the
    // debounced write-back running until unmount.
    useEffect(() => {
        const profile = profileName;
        if (!profile) return;
        let cancelled = false;
        loadCompletionIndex(profile).then((loaded) => {
            if (cancelled || Object.keys(loaded).length === 0) return;
            const merged = mergeCompletionIndex(serializeIndex(), loaded);
            indexRef.current = new Map(
                Object.entries(merged).map(([ctx, words]) => [ctx, new Map(Object.entries(words))]),
            );
            debug(`Loaded persisted completion cache: ${Object.keys(loaded).length} context(s) for ${profile}`).catch(() => {});
        });
        return () => {
            cancelled = true;
            if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
            flushPersist();
        };
        // profileName is spawn-stable for a terminal; serializeIndex/flushPersist are stable.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** Schedule a debounced persist after a fetch lands. */
    const schedulePersist = useCallback(() => {
        if (!profileNameRef.current) return;
        persistDirtyRef.current = true;
        if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
        persistTimerRef.current = setTimeout(() => {
            persistTimerRef.current = null;
            flushPersist();
        }, PERSIST_DEBOUNCE_MS);
    }, [flushPersist]);

    // Also flush when the whole component goes away (tab close/tear-off).
    useEffect(() => {
        return () => flushPersist();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** Index a fetched set under (ctx, word) for the instant-open and
     *  backtracking (bounded). */
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
        schedulePersist();
    }, [schedulePersist]);

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

    /** The trailing bytes an accepted candidate earns: a space when the
     *  option is on and the insert terminates a word (directories continue a
     *  path instead, and some candidates already carry their own trailing
     *  space). Shared by accept() and the shadow seeding so both agree. */
    const acceptSuffix = useCallback((candidate: CompletionCandidate): string => {
        return appendSpaceRef.current
            && !candidate.insert.endsWith("/")
            && !candidate.insert.endsWith(" ")
            ? " "
            : "";
    }, []);

    /** Write the accept bytes: erase the live word, type the insert (+ the
     *  trailing space when earned), and for a retrigger a follow-up TAB so
     *  the shell re-offers against the new word. When the insert already
     *  equals the word the erase+retype is skipped (the space/TAB still
     *  applies — native TAB on a complete word adds the space). */
    const accept = useCallback(
        (candidate: CompletionCandidate, word: string, retrigger: boolean) => {
            if (requestTimerRef.current !== null) {
                clearTimeout(requestTimerRef.current);
                requestTimerRef.current = null;
            }
            const replace = candidate.insert === word ? "" : insertionBytes(word, candidate);
            const bytes = retrigger ? replace + acceptSuffix(candidate) + "\t" : replace + acceptSuffix(candidate);
            debug(
                `Completion accepted: word=${JSON.stringify(word)} insert=${JSON.stringify(candidate.insert)}` +
                    ` retrigger=${retrigger}`,
            ).catch(() => {});
            if (bytes !== "") {
                if (retrigger) suppressedRef.current = false;
                writeToTerminal(ptyId, bytes).then();
            }
        },
        [acceptSuffix, ptyId],
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
            const parsed = parseCompletionPayload(payload);
            if (!shouldShowCompletions(parsed)) {
                // No candidates, or a completely empty line (command position,
                // nothing typed): the shell answers that with a full
                // "everything" list, which is pure noise. An empty word under
                // a NON-empty context (`gh ` + TAB) is the subcommand list
                // the user explicitly asked for — it flows through.
                close();
                return;
            }
            const {ctx, word, candidates} = parsed;
            indexPut(ctx, word, candidates);
            // The response IS the ground truth of where the line is.
            shadowRef.current = {ctx, word};
            const live = stateRef.current;
            const typedAhead = !!live && live.ctx === ctx && live.word !== word && live.word.startsWith(word);
            if (typedAhead) {
                // A debounced request raced further typing: the fresh set is
                // for a PREFIX of the live word, so filter it locally (exact —
                // the set is a superset for any longer word) and keep the live
                // word/anchor/selection instead of regressing the popup.
                const filtered = capList(filterCandidates(candidates, live.word));
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
                // Unambiguous: complete silently like native TAB, no popup —
                // insert (+ trailing space), with directories cascading into
                // their contents instead. A complete word just earns the
                // space, exactly like the shell's own TAB.
                close();
                accept(candidates[0], word, shouldRetrigger(candidates[0]));
                return;
            }
            info(`Completion popup opened: ${candidates.length} candidates for word=${word}`).catch(() => {});
            setState({
                ctx,
                word,
                baseWord: word,
                candidates,
                filtered: capList(candidates),
                selected: 0,
                anchor,
            });
        },
        [accept, close, indexPut],
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
        if (!shadow) return null;
        // Anchor read NOW — the live cursor, not a stale copy from the last
        // response — so the popup never appears at an old position and jump.
        const anchor = getAnchorRef.current?.();
        if (!anchor) return null;
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
        const filtered = capList(filterCandidates(entry.candidates, word));
        if (filtered.length === 0) return null;
        debug(`Completion popup instant-open (ctx=${JSON.stringify(shadow.ctx)} word=${word})`).catch(() => {});
        setState({
            ctx: shadow.ctx,
            word,
            baseWord: bestWord,
            candidates: entry.candidates,
            filtered,
            selected: 0,
            anchor,
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

    /** A command started executing (Term's current-command tracking): the
     *  next prompt is a fresh empty line by definition, so the shadow resets
     *  to the known state instead of being invalidated — typing at the next
     *  prompt can instant-open from the command-position cache. */
    const onCommandStart = useCallback(() => {
        shadowRef.current = {ctx: "", word: ""};
    }, []);

    /** After accepting, the line state is known — the shadow stays valid for
     *  further typing instead of being invalidated: the last token is the
     *  insert text, or with a trailing space appended the word boundary has
     *  already happened (context advanced, word empty). (The anchor needs no
     *  bookkeeping: the instant-open reads live cursor geometry at open.) */
    const seedShadowAfterAccept = useCallback(
        (current: CompletionState, candidate: CompletionCandidate) => {
            const suffix = acceptSuffix(candidate);
            shadowRef.current = suffix === ""
                ? {ctx: current.ctx, word: candidate.insert}
                : {ctx: joinCtx(current.ctx, candidate.insert), word: ""};
        },
        [acceptSuffix],
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
            if (!current) {
                // Popup closed: plain keystrokes are still completion triggers
                // in as-you-type mode, and an explicit TAB (tab-mode) is a
                // request whose response must not stay suppressed. The warm
                // cache can also open the popup instantly for a known context.
                if (isPlainTypingKey(event) || event.key === "Backspace") {
                    if (event.key === " ") {
                        // Word boundary: promote the finished word into the
                        // context. NEVER auto-request — the in-band TAB would
                        // stall the line editor mid-flow; listing the new
                        // context's candidates is what an explicit TAB is for
                        // (and the next keystroke re-queries anyway).
                        const shadow = shadowRef.current;
                        if (shadow && shadow.word !== "") {
                            shadowRef.current = {ctx: joinCtx(shadow.ctx, shadow.word), word: ""};
                        }
                    } else if (isPlainTypingKey(event)) {
                        const word = (shadowRef.current?.word ?? "") + event.key;
                        shadowType(event.key);
                        // Fresh warm-cache hit ⇒ the filtered view IS the
                        // truth; skip the request so the line editor never
                        // stalls behind a needless completion TAB.
                        if (tryInstantOpen(word) !== "fresh") maybeScheduleRequest();
                    } else {
                        // Backspace at a word start would merge into the
                        // previous token — untrackable, drop the shadow (and
                        // with it anything worth requesting). Inside a word it
                        // just shrinks it — re-query only then.
                        if ((shadowRef.current?.word ?? "") === "") {
                            shadowRef.current = null;
                        } else {
                            shadowBackspace();
                            maybeScheduleRequest();
                        }
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
                    const candidate = current.filtered[current.selected];
                    accept(candidate, current.word, true);
                    seedShadowAfterAccept(current, candidate);
                    close();
                    return false;
                }
                case "Enter": {
                    // Enter has ONE role: accept and finish (never cascades —
                    // drilling into the next level is Tab's job). Fully-typed
                    // word: accepting would write nothing, so the Enter means
                    // "run the line" — pass it straight through to the shell.
                    const candidate = current.filtered[current.selected];
                    if (candidate.insert === current.word) {
                        dismiss();
                        return true;
                    }
                    event.preventDefault();
                    accept(candidate, current.word, false);
                    seedShadowAfterAccept(current, candidate);
                    dismiss();
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
                    // through). Backspacing AT an empty base word (the popup
                    // lists `gh `'s subcommands) merges into the previous
                    // token — untrackable, like the popup-closed word-start
                    // case: drop everything and let the key reach the shell.
                    if (current.word === "") {
                        shadowRef.current = null;
                        dismiss();
                        return true;
                    }
                    // Above the shell-reported base word the set is
                    // still an exact superset — refine locally, NO request (an
                    // in-band TAB would block the echo of keys behind it).
                    // Below it the local set is invalid: serve a previously
                    // fetched set for the shorter word from the warm index
                    // SYNCHRONOUSLY (background-refresh via request), and only
                    // on a miss close and let the (debounced) request re-query.
                    shadowBackspace();
                    const word = [...current.word].slice(0, -1).join("");
                    const anchor = anchorShifted(current.anchor, -1);
                    if (word.length >= current.baseWord.length) {
                        setState((prev) => (prev ? refine(prev, word, anchor) : prev));
                        return true;
                    }
                    const cached = indexRef.current.get(current.ctx)?.get(word);
                    if (cached && cached.candidates.length > 0) {
                        setState({
                            ctx: current.ctx,
                            word,
                            baseWord: word,
                            candidates: cached.candidates,
                            filtered: capList(cached.candidates),
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
                        const word = current.word + event.key;
                        const anchor = anchorShifted(current.anchor, 1);
                        const next = refine(current, word, anchor);
                        if (next) {
                            // Filter alive ⇒ exact superset view, NO request —
                            // an in-band TAB here stalled the shell's echo for
                            // the full completion compute on every typing
                            // pause (the very jank this mode exists to avoid).
                            setState({...next, selected: 0});
                        } else {
                            // Word boundary (space) or no local match. A space
                            // seeds the shadow for the NEXT word and closes —
                            // without a request: the in-band TAB would stall
                            // the editor mid-flow (an explicit TAB lists the
                            // new context). Any other dead filter keeps the
                            // re-query.
                            if (event.key === " ") {
                                shadowRef.current = {
                                    // An already-empty word (space over an
                                    // open context list, e.g. `gh ` + space)
                                    // changes nothing — keep the context.
                                    ctx: current.word === "" ? current.ctx : joinCtx(current.ctx, current.word),
                                    word: "",
                                };
                                debug(`Completion popup closed by word boundary`).catch(() => {});
                                setState(null);
                                return true;
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
     *  finish, never cascade. No-op when closed. */
    const acceptCandidate = useCallback(
        (candidate: CompletionCandidate) => {
            const current = stateRef.current;
            if (!current) return;
            accept(candidate, current.word, false);
            seedShadowAfterAccept(current, candidate);
            dismiss();
        },
        [accept, dismiss, seedShadowAfterAccept],
    );

    return {state, offer, handleKey, select, acceptCandidate, close, dismiss, onCommandStart};
}
