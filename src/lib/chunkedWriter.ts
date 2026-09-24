import {Terminal} from "@xterm/xterm";
import {safeCodeUnitLength} from "./text.ts";
import {warn} from "@tauri-apps/plugin-log";

/**
 * Bounded-chunk feeder for `term.write()` with flow control.
 *
 * PTY output arrives over an async IPC channel and is decoded to strings by the
 * backend. This writer hands those strings to xterm in bounded, UTF-16-safe
 * chunks, and — crucially — applies **backpressure based on xterm's own parsing
 * backlog** so the backend never outruns xterm.
 *
 * ## Why this exists
 *
 * `term.write()` does NOT parse synchronously. xterm has its own internal
 * `WriteBuffer` that batches writes and parses them on a ~12ms time-sliced loop.
 * That loop has a **hard limit**: once its internal `_pendingData` exceeds
 * ~47 MiB, `term.write()` throws `"write data discarded, use flow control to
 * avoid losing data"` and the offending chunk is dropped. On heavy workloads
 * (vtebench unicode — per-glyph texture rasterization; vim session replays —
 * dense cursor/SGR/scroll) xterm parses slower than the reader produces, so its
 * pending buffer climbs toward that limit. Once it throws, the unhandled error
 * kills this writer's drain loop and the tab freezes permanently.
 *
 * ## Flow control
 *
 * The fix is the flow control xterm's own error message asks for. Every
 * `term.write(chunk, cb)` registers a callback that fires after xterm has
 * *parsed* that chunk (see xterm's `_innerWrite` — the callback runs right after
 * `_action(data)`, i.e. after `InputHandler.parse`). So at any moment:
 *
 *     inFlight = (bytes handed to term.write) − (bytes whose callback fired)
 *
 * is exactly xterm's un-parsed backlog — the same quantity xterm itself checks
 * against 47 MiB. We track `inFlight` with a counter and drive backpressure from
 * it (with hysteresis): when `inFlight` crosses `THROTTLE_HIGH` the writer asks
 * the backend reader to pause; once callbacks bring it back under
 * `THROTTLE_LOW`, the brake is released. The PTY pipe buffer backpressures the
 * child while we hold the brake, so no data is lost — this is the natural
 * flow-control chain for a PTY.
 *
 * Because `inFlight` is measured at xterm's own parse boundary, it adapts to
 * xterm's actual speed: light output never throttles; heavy unicode/vim output
 * throttles early, well before the 47 MiB cliff.
 *
 * ## Scheduling
 *
 * `drain()` runs as a `MessageChannel` macrotask and feeds chunks until the
 * xterm-in-flight budget would be exceeded, then stops and is re-armed by the
 * next `term.write` callback (which fires after xterm makes progress). This
 * keeps chunks flowing at exactly the rate xterm can absorb, with no busy-wait:
 * when xterm is backed up there's nothing to do but wait for its callbacks.
 *
 * ## Queue representation
 *
 * `pending` is a `string[]` consumed via a `head` index + per-entry `offset`
 * rather than `Array.shift()`. `shift()` is O(n) (it moves every remaining
 * element), so a naive shift-based queue is O(n²) over a long backlog.
 * Consumed entries are reclaimed by `compact()` so the array can't grow
 * without bound.
 *
 * UTF-16 safety: the cut point never lands between the two halves of a
 * surrogate pair (emoji / astral-plane chars) — otherwise both pieces carry a
 * lone surrogate and render as a replacement-char glitch. This is the real
 * cause of "PTY string truncation" visual errors, not the backend (the backend
 * already streams UTF-8-safe). See `safeCodeUnitLength`.
 *
 * Pure logic (no React) per the lib/ layering rule.
 */

