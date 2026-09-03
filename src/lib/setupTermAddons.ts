import type {Terminal} from "@xterm/xterm";
import {FloatingFitAddon} from "../lib/FloatingFitAddon.ts";
import {WebLinksAddon} from "@xterm/addon-web-links";
import {Unicode11Addon} from "@xterm/addon-unicode11";
import {UnicodeGraphemesAddon} from "@xterm/addon-unicode-graphemes";
import {ImageAddon} from "@xterm/addon-image";
import {SerializeAddon} from "@xterm/addon-serialize";
import {SearchAddon} from "@xterm/addon-search";
import {WebglAddon} from "@xterm/addon-webgl";
import {isMacOS} from "./platform.ts";
import {openExternal} from "./openerApi.ts";
import {IMAGE_ADDON_SETTINGS} from "../constants.ts";
import {debug, info} from "@tauri-apps/plugin-log";
import type {TerminalProfile} from "../types/terminal.ts";

/** The addons Term keeps handles to after assembly (fit drives the resize
 *  observer; serialize captures the buffer for tear-off; search drives the
 *  in-terminal search bar). */
export interface TermAddonSet {
    fitAddon: FloatingFitAddon;
    serializeAddon: SerializeAddon;
    searchAddon: SearchAddon;
}

/**
 * Assemble the standard addon stack onto an xterm instance: web links,
 * Unicode 11 widths (optionally grapheme clusters), images, fit, WebGL
 * (profile-gated), serialize, and search. Pure with respect to React —
 * extracted from Term's init effect so the effect reads as orchestration.
 */
export function setupTermAddons(term: Terminal, profile: TerminalProfile, id: string): TermAddonSet {
    const webLinksAddon = new WebLinksAddon((event, uri) => {
        if ((event.metaKey && isMacOS()) || event.ctrlKey) {
            openExternal(uri);
        }
    });
    term.loadAddon(webLinksAddon);

    // Unicode 11 width table. xterm ships only Unicode 6 by default, which
    // mis-measures the width of newer emoji / symbols (renders them as 1
    // column instead of 2, scrambling cursor position and forcing extra
    // repaints). Switching the active version to 11 fixes that for any
    // non-ASCII-heavy output (the vtebench unicode bench in particular).
    const unicode11Addon = new Unicode11Addon();
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = "11";

    // Optional grapheme-cluster width rules (experimental). Unicode 11 still
    // splits wide grapheme clusters — emoji ZWJ sequences (🏳️‍🌈), flag pairs,
    // combining marks — each part on its own cell, which mis-aligns them.
    // This addon switches to a grapheme-based provider ("15-graphemes") that
    // treats such a cluster as one cell. On activate it remembers the current
    // version ("11") and restores it on dispose. Higher CPU than 11, so it's
    // opt-in via the profile's `graphemeClusters` render setting.
    if (profile.graphemeClusters) {
        try {
            term.loadAddon(new UnicodeGraphemesAddon());
        } catch (e) {
            info(`Grapheme clusters addon failed to load: ${e}`);
        }
    }

    const imageAddon = new ImageAddon(IMAGE_ADDON_SETTINGS);
    term.loadAddon(imageAddon);

    const fitAddon = new FloatingFitAddon();
    term.loadAddon(fitAddon);

    if (profile.webgl) {
        try {
            const webglAddon = new WebglAddon();
            term.loadAddon(webglAddon);
            debug(`WebGL addon loaded for terminal id=${id}`);
        } catch (e) {
            info(`WebGL addon failed to load, falling back to canvas: ${e}`);
        }
    }

    // SerializeAddon captures the xterm buffer (scrollback + viewport) so a
    // torn-off tab can replay its history in the new window. Loaded for
    // every terminal since any tab can be torn off at any time.
    const serializeAddon = new SerializeAddon();
    term.loadAddon(serializeAddon);

    // SearchAddon powers the in-terminal search bar overlay. Headless: we
    // drive findNext/findPrevious from our own SearchBar component.
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);

    return {fitAddon, serializeAddon, searchAddon};
}
