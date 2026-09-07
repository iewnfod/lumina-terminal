/**
 * Completion-suggestion payload framing + derivation — the frontend half of
 * the terminal-suggest protocol whose shell half lives in
 * `src-tauri/src/shell_integration.rs` (completion_hook_zsh /
 * completion_hook_fish) and whose stream scanner lives in
 * `lib/currentCommand.ts`.
 *
 * Payload (inside `OSC 1337 ; Completions=… ST`):
 *   <ctx> US <word> RS (<insert> US <label> US <desc> RS)*
 *
 * - RS (0x1e) separates the head record and each candidate; US (0x1f)
 *   separates fields. The PTY line discipline rewrites `\n` (ONLCR), and
 *   xterm.js drops 0x1c–0x1f inside OSC — RS/US survive both, and shells can
 *   emit them portably.
 * - `ctx` is the LINE CONTEXT — the command-line tokens before the word being
 *   completed (empty at command position). It keys the frontend's warm cache:
 *   same context + a previously fetched set ⇒ an exact superset of the true
 *   candidates for any longer word, so the popup can open instantly and let
 *   the shell's fresh response correct it.
 * - `word` is the token under the cursor as the shell's line editor sees it;
 *   accepting a candidate erases exactly that many characters (DEL) and types
 *   `insert`.
 * - `label` is what the shell would have displayed (may differ from the
 *   insertable text, e.g. zsh display strings); empty means "same as insert".
 * - `desc` is an optional human description (fish provides these natively,
 *   zsh via _describe display strings).
 *
 * Pure logic (no React) per the lib/ layering rule; covered by
 * tests/completions.test.mjs.
 */

/** ASCII record/unit separators used by the wire format. */
const RS = "\x1e";
const US = "\x1f";

/** One TAB-completion candidate as sent by the shell hook. */
export interface CompletionCandidate {
    /** Text to type after erasing the word (may be shell-escaped, e.g. `My\ Dir/`). */
    insert: string;
    /** Text to display; empty means "same as insert". */
    label: string;
    /** Optional human-readable description shown dimmed. */
    description: string;
}

/** A parsed Completions payload: line context + the word + its candidates. */
export interface CompletionPayload {
    /** Command-line tokens before the word (cache key; "" at command position). */
    ctx: string;
    /** The token under the cursor. */
    word: string;
    candidates: CompletionCandidate[];
}

/** Visual category of a candidate — drives the popup's row icon. */
export type CompletionKind = "folder" | "file" | "command" | "option";

/**
 * Parse a raw `OSC 1337;Completions=` payload (the value between `=` and the
 * terminator). Tolerant by design: a truncated trailing record (chunk split
 * exactly at a payload boundary upstream never truncates — the scanner only
 * emits complete sequences — but a shell bug might) is dropped, not thrown;
 * a head record without a context field degrades to an empty context.
 */
export function parseCompletionPayload(payload: string): CompletionPayload {
    const records = payload.split(RS);
    const head = (records[0] ?? "").split(US);
    const ctx = head[0] ?? "";
    const word = head[1] ?? "";
    const candidates: CompletionCandidate[] = [];
    for (const record of records.slice(1)) {
        const fields = record.split(US);
        const insert = fields[0] ?? "";
        if (insert === "") continue;
        candidates.push({
            insert,
            label: fields[1] ?? "",
            description: fields.slice(2).join(US),
        });
    }
    return {ctx, word, candidates};
}

/**
 * The bytes to write into the PTY to accept `candidate` for `word`:
 * DEL × (code points in word) + the insert text. A PTY DEL (0x7f) erases one
 * CHARACTER in the shell's line editor, so the count is code points (UTF-16
 * surrogates must not double-count — a CJK word of 2 chars erases with 2
 * DELs, not 4), and spread-iteration is the code-point-safe walk.
 */
export function insertionBytes(word: string, candidate: CompletionCandidate): string {
    return "\x7f".repeat([...word].length) + candidate.insert;
}

/** The text a popup row should show for a candidate (label falls back to insert). */
export function candidateLabel(candidate: CompletionCandidate): string {
    return candidate.label !== "" ? candidate.label : candidate.insert;
}

