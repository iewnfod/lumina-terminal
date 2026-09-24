import {useEffect} from "react";
import {WithKeys} from "../types/config.ts";
import {modifiersFromEvent} from "../lib/bindingsSettings.ts";
import {setBindingRecorderActive} from "../lib/bindings.ts";

/**
 * Global keydown recorder for the bindings editor: while `recordingIndex` is
 * non-null, the next real key press (with a modifier) is committed via
 * `onRecord` and recording ends. Esc cancels. Pure modifier taps are ignored
 * so the user can chord (Ctrl, then Shift, then the letter) without committing
 * on the first modifier.
 *
 * While recording, App-level binding dispatch is suppressed via
 * setBindingRecorderActive: this hook's window capture listener registers
 * after (and runs after) useKeyboardBindings' — without the flag, a chord
 * like Ctrl+W would close the Settings tab before the recorder sees it.
 *
 * Extracted from BindingsSettings so the component renders rows instead of
 * owning window-level key capture.
 */
export function useKeyRecorder(
    recordingIndex: number | null,
    onRecord: (index: number, key: string, withKeys: WithKeys[]) => void,
    onCancel: () => void,
) {
    useEffect(() => {
        if (recordingIndex === null) return;
        setBindingRecorderActive(true);
        const handler = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();

            // Esc always cancels recording.
            if (e.key === "Escape") {
                onCancel();
                return;
            }
            // Ignore pure modifier presses (don't commit until a real key is pressed).
            if (["Control", "Shift", "Alt", "Meta", "ContextMenu"].includes(e.key)) return;

            const withKeys = modifiersFromEvent(e);
            // A binding must include at least one accelerator (modifier). If the
            // user pressed a bare key with no modifier, stay in recording mode
            // and let them try again.
            if (!withKeys) return;

            // For a single-letter key, Shift is reflected in e.key (uppercase).
            // Store the lowercase key so bindingToShortcut / matchBinding (which
            // compare case-insensitively for length-1 keys and check shiftKey)
            // stay consistent with the existing default convention.
            const isLetter = e.key.length === 1 && /[a-zA-Z]/.test(e.key);
            const key = isLetter ? e.key.toLowerCase() : e.key;

            onRecord(recordingIndex, key, withKeys);
            onCancel();
        };
        window.addEventListener("keydown", handler, {capture: true});
        return () => {
            window.removeEventListener("keydown", handler, {capture: true});
            setBindingRecorderActive(false);
        };
    }, [recordingIndex, onRecord, onCancel]);
}