/**
 * Two independent backpressure signals, each protecting a different layer:
 *
 * 1. **`inFlight` watermarks** (THROTTLE_HIGH/LOW) — bytes handed to
 *    `term.write` whose xterm parse callback hasn't fired yet. Protects
 *    xterm's internal WriteBuffer (hard limit ~47 MiB, after which it THROWS
 *    "write data discarded"). This is the layer the original backpressure
 *    covered.
 *
 * 2. **`pendingBytes` watermarks** (PENDING_HIGH/LOW) — total bytes sitting in
 *    this writer's `pending` queue, i.e. data the backend already pushed over
 *    the IPC Channel that xterm hasn't even SEEN yet. Protects a different and
 *    subtler limit: Tauri's `Channel` reorders out-of-order messages into a
 *    sparse `_pendingMessages[index]` array on the JS heap. Under high
 *    throughput the reader can outrun the frontend so messages arrive out of
 *    order, and that reordering buffer grows unbounded — observed as a memory
 *    leak / GC-storm freeze in release builds (where xterm is fast enough that
 *    the in-flight signal alone rarely trips). `pendingBytes` is the direct
 *    proxy for that heap pressure, so backpressuring on it keeps the IPC
 *    stream ordered and the reordering buffer near-empty.
 *
 * Backpressure engages when EITHER signal crosses its HIGH watermark; it only
 * releases once BOTH have drained below their LOW watermark. Hysteresis per
 * signal (HIGH != LOW) avoids on/off thrash.
 *
 * Tunable: widen if throughput drops on a fast GPU; narrow for smoother latency
 * on a slow one. The two bands are intentionally staggered (in-flight tighter
 * than pending) so the xterm-parse layer trips first under mixed load.
 */
const THROTTLE_HIGH = 256 * 1024;   // 256 KiB in-flight → apply backpressure
const THROTTLE_LOW = 128 * 1024;    // 128 KiB in-flight → release backpressure
const PENDING_HIGH = 512 * 1024;    // 512 KiB queued → apply backpressure
const PENDING_LOW = 256 * 1024;     // 256 KiB queued → release backpressure

/**
 * Don't hand xterm more than this many bytes in-flight at once. Caps xterm's
 * internal pending buffer well below its 47 MiB discard limit and keeps GC
 * pressure low. This is the per-drain ceiling on the xterm-parse layer; the
 * IPC/heap layer is governed separately by the `pendingBytes` watermarks
 * above. Drain stops at this ceiling and resumes on the next parse callback,
 * so this acts as a natural pacer: feed a chunk → xterm parses a chunk →
 * callback → feed the next.
 */
const MAX_INFLIGHT = 512 * 1024;   // 512 KiB ceiling on in-flight writes

/**
 * Optional sink notified when the writer wants the backend reader to stop/start.
 * Only invoked on boolean transitions (false→true / true→false), never per
 * chunk — so it's cheap to wire straight to a backend `set_throttle` call.
 */
export type OnThrottle = (throttled: boolean) => void;

export class ChunkedWriter {
    private readonly term: Terminal;
    private readonly chunkSize: number;
    /** Incoming data as a queue of strings (append-only; consumed via `head`). */
    private readonly pending: string[] = [];
    /** Index of the first live entry in `pending` (entries before it are spent). */
    private head = 0;
    /** Code units already consumed from `pending[head]`. */
    private offset = 0;
    /** Bytes handed to `term.write` whose parse callback hasn't fired yet. */
    private inFlight = 0;
    /**
     * Total bytes currently sitting in `pending` (data the backend pushed over
     * the IPC Channel that xterm hasn't seen yet). Direct proxy for the
     * Channel→JS heap pressure that Tauri's message-reordering buffer turns
     * into a memory leak under high throughput. See PENDING_HIGH/LOW.
     */
    private pendingBytes = 0;
    private scheduled = false;
    /** Whether the backend reader is currently held in backpressure. */
    private throttled = false;
    private readonly onThrottle?: OnThrottle;
    // Reused macrotask scheduler. Constructed once so every drain re-arm is a
    // zero-delay `postMessage` instead of allocating a new channel.
    private readonly channel: MessageChannel = new MessageChannel();

