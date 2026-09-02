import {LazyStore} from "@tauri-apps/plugin-store";
import {error, info} from "@tauri-apps/plugin-log";
import {SESSION_STORE_PATH} from "../constants.ts";

/**
 * Terminal-session persistence — saving the set of open terminal tabs on
 * window close and restoring them on the next launch.
 *
 * This mirrors the {@link lib/tearoff.ts} pattern: a dedicated `LazyStore`
 * (`session.json`, NOT the user's `config.toml`) so session data never
 * pollutes app config. All failures are logged and swallowed so a store
 * hiccup can never block startup or crash on close.
 *
 * Unlike tear-off, a saved session does NOT keep the PTY alive across the
 * quit — the processes die with the app. Restore therefore re-spawns each
 * terminal tab from its saved profile name + live cwd (captured at save
 * time), optionally replays the serialized scrollback before the new shell
 * boots, and re-opens chrome tabs (Settings/About) at their sentinel ids.
 * Tabs (terminal + chrome) are saved and restored in left-to-right order.
 * See hooks/useSessionPersistence.ts for the close/restore orchestration.
 */

const store = new LazyStore(SESSION_STORE_PATH);
const SESSION_KEY = "session";

/** One saved tab. A discriminated union: terminal tabs carry enough to
 * re-spawn (profile name + live cwd + optional scrollback); chrome tabs
 * (Settings/About — no PTY) carry only their sentinel id. Restore re-creates
 * each in left-to-right order, so the union order matches the tab bar. */
export type SavedTab =
    | {
          kind: "terminal";
          /** Name of the profile this tab was running. Used to find the base
           * profile in config.profiles at restore time; if missing/deleted/renamed
           * the tab is skipped with a warn (see useTerminalManager). */
          profileName: string;
          /** The shell's current working directory at save time (captured via
           * getTerminalCwd). Falls back to the profile's static cwd when the live
           * cwd could not be read. Empty string = use the profile default. */
          cwd: string;
          /** Serialized xterm buffer (from the per-Term serializer registered into
           * useTerminalManager.serializeFns), replayed before the new shell boots.
           * Only present when sessionSaveScrollback was on at save time. */
          scrollback?: string;
      }
    | {
          kind: "chrome";
          /** The sentinel id (SETTINGS_TAB_ID / ABOUT_TAB_ID). Restored as-is
           * via the same openChromeTab path the user-facing actions use. */
          chromeId: string;
      };

export interface SavedSession {
    /** Schema version for forward migration. */
    version: 1;
    /** When the session was saved (Date.now()). Diagnostic only. */
    savedAt: number;
    /** Index into `tabs` of the tab that was active at save time, so restore
     * can refocus the exact tab (terminal OR chrome) the user had open.
     * Clamped to the restored-tab range; missing/invalid → last restored tab. */
    activeIndex?: number;
    /** The saved tabs (terminal + chrome), in left-to-right tab order. */
    tabs: SavedTab[];
}

/**
 * Read the saved session (one-shot). Returns null when no session exists or
 * the read fails — the latter is logged but not thrown so the app boots into
 * a normal single-tab state. Does NOT delete the key; the caller clears it
 * after a successful restore via {@link clearSession}.
 */
export async function loadSession(): Promise<SavedSession | null> {
    try {
        const session = await store.get<SavedSession>(SESSION_KEY);
        if (!session) {
            info("No saved session to restore");
            return null;
        }
        info(`Loaded saved session: ${session.tabs?.length ?? 0} tab(s) from ${new Date(session.savedAt).toISOString()}`);
        return session;
    } catch (e) {
        error(`Failed to load saved session: ${e}`).catch(() => {});
        return null;
    }
}

/**
 * Persist (overwrite) the saved session. Failures are logged and swallowed —
 * a failed save must not prevent the window from closing.
 */
export async function saveSession(session: SavedSession): Promise<void> {
    try {
        await store.set(SESSION_KEY, session);
        await store.save();
        info(`Saved session: ${session.tabs.length} tab(s)`);
    } catch (e) {
        error(`Failed to save session: ${e}`).catch(() => {});
    }
}

/** Delete any saved session so the next launch starts fresh. Called after a
 * restore consumes a session, and on close when the user chose not to save
 * (so stale data isn't restored next time). Idempotent. */
export async function clearSession(): Promise<void> {
    try {
        await store.delete(SESSION_KEY);
        await store.save();
        info("Cleared saved session");
    } catch (e) {
        error(`Failed to clear saved session: ${e}`).catch(() => {});
    }
}
