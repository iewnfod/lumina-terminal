/**
 * Updater wrapper (pure, React-free).
 *
 * Wraps `@tauri-apps/plugin-updater` (check/download/install) and
 * `@tauri-apps/plugin-process` (relaunch) so components never call those
 * plugins directly — per AGENTS.md §3.2, all Tauri plugin access lives here.
 */

import { check, type Update, type CheckOptions } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { info, error } from "@tauri-apps/plugin-log";

/** Lifecycle of a single update cycle. */
export type UpdateStatus =
	| "idle"
	| "checking"
	| "upToDate"
	| "available"
	| "downloading"
	| "installing"
	| "error";

/** Metadata about an available update. */
export interface UpdateInfo {
	version: string;
	date?: string;
	body?: string;
}

/** Result of {@link checkForUpdate}. */
export interface CheckResult {
	status: "upToDate" | "available";
	info?: UpdateInfo;
}

/** Result of an operation that may fail. */
export interface UpdateError {
	status: "error";
	error: string;
}

/** Progress reported while downloading an update. */
export interface DownloadProgress {
	/** Downloaded bytes. */
	downloaded: number;
	/** Total bytes (may be 0 if unknown). */
	total: number;
	/** 0–1 fraction, or undefined if total is unknown. */
	fraction?: number;
}

/**
 * Holds an in-flight `Update` handle between check and install.
 *
 * The Tauri v2 API returns an `Update` object from `check()`; the download/
 * install methods live on that object. We keep it module-local so callers only
 * deal with plain data ({@link UpdateInfo}) through this module's functions.
 */
let pendingUpdate: Update | null = null;

/** localStorage key driving the DEV MOCK below. Exported so the Developer
 *  settings picker writes the same key this module reads (single definition —
 *  previously the string was duplicated in both files). */
export const MOCK_UPDATE_KEY = "LUMINA_MOCK_UPDATE";

/**
 * Check the configured endpoints for an update.
 *
 * Returns `{ status: "available", info }` when a newer version exists, or
 * `{ status: "upToDate" }` otherwise. On any failure (network, signature,
 * missing updater plugin, dev build) returns an `error` result so the UI can
 * show a friendly message instead of throwing.
 *
 * Pass `options` to forward headers / timeout to the underlying `check()`.
 *
 * --- DEV MOCK ---
 * To test the update UI without a real release, set this in the devtools
 * console before clicking "Check for Updates":
 *   localStorage.setItem("LUMINA_MOCK_UPDATE", "available")   // fake new version
 *   localStorage.setItem("LUMINA_MOCK_UPDATE", "upToDate")    // force up-to-date
 *   localStorage.setItem("LUMINA_MOCK_UPDATE", "error")       // force error
 *   localStorage.removeItem("LUMINA_MOCK_UPDATE")             // back to normal
 * Only honored in dev builds (import.meta.env.DEV).
 */
export async function checkForUpdate(
	options?: CheckOptions,
): Promise<CheckResult | UpdateError> {
	// DEV MOCK: short-circuit the real check so the UI flow can be exercised
	// without publishing a release. See the doc comment above.
	if (import.meta.env.DEV) {
		const mock = (typeof localStorage !== "undefined"
			? localStorage.getItem(MOCK_UPDATE_KEY)
			: null) as "available" | "upToDate" | "error" | null;
		if (mock === "available") {
			await info("[updater] DEV MOCK: returning fake available update");
			pendingUpdate = null; // install won't work in mock mode — that's expected
			return {
				status: "available",
				info: {
					version: "99.0.0",
					date: new Date().toISOString().slice(0, 10),
					body: [
						"## What's New in 99.0.0 (DEV MOCK)",
						"",
						"- This is a fake update for testing the UI",
						"- Double-click 'You're up to date' on a real latest version to see real notes",
						"- The install button will fail in mock mode (no real package)",
						"",
						"Toggle the mock from devtools console:",
						'  localStorage.setItem("LUMINA_MOCK_UPDATE", "upToDate")',
					].join("\n"),
				},
			};
		}
		if (mock === "upToDate") {
			await info("[updater] DEV MOCK: returning up-to-date");
			return { status: "upToDate" };
		}
		if (mock === "error") {
			await info("[updater] DEV MOCK: returning fake error");
			return { status: "error", error: "DEV MOCK: simulated update check failure" };
		}
	}

	// In debug/dev builds the app is unsigned, so the updater almost always
	// errors. Catch and report rather than letting it throw in the UI.
	const start = Date.now();
	await info(`[updater] checkForUpdate: calling check()...`);
	try {
		const update = await check(options);
		const elapsed = Date.now() - start;
		await info(
			`[updater] check() returned in ${elapsed}ms — available=${update?.available ?? false}`,
		);
		if (update?.available) {
			pendingUpdate = update;
			await info(
				`[updater] update available: v${update.version} (date=${update.date ?? "n/a"})`,
			);
			return {
				status: "available",
				info: {
					version: update.version,
					date: update.date,
					body: update.body,
				},
			};
		}
		pendingUpdate = null;
		await info(`[updater] up to date (current=${update?.currentVersion ?? "n/a"})`);
		return { status: "upToDate" };
	} catch (e) {
		const elapsed = Date.now() - start;
		const msg = e instanceof Error ? e.message : String(e);
		// The stack (when present) rides along in the same log line — the log
		// file is the one place users actually look (console.* never reaches
		// it).
		const stack = e instanceof Error && e.stack ? `\n${e.stack}` : "";
		await error(`[updater] check() failed after ${elapsed}ms: ${msg}${stack}`);
		return {
			status: "error",
			error: msg,
		};
	}
}

/**
 * Download and install the pending update (the one found by the last
 * {@link checkForUpdate}), then relaunch the app.
 *
 * `onProgress` is called repeatedly with download progress. Throws if no
 * update is pending or if download/install fails — callers should catch and
 * surface the error.
 */
export async function downloadAndInstall(
	onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
	if (!pendingUpdate) {
		throw new Error("No pending update — call checkForUpdate() first.");
	}

	await info("[updater] downloadAndInstall: starting download...");
	const start = Date.now();
	// Track total size across events: `Started` gives contentLength once,
	// `Progress` gives per-chunk sizes we accumulate, `Finished` marks 100%.
	let total = 0;
	let downloaded = 0;
	try {
		await pendingUpdate.downloadAndInstall((event) => {
			if (event.event === "Started") {
				if (event.data.contentLength) total = event.data.contentLength;
				info(
					`[updater] download started, total=${total} bytes`,
				).catch(() => {});
			} else if (event.event === "Progress") {
				downloaded += event.data.chunkLength;
			} else if (event.event === "Finished") {
				info(
					`[updater] download finished in ${Date.now() - start}ms`,
				).catch(() => {});
			}
			if (!onProgress) return;
			if (event.event === "Finished") {
				onProgress({ downloaded: total || downloaded, total, fraction: 1 });
			} else if (total > 0) {
				onProgress({ downloaded, total, fraction: downloaded / total });
			} else {
				onProgress({ downloaded, total: 0, fraction: undefined });
			}
		});

		pendingUpdate = null;
		await info("[updater] install complete, relaunching...");
		await relaunch();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		const stack = e instanceof Error && e.stack ? `\n${e.stack}` : "";
		await error(`[updater] download/install failed after ${Date.now() - start}ms: ${msg}${stack}`);
		throw e;
	}
}

/** True when an update is currently pending (checked, not yet installed). */
export function hasPendingUpdate(): boolean {
	return pendingUpdate !== null;
}

/** Forget the pending update without installing it. */
export function clearPendingUpdate(): void {
	pendingUpdate = null;
}
