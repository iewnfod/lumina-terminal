use std::{
    collections::HashMap,
    io::Write,
    sync::{Arc, Mutex, atomic::AtomicBool},
};

use portable_pty::{Child, PtyPair};
use tauri::ipc::Channel;

pub type CommandChild = Box<dyn Child + Send + Sync>;
pub type SharedChild = Arc<Mutex<CommandChild>>;
type TerminalWriter = Box<dyn Write + Send>;

/// The PTY writer, wrapped so it can be cloned out of the terminals map and
/// written to WITHOUT holding the map lock: a PTY master write blocks when
/// the slave's input queue is full (a stopped job, an unresponsive TUI, a
/// stalled SSH tab), and holding the single map lock across that write would
/// stall every other terminal's operations.
pub type SharedWriter = Arc<Mutex<TerminalWriter>>;

/// The output sink the reader thread forwards decoded PTY bytes to. Stored as
/// a swappable `Option` so the PTY can be reattached to a different window
/// (tab tear-off): the new window's `reattach_terminal` call replaces this in
/// place, and the reader thread picks up the new channel on its next flush —
/// the old window stops receiving immediately. `None` means no window is
/// currently attached (the reader keeps draining the PTY and discards output
/// until a window reattaches, so the child process never blocks on a full
/// pipe).
pub type OutputChannel = Arc<Mutex<Option<Channel<String>>>>;

/// Soft cap on retained recent output, per terminal, for the read-only MCP
/// server's `get_recent_output` tool. 64 KiB captures the last few screenfuls
/// of a build log / error trace without growing unbounded.
const MAX_RECENT_OUTPUT_BYTES: usize = 64 * 1024;

/// A bounded tail buffer of a terminal's decoded output, kept on the backend
/// so the read-only MCP server can expose "recent output" without round-
/// tripping to the frontend's xterm scrollback. The reader thread appends
/// every flushed chunk here in addition to forwarding it over the IPC channel.
/// Only output produced after the terminal was created is captured. Trims from
/// the front on overflow, snapping to a UTF-8 char boundary so a multi-byte
/// sequence is never split.
#[derive(Default)]
pub struct RecentOutput {
    buf: String,
}

impl RecentOutput {
    /// Append a decoded chunk, trimming the front on overflow.
    pub fn push_str(&mut self, s: &str) {
        self.buf.push_str(s);
        if self.buf.len() > MAX_RECENT_OUTPUT_BYTES {
            let cut = self.buf.len() - MAX_RECENT_OUTPUT_BYTES;
            // Advance to the next UTF-8 char boundary so we never slice a
            // multi-byte sequence in half (which would invalidate the buffer).
            let mut at = cut;
            while at < self.buf.len() && !self.buf.is_char_boundary(at) {
                at += 1;
            }
            self.buf.drain(..at);
        }
    }

    /// Return the full retained tail, or only its last `lines` lines.
    pub fn snapshot(&self, lines: Option<usize>) -> String {
        match lines {
            None => self.buf.clone(),
            Some(n) => {
                let tail: Vec<&str> = self.buf.lines().rev().take(n).collect();
                tail.into_iter().rev().collect::<Vec<_>>().join("\n")
            }
        }
    }
}

/// Everything the backend tracks per terminal. Fields are read/written from
/// the terminal commands and the watcher thread.
pub struct TerminalEntry {
    pub pty_pair: PtyPair,
    pub child: SharedChild,
    pub writer: SharedWriter,
    /// PID of the spawned shell, captured right after spawn via
    /// `Child::process_id()`. Used to distinguish "shell is the foreground
    /// process group" (= idle at prompt) from "a child command is running".
    pub shell_pid: Option<u32>,
    /// Frontend-driven flag: when true, the reader thread flushes every read
    /// immediately (LowLatency) instead of coalescing into large bursts. Set
    /// by the `set_output_mode` command while the user is interacting
    /// (typing / mouse / resize). Default `false`.
    pub force_low_latency: Arc<AtomicBool>,
    /// Frontend-driven flag: when true, the reader thread pauses reading
    /// (backpressure). Set by the `set_throttle` command when the frontend's
    /// write backlog exceeds a high watermark, and cleared once it drains back
    /// below a low watermark — so the reader can never outrun xterm and pile
    /// up unbounded data in the IPC bridge / JS heap (which triggers GC
    /// stalls and freezes on workloads like vtebench unicode / vim sessions).
    /// The PTY's own pipe buffer backpressures the child process while we
    /// stop reading, so no data is lost. Default `false`.
    pub throttled: Arc<AtomicBool>,
    /// Swappable output channel shared with the reader thread. Replaced in
    /// place by `reattach_terminal` when a tab is torn off into a new window,
    /// so the live PTY process can keep streaming to whichever window now
    /// owns it.
    pub output_channel: OutputChannel,
    /// Bounded tail of this terminal's decoded output (see `RecentOutput`),
    /// fed by the reader thread on every flush. Kept on the backend so the
    /// read-only MCP server's `get_recent_output` tool can expose "recent
    /// output" without round-tripping to the frontend xterm scrollback. Only
    /// output produced after the terminal was created is captured.
    pub recent_output: Arc<Mutex<RecentOutput>>,
    /// Executable path of the shell/program this tab runs (the local shell
    /// path, or the `ssh` binary for remote profiles). Surfaced to the
    /// read-only MCP server so an AI client can tell what each tab is.
    pub exe_path: String,
    /// `"local"` or `"remote"` (SSH). Surfaced to the MCP server.
    pub profile_type: Option<String>,
    /// For SSH profiles, the resolved `Host`; `None` for local tabs.
    pub ssh_host: Option<String>,
}

