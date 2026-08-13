/**
 * One-shot lock for "size the main window to fit a terminal profile" at
 * startup. Shared between Term.tsx (when a terminal mounts first) and the
 * empty-state sizer (hooks/useEmptyStateWindowSize.ts, when the app starts with
 * no terminal), so exactly one of them sizes the main window per session and
 * neither clobbers the other — or the restored/remembered size from
 * useWindowGeometry.
 *
 * Previously a module-level `hasAppliedInitialWindowSize` flag inside Term.tsx;
 * extracted so the empty state can participate in the same once-per-session
 * contract without duplicating it.
 */
let applied = false;

/** True once any code path has applied (or deliberately skipped) the initial
 *  main-window sizing this session. */
export function isInitialWindowSizeApplied(): boolean {
    return applied;
}

/** Mark the initial main-window sizing as handled for this session. */
export function markInitialWindowSizeApplied(): void {
    applied = true;
}
