import {Terminal} from "@xterm/xterm";
import {Actions, Binding, WithKeys} from "../types/config.ts";
import {DEFAULT_BINDINGS} from "../constants.ts";
import {isMacOS} from "./platform.ts";
import {debug, error} from "@tauri-apps/plugin-log";
import {useEffect} from "react";

export function actionSignature(b: Binding): string {
    const args = b.args
        ? JSON.stringify(Object.keys(b.args).sort().map((k) => [k, b.args![k]]))
        : "";
    return `${b.action}|${args}`;
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
    copyWithCtrl: boolean = false,
    onWrite?: (data: string) => void,
) {
    const held = new Set<string>();

    term.attachCustomKeyEventHandler((event) => {
        if (event.type === "keyup") {
            for (const binding of bindings) {
                if (keyMatches(binding.key, event.key)) {
                    held.delete(keySignature(binding.key, binding.with));
                }
            }
            return true;
        }

        if (event.type !== "keydown") return true;

        debug(`XTerm Custom Key with key ${event.key} and type ${event.type}`);

        // Copy handling for Ctrl+C / Ctrl+Shift+C on non-macOS.
        // Default: Ctrl+Shift+C copies the selection, Ctrl+C sends SIGINT.
        // When copyWithCtrl is enabled the two are swapped (Ctrl+C copies).
        if (!isMacOS() && event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "c") {
            const shouldCopy = copyWithCtrl ? !event.shiftKey : event.shiftKey;
            if (shouldCopy) {
                const selection = term.getSelection();
                if (selection) {
                    navigator.clipboard.writeText(selection).catch((e) => error(`Clipboard write failed: ${e}`).catch(() => {}));
                }
                return false;
            } else if (copyWithCtrl && event.shiftKey) {
                // Swapped mode: Ctrl+Shift+C sends SIGINT instead.
                onWrite?.("\x03");
                return false;
            }
            // Default mode, plain Ctrl+C: fall through so xterm emits ETX (SIGINT) naturally.
        }

        for (const binding of bindings) {
            if (keyMatches(binding.key, event.key)) {
                let flag = true;
                for (const w of binding.with) {
                    switch (w) {
                        case "ctrl":
                            flag = flag && event.ctrlKey;
                            break;
                        case "shift":
                            flag = flag && event.shiftKey;
                            break;
                        case "alt":
                            flag = flag && event.altKey;
                            break;
                        case "command":
                            flag = flag && event.metaKey;
                            break;
                        case "CtrlOrCommand":
                            if (isMacOS()) {
                                flag = flag && event.metaKey;
                            } else {
                                flag = flag && event.ctrlKey;
                            }
                            break;
                    }
                }
                if (flag) {
                    const sig = keySignature(binding.key, binding.with);
                    if (held.has(sig)) return false;
                    held.add(sig);
                    onAction(binding.action, binding.args);
                    return false;
                }
            }
        }
        return true;
    });
}

function checkModifiers(e: KeyboardEvent | { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }, withKeys: string[]): boolean {
    for (const w of withKeys) {
        switch (w) {
            case "ctrl":
                if (!e.ctrlKey) return false;
                break;
            case "shift":
                if (!e.shiftKey) return false;
                break;
            case "alt":
                if (!e.altKey) return false;
                break;
            case "command":
                if (!e.metaKey) return false;
                break;
            case "CtrlOrCommand":
                if (isMacOS() ? !e.metaKey : !e.ctrlKey) return false;
                break;
        }
    }
    return true;
}

export function matchBinding(e: KeyboardEvent, bindings: Binding[]): Binding | null {
    const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    for (const binding of bindings) {
        const bindingKey = binding.key.length === 1 ? binding.key.toLowerCase() : binding.key;
        if (eventKey !== bindingKey) continue;
        if (checkModifiers(e, binding.with)) {
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