    constructor(term: Terminal, chunkSize = 1024 * 8, onThrottle?: OnThrottle) {
        this.term = term;
        this.chunkSize = chunkSize;
        this.onThrottle = onThrottle;
        // `port2.postMessage` triggers `port1.onmessage` as a macrotask on the
        // next event loop turn. No payload — drain reads shared state, not the
        // message.
        this.channel.port1.onmessage = () => this.drain();
    }

    /** Schedule the drain loop if it isn't already. */
    private schedule(): void {
        if (!this.scheduled) {
            this.scheduled = true;
            this.channel.port2.postMessage(null);
        }
    }

    private hasPending(): boolean {
        return this.head < this.pending.length;
    }

    /**
     * Drop consumed entries from the front of `pending` so the array (and the
     * string refs it holds) can't grow without bound during a long backlog.
     * Called when fully drained, and periodically while draining.
     */
    private compact(): void {
        if (this.head === 0) return;
        if (this.hasPending()) {
            this.pending.splice(0, this.head);
        } else {
            this.pending.length = 0;
        }
        this.head = 0;
    }

    /**
     * Called after xterm finishes parsing a chunk we handed it (via the
     * `term.write(chunk, cb)` callback). Decrements the in-flight counter and,
     * if backpressure was applied and the backlog has now receded, releases it.
     * Also re-arms the drain: xterm made progress, so there's budget to feed it
     * more if our queue still has data.
     */
    private onChunkParsed = (len: number): void => {
        this.inFlight -= len;
        // Release backpressure only once BOTH layers have drained below their
        // low watermarks. Engaging on either signal but releasing on both keeps
        // the protective brake on as long as either layer is under pressure
        // (e.g. xterm caught up but the pending queue is still full, or vice
        // versa). Hysteresis per signal prevents on/off thrash.
        if (this.throttled
            && this.inFlight <= THROTTLE_LOW
            && this.pendingBytes <= PENDING_LOW) {
            this.throttled = false;
            this.onThrottle?.(false);
        }
        // xterm just made room — feed it more if we have queued data.
        if (this.hasPending()) this.schedule();
    };

    /** Enqueue a decoded string chunk of PTY output for writing. */
    push(data: string): void {
        this.pending.push(data);
        this.pendingBytes += data.length;
        // Engage backpressure from the IPC/heap signal immediately — don't wait
        // for drain(). Under high throughput the Channel can pile megabytes
        // into our queue (and Tauri's reordering buffer) before a single drain
        // tick runs, which is exactly the leak we're preventing. Checking here
        // caps the queue the moment data lands.
        if (!this.throttled && this.pendingBytes >= PENDING_HIGH) {
            this.throttled = true;
            this.onThrottle?.(true);
        }
        this.schedule();
    }

    /** Flush any pending data synchronously (e.g. on dispose). */
    dispose(): void {
        if (this.hasPending()) {
            let rest = "";
            if (this.offset > 0) {
                rest += this.pending[this.head].slice(this.offset);
                this.head++;
            }
            for (let i = this.head; i < this.pending.length; i++) {
                rest += this.pending[i];
            }
            // Same guard as drain(): a pathological backlog here can trip
            // xterm's in-flight cap and throw — out of dispose() that would
            // blow up the caller's unmount path.
            try {
                this.term.write(rest);
            } catch (e) {
                warn(`[writer] dispose term.write THREW: ${e}  backlog=${rest.length}B`).catch(() => {});
            }
        }
        this.pending.length = 0;
        this.head = 0;
        this.offset = 0;
        this.pendingBytes = 0;
        this.scheduled = false;
        // Release any held backpressure so the backend reader doesn't stay
        // paused forever after the writer is gone. inFlight is left nonzero —
        // xterm may still be parsing our final writes, and those callbacks will
        // decrement it; that's harmless since the writer is being torn down.
        if (this.throttled) {
            this.throttled = false;
            this.onThrottle?.(false);
        }
    }