/// How a terminal's child process ended. `code` is the exit code (always
/// present when the wait succeeded); `signal` is the terminating signal NAME
/// on Unix (e.g. "Terminated") when the process was killed by a signal. Both
/// `None` only when the wait itself failed.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

/// A terminal whose child process has exited, kept briefly so the read-only
/// MCP server can still report its exit code (and basic identity) after the
/// live PTY entry is cleaned up. The reader's `recent_output` is NOT carried
/// over — output from before the exit lives only in xterm's scrollback.
#[derive(Clone)]
pub struct ExitedTab {
    pub exit: ExitInfo,
    pub shell: String,
    pub is_ssh: bool,
    pub ssh_host: Option<String>,
}

/// One entry in a tab's command history, fed by shell integration when a
/// command finishes (OSC `CurrentCommandExit=<code>`), paired with the command
/// text from preexec (zsh/fish) or /proc (bash). Surfaced via the read-only
/// MCP server's `list_command_history` and (later) the proactive-suggestion
/// feature.
#[derive(Debug, Clone, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryEntry {
    /// The command line, or argv[0] basename on the bash /proc path. `None`
    /// only if no text was available from either source.
    pub command: Option<String>,
    pub exit_code: i32,
}

#[derive(Default, Clone)]
pub struct TerminalState {
    pub terminals: Arc<Mutex<HashMap<String, TerminalEntry>>>,
    /// The terminal id currently focused in the UI, mirrored from the
    /// frontend via the `set_active_tab` command so the read-only MCP server
    /// can answer `get_active_tab`. The frontend remains the single source of
    /// truth; this is only a cached mirror for the backend's MCP surface.
    pub active_id: Arc<Mutex<Option<String>>>,
    /// Recently-exited terminals (keyed by tab id), so the read-only MCP
    /// server can still report a tab's exit code after its PTY entry is freed.
    /// Bounded to the last few exits by `record_exit`.
    pub recent_exits: Arc<Mutex<HashMap<String, ExitedTab>>>,
    /// Per-tab command history (newest last), fed by shell integration via
    /// `report_command_finished`. Bounded by `record_command`. Read by the
    /// read-only MCP server's `list_command_history`.
    pub command_history: Arc<Mutex<HashMap<String, Vec<CommandHistoryEntry>>>>,
}

impl TerminalState {
    /// Record a recently-exited terminal, trimming to a small cap so this
    /// can't grow unbounded. Trim order is arbitrary (HashMap) — fine, since
    /// this is only a brief tail for MCP exit-code queries, not an ordered log.
    pub fn record_exit(&self, id: String, tab: ExitedTab) {
        const RECENT_EXIT_CAP: usize = 16;
        let Ok(mut exits) = self.recent_exits.try_lock() else {
            log::warn!("record_exit: failed to lock recent_exits, skipping");
            return;
        };
        exits.insert(id, tab);
        while exits.len() > RECENT_EXIT_CAP {
            let Some(key) = exits.keys().next().cloned() else { break };
            exits.remove(&key);
        }
    }

    /// Append a finished command to a tab's history, capped to the last N.
    pub fn record_command(&self, id: String, entry: CommandHistoryEntry) {
        const COMMAND_HISTORY_CAP: usize = 50;
        let Ok(mut hist) = self.command_history.try_lock() else {
            log::warn!("record_command: failed to lock command_history, skipping");
            return;
        };
        let v = hist.entry(id).or_default();
        v.push(entry);
        let overflow = v.len().saturating_sub(COMMAND_HISTORY_CAP);
        if overflow > 0 {
            v.drain(..overflow);
        }
    }

    /// Drop a tab's command history (on close / exit).
    pub fn clear_command_history(&self, id: &str) {
        if let Ok(mut hist) = self.command_history.try_lock() {
            hist.remove(id);
        }
    }
}
