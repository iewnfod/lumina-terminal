/** The attribute Tauri's drag-region script (and this app's chrome) uses to
 *  mark draggable surfaces. Kept here so the double-click takeover below
 *  cannot drift from the markup. */
export const DRAG_REGION_ATTRIBUTE = "data-tauri-drag-region";

/** Structural stand-in for the event target — duck-typed instead of
 *  `instanceof Element` so node --test can load this module without a DOM. */
interface AttributeCarrier {
    getAttribute(name: string): string | null;
}

/** True when a mousedown is the second click of a double-click on a window
 *  drag region — the trigger for toggling maximize.
 *
 *  Mirrors the "self hit" semantics of Tauri's injected drag script for bare
 *  `data-tauri-drag-region` attributes (the only kind this app uses): the
 *  event target must be the attributed element itself, so double-clicking an
 *  interactive child (title-bar buttons, profile rows) never toggles, exactly
 *  like single-click dragging skips them. `"deep"` drag regions would need a
 *  path walk, but nothing in this app uses one. */
export function isDragRegionDoubleClick(event: {
    button: number;
    detail: number;
    target: EventTarget | null;
}): boolean {
    if (event.button !== 0 || event.detail !== 2) return false;
    const target = event.target as AttributeCarrier | null;
    if (!target || typeof target.getAttribute !== "function") return false;
    const attr = target.getAttribute(DRAG_REGION_ATTRIBUTE);
    return attr !== null && attr !== "false";
}
