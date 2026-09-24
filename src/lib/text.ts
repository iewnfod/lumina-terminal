/**
 * UTF-16-safe string slicing helpers.
 *
 * JS strings are UTF-16 code-unit sequences. Emoji and other astral-plane
 * characters are encoded as a *surrogate pair* (a high surrogate immediately
 * followed by a low surrogate). Slicing such a string at an arbitrary index —
 * for example when splitting PTY output into bounded chunks for `term.write` —
 * can land *between* the two surrogates, producing a lone high surrogate in
 * one piece and a lone low surrogate in the other. xterm renders lone
 * surrogates as replacement characters / visual glitches, which is the root
 * cause of the "PTY string truncation" visual bug.
 *
 * These helpers never split a surrogate pair.
 *
 * Pure logic (no React) per the lib/ layering rule.
 */

/**
 * Largest index `<= maxLength` at which `str` can be cut without leaving a
 * lone high surrogate at the end of the front piece. If `str[maxLength - 1]`
 * is a high surrogate, returns `maxLength - 1` so the pair stays intact on the
 * remainder; otherwise returns `maxLength` unchanged.
 *
 * Returns 0 only when `maxLength <= 0` or `str` is empty.
 *
 * Use this to bound a prefix slice:
 *   const cut = safeCodeUnitLength(str, n);
 *   const head = str.slice(0, cut);     // never ends mid-surrogate
 *   const tail = str.slice(cut);        // never starts with a low surrogate
 */
export function safeCodeUnitLength(str: string, maxLength: number): number {
    if (maxLength <= 0) return 0;
    const len = str.length;
    if (len <= maxLength) return len;
    // A high surrogate (0xD800–0xDBFF) at the last taken position would be
    // split from its trailing low surrogate. Back up by one to keep the pair.
    if (isHighSurrogate(str.charCodeAt(maxLength - 1))) {
        return maxLength - 1;
    }
    return maxLength;
}

/** True if `code` is a UTF-16 high (leading) surrogate. */
export function isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
}
