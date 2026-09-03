import {useEffect, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {error, info} from "@tauri-apps/plugin-log";

/**
 * How this copy of the app was installed, when it is owned by a system package
 * manager. Mirrors the backend `InstallSource` struct in `utils.rs`.
 */
export interface InstallSource {
	/** Lowercase package-manager family: "pacman" | "dpkg" | "rpm". */
	manager: string;
	/** Owning package name as reported by that manager. */
	package: string;
}

// Module-level cache, mirroring useShells: the install source never changes
// during a run, so one backend call is enough no matter how many components
// mount this hook. invalidateInstallSourceCache() drops it (used by the dev
// mock picker).
//   undefined → not queried yet (still loading)
//   null      → queried; NOT managed by a package manager (in-app updater OK)
//   object    → queried; managed → disable in-app updater
let cached: InstallSource | null | undefined;
let pending: Promise<InstallSource | null> | null = null;
// Notified by invalidateInstallSourceCache so mounted hooks re-read.
const invalidateListeners = new Set<() => void>();

/** localStorage key driving the DEV MOCK below. Exported so the Developer
 *  settings picker writes the same key this hook reads (single definition —
 *  previously the string was duplicated in both files). */
export const MOCK_INSTALL_SOURCE_KEY = "LUMINA_MOCK_INSTALL_SOURCE";

/** Resolve the install source once, memoized module-wide. */
function resolveInstallSource(): Promise<InstallSource | null> {
	if (cached !== undefined) return Promise.resolve(cached);
	if (!pending) {
		// DEV MOCK: force a package-managed install source (see the doc
		// comment on useInstallSource). Sibling of the updater's
		// LUMINA_MOCK_UPDATE; applies live via the Developer settings picker.
		if (import.meta.env.DEV) {
			const mock = typeof localStorage !== "undefined"
				? localStorage.getItem(MOCK_INSTALL_SOURCE_KEY)
				: null;
			if (mock === "pacman" || mock === "dpkg" || mock === "rpm") {
				info(`[install-source] DEV MOCK: forcing ${mock}-managed install`).catch(() => {});
				cached = {manager: mock, package: "lumina-terminal-bin"};
				pending = Promise.resolve(cached);
			}
		}
		if (!pending) {
			pending = invoke<InstallSource | null>("install_source")
				.then((result) => {
					cached = result ?? null;
					return cached;
				})
				.catch((e) => {
					error(`install_source failed: ${e}`).catch(() => {});
					cached = null;
					return null;
				});
		}
	}
	return pending;
}

/**
 * Drop the cached install-source result and notify every mounted
 * useInstallSource, so its next read re-runs detection (DEV MOCK included).
 * Called by the Developer settings mock picker so changes apply live instead
 * of requiring a window reload.
 */
export function invalidateInstallSourceCache(): void {
	cached = undefined;
	pending = null;
	for (const notify of invalidateListeners) {
		notify();
	}
}

/**
 * Detect whether this app was installed by a system package manager
 * (pacman/dpkg/rpm). When it is, the in-app self-updater is disabled and the
 * UI shows the package-manager update command instead — Tauri v2's updater
 * only supports AppImage on Linux, so it fails on `.deb`/pacman-managed
 * installs. Cached module-wide after the first check.
 *
 * Returns:
 *   - `undefined` while the check is in flight (caller may treat as "unknown")
 *   - `null`      when the app is NOT package-manager-managed
 *   - `InstallSource` when it is
 *
 * --- DEV MOCK ---
 * Dev builds run from `target/`, which no package owns, so the real detection
 * can never produce a package-managed result there. To exercise the update
 * modal's package-manager hint in dev, use the Developer settings mock picker
 * (applies live), or set this in the devtools console and reload the window:
 *   localStorage.setItem("LUMINA_MOCK_INSTALL_SOURCE", "pacman")  // or dpkg/rpm
 *   localStorage.removeItem("LUMINA_MOCK_INSTALL_SOURCE")         // back to normal
 * Only honored in dev builds (import.meta.env.DEV).
 */
export function useInstallSource(): InstallSource | null | undefined {
	const [source, setSource] = useState<InstallSource | null | undefined>(cached);

	useEffect(() => {
		let cancelled = false;
		const read = () => {
			resolveInstallSource().then((s) => {
				if (!cancelled) setSource(s);
			});
		};
		read();
		invalidateListeners.add(read);
		return () => {
			cancelled = true;
			invalidateListeners.delete(read);
		};
	}, []);

	return source;
}
