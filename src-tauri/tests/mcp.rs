//! `strip_ansi` (`src/mcp.rs`): the plain-text projection of terminal output
//! served to the read-only MCP server — CSI/OSC/DCS removal, control-char
//! dropping, `\n`/`\t` preservation, UTF-8 passthrough, torn-escape safety.

use lumina_terminal_lib::mcp::strip_ansi;

#[test]
fn sgr_colors_are_removed() {
    assert_eq!(strip_ansi("\x1b[31mred\x1b[0m text"), "red text");
    assert_eq!(strip_ansi("\x1b[1;38;2;255;0;0mbold\x1b[m"), "bold");
}

#[test]
fn cursor_moves_and_clears_are_removed() {
    // Includes a private-mode CSI (`?` param byte) — must be consumed too.
    assert_eq!(strip_ansi("\x1b[2J\x1b[H\x1b[?25lhi"), "hi");
    assert_eq!(strip_ansi("\x1b[5Aup\x1b[10Gcol"), "upcol");
}

#[test]
fn osc_sequences_bel_and_st_terminated_are_removed() {
    assert_eq!(strip_ansi("\x1b]0;window title\x07after"), "after");
    assert_eq!(strip_ansi("\x1b]0;t\x1b\\after"), "after");
}

#[test]
fn dcs_sequences_are_removed_up_to_st() {
    assert_eq!(strip_ansi("\x1bP1;2|payload\x1b\\x"), "x");
}

#[test]
fn two_byte_escapes_are_removed() {
    // ESC M (reverse index), ESC 7, ESC = — all in the one-byte dispatch.
    assert_eq!(strip_ansi("\x1bMa\x1b7b\x1b=c"), "abc");
}

#[test]
fn newline_and_tab_survive_but_other_controls_drop() {
    // \r, BEL, backspace, DEL are dropped; \n and \t are kept.
    assert_eq!(strip_ansi("a\rb\n\tc\x07\x08\x7fd"), "ab\n\tcd");
}

#[test]
fn plain_and_multibyte_text_pass_through_untouched() {
    let s = "你好 world ünïcödé 🙂";
    assert_eq!(strip_ansi(s), s);
}

#[test]
fn lone_trailing_escape_does_not_panic() {
    // A torn read can end mid-escape; the scanner must stop, not loop.
    assert_eq!(strip_ansi("abc\x1b"), "abc");
    assert_eq!(strip_ansi("\x1b"), "");
}

#[test]
fn mixed_stream_reduces_to_readable_text() {
    let raw = "\x1b]0;vim\x07\x1b[2;1H\x1b[1merror\x1b[0m: no such file\r\n";
    assert_eq!(strip_ansi(raw), "error: no such file\n");
}
