import {openUrl} from "@tauri-apps/plugin-opener";
import {error} from "@tauri-apps/plugin-log";

/**
 * Opener-plugin wrappers (sibling to terminalApi.ts, per AGENTS.md §3.2).
 *
 * A plain `<a target="_blank">` does nothing in the Tauri webview — it cannot
 * spawn browser windows — so every external URL must go through the opener
 * plugin. Components should use `components/ui/ExternalLink.tsx` (built on
 * this) for anchors; call `openExternal` directly only when the anchor is a
 * motion element with its own handlers.
 */

/**
 * Open an external URL in the system browser, logging failures per §3.6.
 * Fire-and-forget; never rejects.
 */
export function openExternal(url: string): void {
	openUrl(url).catch((err) =>
		error(`Failed to open external link ${url}: ${err}`).catch(() => {}),
	);
}
