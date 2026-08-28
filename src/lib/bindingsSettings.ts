import {Actions, Binding, WithKeys} from "../types/config.ts";
import {DEFAULT_BINDINGS} from "../constants.ts";
import {actionSignature, keySignature} from "./bindings.ts";

/** All actions a user can bind in the settings UI. `openConfigFile` (opens
 *  config.json) is intentionally excluded — it has no UI affordance. */
export const ALL_ACTIONS: Actions[] = [
    "newTab",
    "closeTab",
    "tearOffTab",
    "openSettings",
    "openCommandPalette",
    "toggleSidebar",
    "toTab",
    "search",
    "copy",
    "selectAll",
];

/** The i18n dictionary shape the label helper needs. Decoupled from the React
 *  hook so this module stays React-free (lib layering rule). */
export type TranslationDict = Record<string, string>;

/** A draft row carries a transient `__isDefault` flag (never persisted) so the
 *  UI can show "restore default" vs "delete" and re-key a default-origin row
 *  back to its original shortcut on delete. */
export type DraftBinding = Binding & { __isDefault?: boolean };

/**
 * Human-readable label for an action (+ its args), localized. `preview` only
 * affects the `newTab` action when no profile is chosen yet: the picker shows
 * the generic "Open Profile" while a bound row shows "Open Profile: Default".
 */
export function actionLabel(
    action: Actions,
    args: Record<string, string> | undefined,
    t: TranslationDict,
    preview?: boolean,
): string {
    switch (action) {
        case "newTab": {
            const name = args?.profileName;
            if (name) return `${t["Open Profile"]}: ${name}`;
            if (preview) {
                return t["Open Profile"];
            } else {
                return `${t["Open Profile"]}: ${t["Default"]}`;
            }
        }
        case "closeTab":
            return t["Close Tab"];
        case "tearOffTab":
            return t["Tear Off Tab"];
        case "openSettings":
            return t["Settings"];
        case "openCommandPalette":
            return t["Open Command Palette"];
        case "toggleSidebar":
            return t["Toggle Sidebar"];
        case "openConfigFile":
            return t["Open Config File"];
        case "search":
            return t["Find in Terminal"];
        case "copy":
            return t["Copy Selection"];
        case "selectAll":
            return t["Select All"];
        case "toTab": {
            const idx = args?.index;
            if (idx === "last") return `${t["Switch to Tab"]}: ${t["Last tab"]}`;
            if (idx !== undefined && /^\d+$/.test(idx)) {
                return `${t["Switch to Tab"]}: ${t["Tab {n}"].replace("{n}", String(+idx + 1))}`;
            }
            return `${t["Switch to Tab"]}: ${idx ?? ""}`;
        }
    }
}

/** Full identity signature: action+args @ key+modifiers. Two bindings are the
 *  "same default row" only when BOTH halves match. */
export function fullSignature(b: Binding): string {
    return `${actionSignature(b)}@${keySignature(b.key, b.with)}`;
}

const DEFAULT_FULL_SIGNATURES = new Set(DEFAULT_BINDINGS.map(fullSignature));

/** A row is "default-origin" when it matches a default binding by BOTH
 *  action+args AND key+modifiers. Tracked per-row so:
 *    - editing a default binding's key keeps it default-origin → "delete"
 *      restores the default key rather than dropping the row;
 *    - a binding the user *added* — even if its action matches a default —
 *      stays deletable, because the flag only follows rows that originated
 *      from the defaults. */
export function matchesDefaultBinding(b: Binding): boolean {
    return DEFAULT_FULL_SIGNATURES.has(fullSignature(b));
}

/** Promote a stored binding to a draft row (tagged with its default-origin
 *  flag). */
export function toDraft(b: Binding): DraftBinding {
    return {...b, __isDefault: matchesDefaultBinding(b)};
}

/** Locate the default binding for a row's action+args so "delete" can restore
 *  the default key. Matches on action signature only (NOT the key), because
 *  the row being restored may have had its key edited away from the default. */
export function findDefaultFor(b: Binding): Binding | undefined {
    const sig = actionSignature(b);
    return DEFAULT_BINDINGS.find((d) => actionSignature(d) === sig);
}

/** Indices of rows whose key signature collides with another row. Drives the
 *  red "conflict" highlighting + Save-disable. */
export function detectConflicts(draft: DraftBinding[]): Set<number> {
    const counts = new Map<string, number>();
    for (const b of draft) {
        const sig = keySignature(b.key, b.with);
        counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
    const set = new Set<number>();
    draft.forEach((b, i) => {
        if ((counts.get(keySignature(b.key, b.with)) ?? 0) > 1) set.add(i);
    });
    return set;
}

/** Indices of rows missing either a key or any accelerator (modifier). Every
 *  binding must have at least one modifier to be reachable. */
export function detectMissingAccelerator(draft: DraftBinding[]): Set<number> {
    const set = new Set<number>();
    draft.forEach((b, i) => {
        if (b.key.trim().length === 0 || b.with.length === 0) set.add(i);
    });
    return set;
}

/** Strip the transient `__isDefault` flag before persisting. */
export function stripDraftFlag(b: DraftBinding): Binding {
    const {__isDefault, ...rest} = b;
    return rest;
}

/** The modifiers a pressed key carried, normalized for storage: a single
 *  letter key is stored lowercase + an explicit "shift" modifier (rather than
 *  relying on e.key's uppercase) so bindingToShortcut / matchBinding stay
 *  consistent with the default convention. Returns null when the press had no
 *  accelerator (a bare key) — the caller should keep recording in that case. */
export function modifiersFromEvent(e: KeyboardEvent): WithKeys[] | null {
    const withKeys: WithKeys[] = [];
    if (e.metaKey) withKeys.push("command");
    if (e.ctrlKey) withKeys.push("ctrl");
    if (e.altKey) withKeys.push("alt");
    if (e.shiftKey) withKeys.push("shift");
    return withKeys.length === 0 ? null : withKeys;
}