    private drain(): void {
        if (!this.hasPending()) {
            this.scheduled = false;
            this.compact();
            return;
        }

        // Feed xterm chunks while we have queued data AND haven't saturated its
        // in-flight budget. Unlike a wall-clock budget, this directly tracks the
        // one quantity that matters: how much un-parsed data we've shoved at
        // xterm. When inFlight hits the ceiling, stop and let xterm's parse
        // callbacks (→ onChunkParsed) re-arm us once it makes room.
        do {
            if (this.inFlight >= MAX_INFLIGHT) break;

            // Build one chunk by consuming entries from the head of the queue,
            // advancing `head`/`offset` instead of `shift()` (O(1) vs O(n)).
            // The cut point is UTF-16-safe: if it would land between the two
            // halves of a surrogate pair, back up by one code unit.
            let chunk = "";
            let taken = 0;
            while (this.head < this.pending.length && taken < this.chunkSize) {
                const cur = this.pending[this.head];
                const remaining = this.chunkSize - taken;
                const avail = cur.length - this.offset;
                if (avail <= remaining) {
                    // This entry fits entirely — consume the rest and advance.
                    chunk += this.offset === 0 ? cur : cur.slice(this.offset);
                    taken += avail;
                    this.head++;
                    this.offset = 0;
                } else {
                    // Partial entry: take a UTF-16-safe prefix of `remaining`.
                    let cut = safeCodeUnitLength(cur, this.offset + remaining);
                    // Guarantee forward progress even at a surrogate boundary
                    // (only reachable when remaining <= 1 on a high surrogate;
                    // accepting the lone surrogate here is harmless and rare).
                    if (cut <= this.offset) cut = this.offset + 1;
                    chunk += cur.slice(this.offset, cut);
                    taken += cut - this.offset;
                    this.offset = cut;
                }
            }

            // Reclaim dead entries periodically so they don't pile up while a
            // large backlog is mid-drain (compact() is cheap when `head` is
            // small relative to the live tail).
            if (this.head > 256) this.compact();

            // Move `taken` bytes from the pending queue (IPC/heap layer) into
            // xterm's in-flight budget (parse layer): decrement pendingBytes,
            // increment inFlight. inFlight's HIGH check here is the parse-layer
            // trip; pendingBytes's HIGH check already fired in push() the moment
            // data landed, so we only re-check it on the release side
            // (onChunkParsed). Both layers must be clear of their LOW watermark
            // before backpressure releases.
            this.inFlight += taken;
            this.pendingBytes -= taken;
            if (!this.throttled && this.inFlight >= THROTTLE_HIGH) {
                this.throttled = true;
                this.onThrottle?.(true);
            }

            // The callback fires when xterm has PARSED this chunk (after its
            // internal InputHandler.parse runs). That's the real signal that
            // xterm made progress — decrement in-flight then, not on write().
            // Catch the xterm 47MB discard throw so it can't silently kill the
            // drain loop (the freeze symptom).
            const len = taken;
            try {
                this.term.write(chunk, () => this.onChunkParsed(len));
            } catch (e) {
                warn(`[writer] term.write THREW: ${e}  inFlight=${this.inFlight}B  chunk=${chunk.length}B`).catch(() => {});
                // Drop the chunk we couldn't write; in-flight was already
                // incremented for it, so roll it back.
                this.inFlight -= len;
                break;
            }
        } while (this.hasPending() && this.inFlight < MAX_INFLIGHT);

        // Reset the scheduling flag: either we're fully drained, or we stopped
        // because xterm is saturated (inFlight at the ceiling) and must wait for
        // one of its parse callbacks to call schedule() again. Clearing the flag
        // here ensures that schedule() in onChunkParsed will actually post.
        this.scheduled = false;
        if (!this.hasPending()) this.compact();
    }
}
