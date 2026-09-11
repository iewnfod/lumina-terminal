/**
 * Fetch the release notes (body) for a given version tag from the GitHub
 * Releases API. Used by the About page's "you're up to date" double-click
 * easter egg to show the *current* version's changelog.
 *
 * Returns the body string, or null if the release isn't found / fetch fails
 * (the failure is logged, never thrown).
 */

import {warn} from "@tauri-apps/plugin-log";

const REPO = "iewnfod/lumina-terminal";

export async function fetchReleaseNotes(version: string): Promise<string | null> {
	// The app version has no leading "v"; git tags are prefixed with "v".
	const tag = version.startsWith("v") ? version : `v${version}`;
	const url = `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`;
	try {
		const res = await fetch(url, {
			headers: { Accept: "application/vnd.github+json" },
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { body?: string | null };
		return data.body ?? null;
	} catch (e) {
		warn(`Failed to fetch release notes for ${tag}: ${e}`).catch(() => {});
		return null;
	}
}