/**
 * Narrow a candidate set to the ones still matching a refined word. Used when
 * the user keeps typing while the popup is open: the shell matched the
 * ORIGINAL word, and every candidate of the longer word is necessarily in
 * that set (v* ⊇ vi*), so filtering locally is exact — no re-request needed.
 * Case-sensitive plain prefix, matching the shells' default file matching.
 */
export function filterCandidates(
    candidates: CompletionCandidate[],
    word: string,
): CompletionCandidate[] {
    return candidates.filter((c) => c.insert.startsWith(word));
}

/**
 * Whether accepting `candidate` should be followed by a fresh completion
 * request (a follow-up TAB byte). Directories always have a meaningful
 * "next level", so drilling in keeps the popup cascading; anything else
 * terminates — an unconditional re-request would loop (accepting "vim"
 * would re-offer [vim, vimdiff] forever, with no way to just run the command).
 */
export function shouldRetrigger(candidate: CompletionCandidate): boolean {
    return candidate.insert.endsWith("/");
}

// ---------------------------------------------------------------------------
// Warm-index persistence (pure helpers; the IO lives in lib/completionCache.ts)
// ---------------------------------------------------------------------------

/** A cached candidate set with its fetch time (ms epoch). */
export interface CompletionCacheEntry {
    candidates: CompletionCandidate[];
    fetchedAt: number;
}

/** The persisted warm index: profile → (line-context → (word → entry)). */
export type SerializedCompletionIndex = Record<string, Record<string, CompletionCacheEntry>>;

/**
 * Prune a serialized index for persistence: per context keep the freshest
 * `wordCap` words, per profile keep the `ctxCap` freshest contexts, and cap
 * each set's candidate list (matching the UI's display cap — more can never
 * be shown). Freshness-ordered pruning keeps the coverage that actually
 * matters (what the user uses) when the bounds bite.
 */
export function pruneCompletionIndex(
    index: SerializedCompletionIndex,
    ctxCap: number,
    wordCap: number,
    setCandidatesCap: number,
): SerializedCompletionIndex {
    const prunedCtxs: [string, Record<string, CompletionCacheEntry>, number][] = [];
    for (const [ctx, words] of Object.entries(index)) {
        const kept = Object.entries(words)
            .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
            .slice(0, wordCap)
            .map(([word, entry]): [string, CompletionCacheEntry] => [
                word,
                {...entry, candidates: entry.candidates.slice(0, setCandidatesCap)},
            ]);
        if (kept.length === 0) continue;
        const newest = kept[0][1].fetchedAt;
        prunedCtxs.push([ctx, Object.fromEntries(kept), newest]);
    }
    prunedCtxs.sort((a, b) => b[2] - a[2]);
    return Object.fromEntries(prunedCtxs.slice(0, ctxCap).map(([ctx, words]) => [ctx, words]));
}

/**
 * Merge two serialized indexes: per (ctx, word) the entry with the newer
 * `fetchedAt` wins. Used at persist time so concurrent tabs of the same
 * profile ACCUMULATE knowledge instead of last-writer-wins clobbering each
 * other, and at load time so persisted entries only fill gaps under whatever
 * the session already fetched.
 */
export function mergeCompletionIndex(
    base: SerializedCompletionIndex,
    additions: SerializedCompletionIndex,
): SerializedCompletionIndex {
    const out: SerializedCompletionIndex = {};
    for (const ctx of new Set([...Object.keys(base), ...Object.keys(additions)])) {
        const words = {...(base[ctx] ?? {})};
        for (const [word, entry] of Object.entries(additions[ctx] ?? {})) {
            const existing = words[word];
            if (!existing || entry.fetchedAt >= existing.fetchedAt) {
                words[word] = entry;
            }
        }
        out[ctx] = words;
    }
    return out;
}

/**
 * Whether a key event is plain typing (a single printable character, no
 * modifiers) — the keys that extend the word being completed and, in the
 * as-you-type mode, schedule a fresh completion request. Structured take so
 * the hook stays React-free around it and tests can drive plain objects.
 */
export function isPlainTypingKey(e: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
}): boolean {
    return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** Categorize a candidate for its row icon. Cosmetic only. */
export function completionKind(candidate: CompletionCandidate): CompletionKind {
    const text = candidate.insert;
    if (text.endsWith("/")) return "folder";
    if (text.startsWith("-")) return "option";
    if (candidate.description !== "") return "command";
    return "file";
}
