//! `flush_utf8_pass` (`src/terminal.rs`): one decode + drain step of the PTY
//! reader's streaming UTF-8 — a multi-byte character split across two reads is
//! carried over, a malformed sequence is dropped (the OOM safety net), and
//! valid text is never lost. Plus the Linux `/proc/<pid>/cwd` resolver used by
//! `get_terminal_cwd`.

use lumina_terminal_lib::terminal::flush_utf8_pass;

#[test]
fn ascii_flushes_completely() {
    let mut pending = b"hello".to_vec();
    assert_eq!(flush_utf8_pass(&mut pending), "hello");
    assert!(pending.is_empty());
}

#[test]
fn empty_pending_is_a_noop() {
    let mut pending = Vec::new();
    assert_eq!(flush_utf8_pass(&mut pending), "");
}

#[test]
fn split_multibyte_char_is_carried_across_passes() {
    // '你' = E4 BD A0. Two bytes arrive in one read, the last byte in the next.
    let mut pending = vec![0xE4, 0xBD];
    assert_eq!(flush_utf8_pass(&mut pending), "");
    assert_eq!(pending, vec![0xE4, 0xBD], "incomplete tail must be kept");

    pending.push(0xA0);
    assert_eq!(flush_utf8_pass(&mut pending), "你");
    assert!(pending.is_empty());
}

#[test]
fn split_char_then_more_text_in_same_read() {
    let mut pending = vec![0xE4];
    assert_eq!(flush_utf8_pass(&mut pending), "");

    // Completing the char plus trailing text in one read: the whole buffer is
    // now valid UTF-8, so one pass flushes "你x" together.
    pending.extend_from_slice(&[0xBD, 0xA0, b'x']);
    assert_eq!(flush_utf8_pass(&mut pending), "你x");
    assert!(pending.is_empty());
}

#[test]
fn leading_malformed_byte_is_dropped() {
    // 0xFF can never start a valid sequence — dropping it is what keeps the
    // buffer from growing unbounded (the OOM safety net).
    let mut pending = vec![0xFF, b'a'];
    assert_eq!(flush_utf8_pass(&mut pending), "");
    assert_eq!(pending, b"a");
    assert_eq!(flush_utf8_pass(&mut pending), "a");
}

#[test]
fn valid_prefix_and_malformed_byte_drop_in_one_pass() {
    let mut pending = vec![b'a', 0xFF, b'b'];
    assert_eq!(flush_utf8_pass(&mut pending), "a");
    assert_eq!(pending, b"b");
}

#[test]
fn emoji_split_across_three_passes_reassembles() {
    // '🙂' = F0 9F 99 82, arriving one byte per read.
    let mut pending = vec![0xF0];
    assert_eq!(flush_utf8_pass(&mut pending), "");
    pending.push(0x9F);
    assert_eq!(flush_utf8_pass(&mut pending), "");
    pending.push(0x99);
    assert_eq!(flush_utf8_pass(&mut pending), "");
    pending.push(0x82);
    assert_eq!(flush_utf8_pass(&mut pending), "🙂");
    assert!(pending.is_empty());
}

/// On Linux the cwd resolver reads the `/proc/<pid>/cwd` symlink; point it at
/// this very test process and it must agree with `current_dir`.
#[cfg(target_os = "linux")]
#[test]
fn process_cwd_resolves_own_working_directory() {
    use lumina_terminal_lib::terminal::process_cwd;

    let expected = std::env::current_dir()
        .expect("current_dir")
        .canonicalize()
        .expect("canonicalize");
    let resolved = process_cwd(std::process::id())
        .map(std::path::PathBuf::from)
        .map(|p| p.canonicalize().unwrap_or(p))
        .expect("own cwd resolves");
    assert_eq!(resolved, expected);
}
