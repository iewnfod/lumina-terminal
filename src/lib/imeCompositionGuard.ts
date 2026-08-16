export function installImeCompositionGuard(textarea: HTMLTextAreaElement): () => void {
    let sawCompositionStart = false;
    let pendingTextareaFallback = false;
    let fallbackMarkerTimer: number | undefined;
    let fallbackValue = "";
    let fallbackSelectionStart = 0;
    let fallbackSelectionEnd = 0;

    const clearFallbackMarker = () => {
        if (fallbackMarkerTimer !== undefined) {
            globalThis.clearTimeout(fallbackMarkerTimer);
            fallbackMarkerTimer = undefined;
        }
        pendingTextareaFallback = false;
        fallbackValue = "";
    };
    const handleKeydown = (event: KeyboardEvent) => {
        if (event.keyCode !== 229) return;
        clearFallbackMarker();
        pendingTextareaFallback = true;
        fallbackValue = textarea.value;
        fallbackSelectionStart = textarea.selectionStart ?? fallbackValue.length;
        fallbackSelectionEnd = textarea.selectionEnd ?? fallbackSelectionStart;
        fallbackMarkerTimer = globalThis.setTimeout(() => {
            fallbackMarkerTimer = undefined;
            pendingTextareaFallback = false;
        }, 0);
    };
    const handleCompositionStart = () => {
        sawCompositionStart = true;
    };
    const handleInput = (rawEvent: Event) => {
        const event = rawEvent as InputEvent;
        if (
            sawCompositionStart ||
            !pendingTextareaFallback ||
            event.inputType !== "insertFromComposition" ||
            typeof event.data !== "string"
        ) {
            return;
        }

        const start = Math.min(fallbackSelectionStart, fallbackSelectionEnd);
        const end = Math.max(fallbackSelectionStart, fallbackSelectionEnd);
        const caret = start + event.data.length;
        // xterm's delayed fallback removes its keydown-time value with String.replace.
        // WebKitGTK can rewrite the textarea during an unmatched IME commit, making
        // that value disappear and causing xterm to send the entire textarea. Restore
        // the precise mutation described by InputEvent.data before the timer runs.
        textarea.value = fallbackValue.substring(0, start) + event.data + fallbackValue.substring(end);
        textarea.setSelectionRange(caret, caret);
    };
    const handleCompositionEnd = (event: CompositionEvent) => {
        if (!sawCompositionStart && pendingTextareaFallback) {
            event.stopImmediatePropagation();
        }
        sawCompositionStart = false;
        clearFallbackMarker();
    };

    textarea.addEventListener("keydown", handleKeydown, true);
    textarea.addEventListener("compositionstart", handleCompositionStart, true);
    textarea.addEventListener("input", handleInput, true);
    textarea.addEventListener("compositionend", handleCompositionEnd, true);

    return () => {
        clearFallbackMarker();
        textarea.removeEventListener("keydown", handleKeydown, true);
        textarea.removeEventListener("compositionstart", handleCompositionStart, true);
        textarea.removeEventListener("input", handleInput, true);
        textarea.removeEventListener("compositionend", handleCompositionEnd, true);
    };
}
