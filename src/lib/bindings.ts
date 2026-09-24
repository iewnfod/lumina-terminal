import {Terminal} from "@xterm/xterm";
import {Actions, Binding, WithKeys} from "../types/config.ts";
import {DEFAULT_BINDINGS} from "../constants.ts";
import {isMacOS} from "./platform.ts";
import {error} from "@tauri-apps/plugin-log";
import {useEffect} from "react";

export function actionSignature(b: Binding): string {
    const args = b.args
        ? JSON.stringify(Object.keys(b.args).sort().map((k) => [k, b.args![k]]))
        : "";
    return `${b.action}|${args}`;
}

/** Parse the `toTab` action's `args.index`: "last" → -1 (the final tab),
 *  otherwise the 0-based index; NaN when absent/invalid (callers ignore the
 *  action then). Shared by App's and Term's action dispatchers so the
 *  semantics cannot drift. */
export function parseTabIndex(args?: Record<string, string>): number {
    if (args?.index === undefined) return NaN;
    return args.index === "last" ? -1 : parseInt(args.index, 10);
}

export function parseBindings(configBindings?: Binding[]): Binding[] {
    if (!configBindings?.length) return [...DEFAULT_BINDINGS];

    const merged = [...configBindings];
    const seen = new Set(configBindings.map(actionSignature));

    for (const def of DEFAULT_BINDINGS) {
        if (!seen.has(actionSignature(def))) {
            merged.push(def);
        }
    }

    return merged;
}

export function bindingToShortcut(
    b: Binding,
): { abbr?: string; content: string }[] {
    // Modifier keys render as plain text (e.g. "Ctrl", "Shift"), not symbols
    // — keeps the style uniform with Shift, which has no glyph. The optional
    // `abbr` (which drives <Kbd.Abbr> symbol rendering) is intentionally left
    // off all modifiers.
    const shortcut: { abbr?: string; content: string }[] = [];
    for (const w of b.with) {
        switch (w) {
            case "ctrl":
                shortcut.push({ content: "Ctrl" });
                break;
            case "shift":
                shortcut.push({ content: "Shift" });
                break;
            case "alt":
                shortcut.push({ content: "Alt" });
                break;
            case "command":
                shortcut.push({ content: "Cmd" });
                break;
            case "CtrlOrCommand":
                shortcut.push({
                    content: isMacOS() ? "Cmd" : "Ctrl",
                });
                break;
        }
    }
    shortcut.push({ content: b.key.length === 1 ? b.key.toUpperCase() : b.key });
    return shortcut;
}

export function findBinding(
    bindings: Binding[],
    action: Actions,
    args?: Record<string, string>,
): Binding | undefined {
    return bindings.find((b) => {
        if (b.action !== action) return false;
        const bKeys = b.args ? Object.keys(b.args) : [];
        const aKeys = args ? Object.keys(args) : [];
        if (bKeys.length !== aKeys.length) return false;
        return aKeys.every((k) => b.args![k] === args![k]);
    });
}

/**
 * Shortcut segments for the "new terminal with this profile" action. Mirrors
 * how the command palette derives it: the default profile uses the generic
 * `newTab` binding (no args); a non-default profile uses its profile-specific
 * binding (`newTab` + `{profileName}`). Returns `undefined` when no binding
 * exists. Centralized so the command palette, the empty-state quick-launch
 * list, and any future surface agree on which shortcut belongs to which
 * profile (single source of truth, §3.2).
 *
 * Takes a structural `{name, default?}` so this pure module need not depend on
 * the terminal types.
 */
export function profileNewTabShortcut(
    bindings: Binding[],
    profile: { name: string; default?: boolean },
): { abbr?: string; content: string }[] | undefined {
    const args = profile.default ? undefined : { profileName: profile.name };
    const b = findBinding(bindings, "newTab", args);
    return b ? bindingToShortcut(b) : undefined;
}
// Stable signature for a key + modifier set. CtrlOrCommand is normalized to its
// platform-specific form (cmd on macOS, ctrl elsewhere) so the same binding
// produces one signature regardless of platform, and conflict detection stays
// consistent. Keys are lowercased for stable comparison.
export function keySignature(key: string, withKeys: WithKeys[]): string {
    const norm = withKeys.map((w) => (w === "CtrlOrCommand" ? (isMacOS() ? "command" : "ctrl") : w));
    return `${key.toLowerCase()}|${[...norm].sort().join(",")}`;
}

/**
 * Auto-repeat suppression, shared by every `loadBindings` install: a key's
 * signature stays "held" from keydown until keyup so OS key repeat doesn't
 * re-fire the action. Module-level (not per-install) because a press started
 * in one terminal can legitimately end in another (tab switch mid-press).
 *
 * xterm's custom handler only sees events delivered to its textarea, so the
 * keyup that releases a signature may never reach it — e.g. an action moves
 * focus elsewhere mid-press (command palette, settings form) or the window
 * blurs. A leaked signature would make the NEXT press of the same shortcut
 * silently swallowed. The window-level keyup mirror and blur clear below
 * close that hole.
 */
const heldKeys = new Set<string>();
if (typeof window !== "undefined") {
    window.addEventListener("keyup", (event) => {
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        for (const sig of heldKeys) {
            if (sig.split("|", 1)[0] === key) heldKeys.delete(sig);
        }
    }, true);
    window.addEventListener("blur", () => heldKeys.clear());
}

