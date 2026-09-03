import {useCallback, useEffect, useRef, useState} from "react";

/**
 * Shared draft state for settings panels.
 *
 * Four settings panels (General, GlobalProfile, Profile, Bindings) each
 * previously re-implemented the same pattern: a local `draft` seeded from a
 * source object, a `useEffect` re-seeding when the source changes externally,
 * an `isDirty` comparison, and a `save` that applies the draft. They drifted
 * in subtle ways (some compared via field-by-field `!==`, one via
 * `JSON.stringify`). This hook collapses them to one correct implementation.
 *
 * `isDirty` uses a deep equality check so nested object/array drafts (e.g.
 * Bindings, profile fields) work without each caller writing its own compare.
 * Panels whose draft carries TRANSIENT fields (Bindings' `__isDefault` flag)
 * pass `isEqual` to compare a normalized projection instead.
 *
 * @param source the immutable "committed" value the draft tracks.
 * @param onCommit called with the current draft when `save()` is invoked. The
 *   caller is responsible for persisting (e.g. `updateConfig(draft)`).
 * @param deps dependency array that, when changed, re-seeds the draft from
 *   `source` (e.g. the config fields the draft mirrors). Pass the same values
 *   the old `useEffect` depended on.
 * @param opts.isEqual optional equality override used for `isDirty` and the
 *   save() no-op guard (defaults to JSON deep equality).
 */
export function useSettingsDraft<T>(
    source: T,
    onCommit: (draft: T) => void,
    deps: ReadonlyArray<unknown>,
    opts?: {isEqual?: (a: T, b: T) => boolean},
): {
    draft: T;
    setDraft: (next: T | ((prev: T) => T)) => void;
    updateDraft: (patch: Partial<T>) => void;
    isDirty: boolean;
    save: () => void;
    reset: () => void;
} {
    const [draft, setDraft] = useState<T>(source);
    // Keep the latest source in a ref so the reseeding effect and save() can
    // read it without restating it in their dependency arrays.
    const sourceRef = useRef(source);
    sourceRef.current = source;
    const onCommitRef = useRef(onCommit);
    onCommitRef.current = onCommit;
    const isEqual = opts?.isEqual ?? jsonEqual;

    // Re-seed when the source (or any tracked dep) changes externally. This
    // mirrors the original panels' behavior: opening settings or receiving a
    // config update resets uncommitted edits.
    useEffect(() => {
        setDraft(sourceRef.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);

    const updateDraft = useCallback((patch: Partial<T>) => {
        setDraft((prev) => ({...prev, ...patch}));
    }, []);

    // Deep equality via JSON serialization. Drafts are plain config objects
    // (no functions/symbols), so this is both correct and avoids forcing every
    // caller to supply a comparator. Keys are not sorted, but the source and
    // draft share the same shape so key order is stable between them.
    const isDirty = !isEqual(source, draft);

    const save = useCallback(() => {
        // Guard: only commit if there's actually a difference, so a stray
        // Save press on a clean form is a no-op (matches prior behavior).
        if (!isEqual(sourceRef.current, draft)) {
            onCommitRef.current(draft);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft, isEqual]);

    const reset = useCallback(() => {
        setDraft(sourceRef.current);
    }, []);

    return {draft, setDraft, updateDraft, isDirty, save, reset};
}

function jsonEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}
