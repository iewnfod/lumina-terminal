import {useCallback, useEffect, useRef} from "react";
import {setOutputMode} from "../lib/terminalApi.ts";

// How long after the last interaction before we release the LowLatency
// override and let the backend coalesce bursts again for throughput.
const DEBOUNCE_MS = 150;

/**
 * Reports user interaction (typing / mouse / resize) for one terminal to the
 * backend so its reader thread can switch to LowLatency (flush-every-read)
 * during interaction, and back to high-throughput coalescing when idle.
 *
 * The backend `set_output_mode` command is only invoked on boolean transitions
 * (idle ↔ interacting), never per input event — `markInteractive` may be called
 * on every keystroke/mousemove safely. A debounce timer releases the override
 * `DEBOUNCE_MS` after the last activity.
 */
export function useOutputMode(id: string) {
    const lowLatencyRef = useRef(false);
    const timerRef = useRef<number | null>(null);

    const apply = useCallback((next: boolean) => {
        if (lowLatencyRef.current === next) return;
        lowLatencyRef.current = next;
        setOutputMode(id, next).catch(() => {}); // failure logged by invokeWithLog
    }, [id]);

    useEffect(() => {
        return () => {
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
            }
        };
    }, []);

    const markInteractive = useCallback(() => {
        // Entering interaction: arm immediately.
        apply(true);
        // Reset the release timer on every subsequent activity.
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
        }
        timerRef.current = window.setTimeout(() => {
            apply(false);
            timerRef.current = null;
        }, DEBOUNCE_MS);
    }, [apply]);

    return {markInteractive};
}
