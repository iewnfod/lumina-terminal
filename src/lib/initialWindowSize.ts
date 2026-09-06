/**
 * One-shot lock + show gate for "size the main window to fit a terminal
 * profile" at startup. Shared between Term.tsx (when a terminal mounts first)
 * and the empty-state sizer (hooks/useEmptyStateWindowSize.ts, when the app
 * starts with no terminal), so exactly one of them sizes the main window per
 * session and neither clobbers the other — or the restored/remembered size
 * from useWindowGeometry.
 *
 * Two distinct moments, hence two markers:
 *
 *  - `markInitialWindowSizeApplied` CLAIMS the sizing (sync, before any size
 *    is computed). This is the old semantics: a second Term mounting while the
 *    first tab's setSize is still in flight (e.g. session restore spawning
 *    several tabs in one commit) must not size again.
 *  - `notifyInitialWindowSizeSettled` additionally releases the show gate —
 *    {@link sizeMainWindowToProfile} calls it once the resize has settled (or
 *    immediately on paths that decide no sizing will happen).
 *
 * The show gate exists because the main window's show effect
 * (hooks/config.tsx) races `whenInitialWindowSizeSettled()` against a timeout
 * backstop, so the window appears ONCE at its final size instead of popping at
 * the configured default (600x400) and visibly resizing a beat later. Every
 * startup path that decides the initial size must eventually settle it —
 * apply (Term / empty-state sizer via sizeMainWindowToProfile),
 * skip-for-remembered (useWindowGeometry settles after its restore), or
 * nothing-to-size (the empty-state sizer's no-profile guard) — or the show
 * falls back to the backstop.
 *
 * Previously a module-level `hasAppliedInitialWindowSize` flag inside Term.tsx;
 * extracted so the empty state can participate in the same once-per-session
 * contract without duplicating it.
 */
import {getCurrentWindow} from "@tauri-apps/api/window";
import type {LogicalSize} from "@tauri-apps/api/window";
import {info, error} from "@tauri-apps/plugin-log";
import {profileWindowSize} from "./terminalGeometry.ts";
import type {TerminalProfile} from "../types/terminal.ts";

let applied = false;
let settle: () => void = () => {};
const settled = new Promise<void>((resolve) => {
    settle = resolve;
});

/** True once any code path has applied (or deliberately skipped) the initial
 *  main-window sizing this session. */
export function isInitialWindowSizeApplied(): boolean {
    return applied;
}

/** Claim the initial main-window sizing for this session (sync). See the
 *  module doc for why the claim and the gate release are separate. */
export function markInitialWindowSizeApplied(): void {
    applied = true;
}

/** Mark the initial main-window sizing as handled AND release the show gate.
 *  Call once the sizing setSize invoke has settled (success or failure — the
 *  gate must never hold the window hidden), or immediately on paths that
 *  decide no sizing will happen. */
export function notifyInitialWindowSizeSettled(): void {
    applied = true;
    settle();
}

/** Resolves once the initial main-window sizing has settled (immediately, when
 *  it already happened before the call). The window-show effect in
 *  hooks/config.tsx races this against a timeout backstop. */
export function whenInitialWindowSizeSettled(): Promise<void> {
    return settled;
}

/**
 * Size the main window to `profile`'s rows/cols, handling the hidden-window
 * case that splits startup sizing into two shapes:
 *
 *  - **Warm caches** (cell metrics + chrome offset in lib/cellMetrics.ts, i.e.
 *    every launch after the first for an unchanged font config): the size is
 *    computed offline and applied while the window is still hidden, then the
 *    show gate releases — the window appears once, at its final size.
 *  - **Cold caches** (first run, or after a font-config change): sizing needs
 *    a live layout, which WebKitGTK doesn't produce for hidden windows — so
 *    the gate releases immediately (the window shows at the configured
 *    default, exactly the pre-gate behavior) and the measured size is applied
 *    as soon as layout exists, warming the caches for the next launch.
 *
 * `getContainerSize` returns the terminal-mount-equivalent inner size (the
 * element Term opens xterm into; the empty-state sizer passes its container
 * minus the profile padding) — {0, 0} while the window is hidden/not laid out.
 * `context` only labels the log lines (e.g. "terminal <id>" / "empty state").
 * Assumes the caller already claimed the lock (markInitialWindowSizeApplied)
 * and guarded for main-window/remembered-size.
 */
export function sizeMainWindowToProfile(
    profile: TerminalProfile,
    getContainerSize: () => {width: number, height: number},
    context: string,
): void {
    const win = getCurrentWindow();
    const attempt = (): LogicalSize | null => {
        const {width, height} = getContainerSize();
        return profileWindowSize(profile, width, height);
    };
    const apply = (size: LogicalSize) => {
        win.setSize(size)
            .catch((e: unknown) => {
                error(`Failed to apply initial window size (${context}): ${e}`).catch(() => {});
            })
            .finally(() => {
                notifyInitialWindowSizeSettled();
            });
    };

    const immediate = attempt();
    if (immediate) {
        info(`Applying initial window size for ${context}: ${immediate.width}x${immediate.height}`).catch(() => {});
        apply(immediate);
        return;
    }
    // Hidden with cold caches: release the gate so the window shows at the
    // configured default (old behavior), then size once layout exists.
    info(`Initial window size for ${context} deferred until the window is visible (cold metric caches)`).catch(() => {});
    notifyInitialWindowSizeSettled();
    const deadline = Date.now() + 3000;
    const poll = () => {
        const size = attempt();
        if (size) {
            info(`Applying deferred initial window size for ${context}: ${size.width}x${size.height}`).catch(() => {});
            apply(size);
            return;
        }
        if (Date.now() > deadline) {
            error(`Initial window sizing for ${context} gave up waiting for the window to lay out`).catch(() => {});
            return;
        }
        setTimeout(poll, 50);
    };
    setTimeout(poll, 100);
}
