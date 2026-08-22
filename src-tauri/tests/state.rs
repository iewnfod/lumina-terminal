//! Bounded per-tab stores (`src/state.rs`): the `RecentOutput` 64 KiB UTF-8-
//! safe tail behind the MCP `get_recent_output` tool, the recent-exit cap,
//! and the per-tab command-history cap + clear.

use lumina_terminal_lib::state::{
    CommandHistoryEntry, ExitedTab, ExitInfo, RecentOutput, TerminalState,
};

/// The soft cap `RecentOutput` trims to (state.rs: MAX_RECENT_OUTPUT_BYTES).
const CAP: usize = 64 * 1024;

#[test]
fn recent_output_under_cap_is_untouched() {
    let mut ro = RecentOutput::default();
    ro.push_str("hello");
    ro.push_str(" world");
    assert_eq!(ro.snapshot(None), "hello world");
}

#[test]
fn recent_output_snapshot_returns_last_n_lines() {
    let mut ro = RecentOutput::default();
    ro.push_str("l1\nl2\nl3");
    assert_eq!(ro.snapshot(Some(2)), "l2\nl3");
    // Asking for more lines than retained returns everything.
    assert_eq!(ro.snapshot(Some(10)), "l1\nl2\nl3");
}

#[test]
fn recent_output_ascii_overflow_trims_to_cap_exactly() {
    // 70_000 ASCII chars: every byte offset is a char boundary, so the trim
    // lands exactly on the cap and keeps the TAIL.
    let mut ro = RecentOutput::default();
    let pattern: String = "0123456789".repeat(7_000);
    ro.push_str(&pattern);

    let snap = ro.snapshot(None);
    assert_eq!(snap.len(), CAP);
    // 70_000 - 65_536 = 4_464 chars dropped from the front. The pattern has
    // period 10 and 4_464 % 10 = 4, so the retained tail starts at pattern
    // offset 4 ('4') and still ends with the pattern's tail.
    assert!(snap.starts_with("4"));
    assert!(snap.ends_with("789"));
}

#[test]
fn recent_output_cjk_overflow_snaps_to_char_boundary() {
    // '汉' is 3 bytes: 40_000 chars = 120_000 bytes. The byte-level cut
    // (120_000 - 65_536 = 54_464) lands mid-character and must snap FORWARD,
    // never splitting a code point.
    let mut ro = RecentOutput::default();
    ro.push_str(&"汉".repeat(40_000));

    let snap = ro.snapshot(None);
    // Still valid UTF-8 (a split would make this impossible to even hold).
    assert_eq!(snap.chars().count(), snap.len() / 3);
    assert!(snap.chars().all(|c| c == '汉'));
    // Snapped forward by at most 2 bytes past the cap.
    assert!(snap.len() >= CAP - 2 && snap.len() <= CAP + 2);
}

fn exited(id: &str) -> (String, ExitedTab) {
    (
        id.to_string(),
        ExitedTab {
            exit: ExitInfo { code: Some(0), signal: None },
            shell: "/bin/bash".into(),
            is_ssh: false,
            ssh_host: None,
        },
    )
}

#[test]
fn record_exit_is_capped() {
    let state = TerminalState::default();
    for i in 0..20 {
        let (id, tab) = exited(&format!("tab-{i}"));
        state.record_exit(id, tab);
    }
    let len = state.recent_exits.try_lock().expect("lock exits").len();
    assert_eq!(len, 16, "recent exits must cap at 16");
}

#[test]
fn command_history_keeps_last_fifty_per_tab() {
    let state = TerminalState::default();
    for i in 0..60 {
        state.record_command(
            "tab".into(),
            CommandHistoryEntry { command: Some(format!("cmd-{i}")), exit_code: i as i32 },
        );
    }
    // A second tab's history must not interfere.
    state.record_command(
        "other".into(),
        CommandHistoryEntry { command: Some("ls".into()), exit_code: 0 },
    );

    let hist = state.command_history.try_lock().expect("lock history");
    let tab = hist.get("tab").expect("tab history");
    assert_eq!(tab.len(), 50, "per-tab history must cap at 50");
    // The oldest 10 are dropped; entries are newest-last.
    assert_eq!(tab.first().unwrap().command.as_deref(), Some("cmd-10"));
    assert_eq!(tab.last().unwrap().command.as_deref(), Some("cmd-59"));
    assert_eq!(hist.get("other").unwrap().len(), 1);
}

#[test]
fn clear_command_history_drops_only_that_tab() {
    let state = TerminalState::default();
    for id in ["a", "b"] {
        state.record_command(
            id.into(),
            CommandHistoryEntry { command: Some("ls".into()), exit_code: 0 },
        );
    }
    state.clear_command_history("a");
    let hist = state.command_history.try_lock().expect("lock history");
    assert!(hist.get("a").is_none());
    assert_eq!(hist.get("b").unwrap().len(), 1);
}