/**
 * Exact modifier comparison: every modifier the binding lists must be down
 * AND every other modifier must be up. Presence-only matching would let
 * Ctrl+Alt+T fire a plain ctrl+t binding (swallowing the chord from the
 * shell), and would let a default binding shadow a user's stricter custom
 * one. CtrlOrCommand normalizes per platform (cmd on macOS, ctrl elsewhere).
 */
function modifiersMatch(
    e: {ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean},
    withKeys: string[],
): boolean {
    const isMac = isMacOS();
    const wantCtrl = withKeys.includes("ctrl") || (!isMac && withKeys.includes("CtrlOrCommand"));
    const wantMeta = withKeys.includes("command") || (isMac && withKeys.includes("CtrlOrCommand"));
    const wantShift = withKeys.includes("shift");
    const wantAlt = withKeys.includes("alt");
    return e.ctrlKey === wantCtrl && e.metaKey === wantMeta && e.shiftKey === wantShift && e.altKey === wantAlt;
}

/**
 * While the bindings editor records a new shortcut (hooks/useKeyRecorder),
 * App-level dispatch must stay silent: the recorder's own window capture
 * listener is registered after (and therefore runs after) the one
 * useKeyboardBindings installs in App, so without this flag a chord like
 * Ctrl+W would close the Settings tab before the recorder ever sees it.
 */
let bindingRecorderActive = false;
export function setBindingRecorderActive(active: boolean) {
    bindingRecorderActive = active;
}

// Normalize a key for comparison. Single-character keys are compared case-insensitively so a
// binding stored as "p" still matches event.key "P" when Shift is held (and vice-versa). This
// keeps loadBindings consistent with matchBinding and lets the settings recorder store the
// lowercase form of a letter key alongside an explicit "shift" modifier.
function keyMatches(bindingKey: string, eventKey: string): boolean {
    if (bindingKey.length === 1 && eventKey.length === 1) {
        return bindingKey.toLowerCase() === eventKey.toLowerCase();
    }
    return bindingKey === eventKey;
}

export function loadBindings(
    term: Terminal,
    bindings: Binding[],
    onAction: (action: Actions, args?: Record<string, string>) => void,
    /**
     * Optional keydown pre-filter, consulted BEFORE binding matching. Return
     * false to swallow the key (it never reaches xterm's input pipeline, so
     * the PTY doesn't see it either) — the completion popup uses this to own
     * Tab/arrow/Enter/Escape while it is open. Must read live state via refs
     * (loadBindings captures it once per install).
     */
    intercept?: (event: KeyboardEvent) => boolean,
) {
    term.attachCustomKeyEventHandler((event) => {
        if (event.type === "keyup") {
            // heldKeys is normally released by the window-level keyup mirror
            // (see heldKeys above); this branch is kept as a same-target
            // backstop for events the mirror might miss (e.g. a custom
            // key handler installed by another addon stopping propagation).
            for (const binding of bindings) {
                if (keyMatches(binding.key, event.key)) {
                    heldKeys.delete(keySignature(binding.key, binding.with));
                }
            }
            return true;
        }

        if (event.type !== "keydown") return true;

        if (intercept && !intercept(event)) return false;

        for (const binding of bindings) {
            if (keyMatches(binding.key, event.key)) {
                if (modifiersMatch(event, binding.with)) {
                    // The copy action is dispatched here rather than through
                    // onAction: whether the key may be swallowed depends on
                    // the live selection. With a selection it goes to the
                    // clipboard; without one the binding is skipped so the
                    // key falls through to the shell — plain Ctrl+C stays
                    // SIGINT even when copy is bound to it.
                    if (binding.action === "copy") {
                        const selection = term.getSelection();
                        if (!selection) continue;
                        navigator.clipboard.writeText(selection).catch((e) => error(`Clipboard write failed: ${e}`).catch(() => {}));
                        return false;
                    }
                    const sig = keySignature(binding.key, binding.with);
                    if (heldKeys.has(sig)) return false;
                    heldKeys.add(sig);
                    onAction(binding.action, binding.args);
                    return false;
                }
            }
        }
        return true;
    });
}

export function matchBinding(e: KeyboardEvent, bindings: Binding[]): Binding | null {
    const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    for (const binding of bindings) {
        const bindingKey = binding.key.length === 1 ? binding.key.toLowerCase() : binding.key;
        if (eventKey !== bindingKey) continue;
        if (modifiersMatch(e, binding.with)) {
            return binding;
        }
    }
    return null;
}

export function useKeyboardBindings(
    bindings: Binding[],
    onAction: (action: Actions, args?: Record<string, string>) => void,
    enabled: boolean,
) {
    useEffect(() => {
        if (!enabled) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            // A recording in the bindings editor owns the next key press —
            // dispatching a matching action here (Ctrl+W closing the Settings
            // tab, Ctrl+T opening a terminal) would destroy the recording.
            if (bindingRecorderActive) return;
            const matched = matchBinding(e, bindings);
            if (matched) {
                e.preventDefault();
                e.stopPropagation();
                onAction(matched.action, matched.args);
            }
        };

        window.addEventListener("keydown", handleKeyDown, { capture: true });
        return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
    }, [bindings, onAction, enabled]);
}
