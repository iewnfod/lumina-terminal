use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{CommandBuilder, PtySize};
use tauri::{ipc::Channel, AppHandle, Emitter, State};

#[cfg(unix)]
use crate::command_tracker::{foreground_command, CommandInfo};
use crate::ssh::SshConfig;
use crate::state::{
    CommandChild, CommandHistoryEntry, ExitedTab, ExitInfo, OutputChannel, RecentOutput,
    SharedChild, TerminalEntry, TerminalState,
};

/// One flush pass of the reader thread's streaming-UTF-8 decode: emit the
/// longest valid UTF-8 prefix of `pending`, then drop a leading malformed
/// sequence (the OOM safety net). An incomplete trailing multi-byte character
/// is kept for the next read; nothing valid is ever dropped. Pure (no channel
/// or state access) — extracted so the split-character and malformed paths are
/// testable in tests/terminal.rs.
pub fn flush_utf8_pass(pending: &mut Vec<u8>) -> String {
    if pending.is_empty() {
        return String::new();
    }
    // Decode the longest valid UTF-8 prefix. Two failure shapes:
    //   1. Trailing INCOMPLETE multi-byte sequence (split across a read
    //      boundary): `error_len` is None — the sequence just needs more
    //      bytes. Keep the tail for the next read; drain only the valid part.
    //   2. A truly MALFORMED sequence (lone continuation byte, overlong
    //      encoding, 0xFF, etc.): `error_len` is Some(n). Those n bytes can
    //      never start a valid sequence, so we must DROP them — otherwise
    //      `valid_up_to()` returns 0 forever, flush becomes a no-op, and
    //      `pending` grows unbounded until OOM. (Real PTY output is virtually
    //      always valid UTF-8, but a torn read can leave a stray byte at the
    //      front; this is the safety net that keeps the buffer bounded.)
    let (valid_len, malformed_len) = match std::str::from_utf8(pending) {
        Ok(_) => (pending.len(), 0),
        Err(e) => (e.valid_up_to(), e.error_len().unwrap_or(0)),
    };
    let mut out = String::new();
    if valid_len > 0 {
        out = std::str::from_utf8(&pending[..valid_len])
            .expect("valid UTF-8 prefix verified above")
            .to_string();
        pending.drain(..valid_len);
    }
    // Drop a malformed sequence so it can't stall the buffer. Only fire when
    // error_len was Some(n) — a None error_len means the tail is a
    // valid-but-incomplete multi-byte char that must be kept.
    if malformed_len > 0 {
        log::warn!(
            "flush_utf8_pass: dropping {} malformed UTF-8 byte(s) at offset {} to unblock pending (len={})",
            malformed_len,
            valid_len,
            pending.len()
        );
        pending.drain(..malformed_len);
    }
    out
}

/// Coarse shell family from the exe path: the lowercased basename, which
/// decides how a "drop to shell after the command" is expressed (POSIX exec
/// vs PowerShell -NoExit vs fish/nu syntax). Public so tests can feed the
/// same normalization the builder uses.
pub fn shell_family(exe_path: &str) -> String {
    std::path::Path::new(exe_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
}

/// The argv (after the shell executable) that runs `startup_command`, given
/// the keepAfterExit mode and the shell family (see `shell_family`).
/// keepAfterExit "shell" drops to an interactive shell after the command
/// instead of letting the shell exit with it (which would close the tab).
/// Pure — the shell-family differences are tested in tests/terminal.rs.
pub fn startup_command_argv(
    startup_command: &str,
    keep_shell: bool,
    shell_base: &str,
    exe_path: &str,
) -> Vec<String> {
    let is_pwsh = shell_base.contains("powershell") || shell_base == "pwsh";
    if keep_shell && is_pwsh {
        // PowerShell has no `exec`; its native "run then stay" flag is
        // -NoExit. -Command <cmd> runs the command and -NoExit keeps
        // the session interactive afterwards, so the PTY (and thus the
        // tab) stays alive until the user exits pwsh.
        vec!["-NoExit".into(), "-Command".into(), startup_command.to_string()]
    } else if keep_shell {
        // POSIX & fish/nu: run the command via `-c`, then `exec` into a
        // fresh interactive shell so the PTY does NOT end with the
        // command — the user can read the output and keep working, and
        // the tab closes only when that shell exits. The exec target is
        // shell-specific:
        //   - fish: `exec fish -i` (fish -c parses fish syntax; `;` and
        //     `exec` work, but `$0` is empty and `--login` is rejected,
        //     so the POSIX `$0` trick below does NOT apply to fish).
        //   - nu: `exec nu` (nu -c + exec; nu rejects --login/-i).
        //   - POSIX (bash/zsh/sh/dash/…): `exec "$0" --login -i`, where
        //     $0 is set by passing exe_path as an extra argv[0] arg
        //     after the -c script (no path escaping needed).
        let script = if shell_base.contains("fish") {
            format!("{}; exec fish -i", startup_command)
        } else if shell_base == "nu" {
            format!("{}; exec nu", startup_command)
        } else {
            format!("{}; exec \"$0\" --login -i", startup_command)
        };
        // POSIX shells read the trailing arg as argv[0] ($0) for the
        // -c script; fish/nu ignore it, so only pass it for POSIX.
        let is_posix = !(shell_base.contains("fish") || shell_base == "nu");
        if is_posix {
            vec![
                "--login".into(),
                "-i".into(),
                "-c".into(),
                script,
                exe_path.to_string(),
            ]
        } else {
            vec!["--login".into(), "-i".into(), "-c".into(), script]
        }
    } else {
        // Run a single command then exit: the shell exits when the
        // command does, so the watcher emits `term-exit-<id>` and the
        // tab closes — the desired behavior for a "launch opencode/vim"
        // profile (keepAfterExit "exit"/"freeze" both let the shell
        // exit; "freeze" only suppresses the frontend's auto-close).
        vec![
            "--login".into(),
            "-i".into(),
            "-c".into(),
            startup_command.to_string(),
        ]
    }
}

/// The remote command string for an SSH profile running `startup_command`.
/// keepAfterExit "shell" appends `; exec $SHELL -l` so an interactive login
/// shell follows the command: the SSH session (and thus the PTY) stays alive
/// until the user exits that shell. Pure — tested in tests/terminal.rs.
pub fn ssh_remote_command(startup_command: &str, keep_shell: bool) -> String {
    if keep_shell {
        format!("{}; exec $SHELL -l", startup_command)
    } else {
        startup_command.to_string()
    }
}

/// Borrowed view of the spawn parameters the command builder consumes —
/// everything from `start_terminal` except the geometry, which the PTY (not
/// the command) consumes.
pub struct ShellCommandParams<'a> {
    pub exe_path: &'a str,
    pub profile_type: Option<&'a str>,
    pub ssh_config: Option<&'a SshConfig>,
    pub cwd: Option<&'a str>,
    pub startup_command: Option<&'a str>,
    pub keep_after_exit: Option<&'a str>,
}

/// Build the PTY command for a terminal: the SSH invocation for remote
/// profiles, otherwise the local shell with startup-command / shell-
/// integration argv. The branchy argv logic lives in the pure helpers above
/// (unit-tested); this is the (untestable-without-an-AppHandle) orchestration
/// that also applies the shared TERM/COLORTERM env and cwd.
pub fn build_shell_command(app: &AppHandle, p: &ShellCommandParams) -> CommandBuilder {
    let keep_shell = p.keep_after_exit == Some("shell");
    let mut c = if p.profile_type == Some("remote") {
        let ssh = p.ssh_config.unwrap_or_else(|| {
            log::error!(
                "start_terminal: remote profile (exe={}) without ssh config",
                p.exe_path
            );
            panic!("SSH config required for remote profile");
        });
        let ssh_exe = if p.exe_path.is_empty() {
            "ssh".to_string()
        } else {
            p.exe_path.to_string()
        };
        let mut c = CommandBuilder::new(ssh_exe);
        let user_host = if let Some(ref user) = ssh.user {
            format!("{}@{}", user, ssh.host)
        } else {
            ssh.host.clone()
        };
        c.arg(&user_host);
        if let Some(port) = ssh.port {
            c.args(&["-p", &port.to_string()]);
        }
        if let Some(ref identity_file) = ssh.identity_file {
            c.args(&["-i", identity_file]);
        } else {
            c.args(&["-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=password"]);
        }
        // Run a command on the remote host instead of an interactive session.
        // `ssh user@host <cmd>` runs the command then disconnects on exit, so
        // the tab closes (matching local startup_command behavior).
        if let Some(ref cmd) = p.startup_command {
            c.arg(ssh_remote_command(cmd, keep_shell));
        }
        log::debug!("Creating terminal with ssh");
        c
    } else {
        let shell_base = shell_family(p.exe_path);
        let mut c = CommandBuilder::new(p.exe_path);
        if let Some(ref cmd) = p.startup_command {
            // The `-c` startup command runs BEFORE the first prompt, so the
            // pre-prompt proxy hooks never fire for it — inject the env-file's
            // current pairs straight onto the PTY env (a spawn-time snapshot;
            // hot proxy changes still only reach plain interactive tabs).
            for (key, value) in crate::proxy::spawn_proxy_env(app) {
                c.env(key, value);
            }
            c.args(&startup_command_argv(cmd, keep_shell, &shell_base, p.exe_path));
        } else {
            // Pure interactive shell. Apply shell-integration injection
            // (bash/zsh/fish) so we can capture per-command exit codes; the
            // helper falls back to `--login -i` for unsupported shells.
            crate::shell_integration::apply_interactive(&mut c, &shell_base, app);
        }
        log::debug!("Creating terminal {:?} with cwd {:?}", p.exe_path, p.cwd);
        c
    };
    c.env("TERM", "xterm-256color");
    // xterm.js renders 24-bit color natively, so advertise it: programs that
    // probe COLORTERM (ls --color, bat, vim, fzf, delta, …) will then emit
    // truecolor escapes instead of falling back to the 256-color palette.
    c.env("COLORTERM", "truecolor");
    if let Some(ref dir) = p.cwd {
        c.cwd(dir);
    }
    c
}

/// Spawn the PTY reader thread: forwards terminal output to the frontend over
/// the (swappable) output channel, coalescing bursts into large chunks during
/// high-throughput output (e.g. `cat bigfile`) and flushing immediately when
/// output is sparse or the user is interacting. Output is decoded
/// streaming-UTF-8 safe: a multi-byte character split across two reads is
/// never dropped (the previous code did `if let Ok(str::from_utf8(..))` which
/// silently discarded the whole chunk on an unlucky split — invisible for
/// ASCII/base64 but dropped CJK/emoji). Extracted from `start_terminal` so
/// the burst-coalescing loop reads as one unit.
#[allow(clippy::too_many_arguments)]
fn spawn_reader_thread(
    id: String,
    mut reader: Box<dyn std::io::Read + Send>,
    output_channel: OutputChannel,
    recent_output: Arc<Mutex<RecentOutput>>,
    force_low_latency: Arc<AtomicBool>,
    throttled: Arc<AtomicBool>,
) {
    use std::io::Read;

    thread::spawn(move || {
        log::debug!("Reader thread started for {}", id);
        // 64KB read buffer (was 8KB): fewer, larger reads for bursty output.
        const READ_BUF_SIZE: usize = 1024 * 64;
        // Enter HighThroughput (coalesce) after this many consecutive fast
        // reads. "Fast" = gap between reads under LOW_SPARSE_GAP. This detects a
        // sustained data stream by READ FREQUENCY rather than read fullness, so
        // high-rate small-packet sources (e.g. `yes`) coalesce just like large
        // bursts (`cat bigfile`, vtebench) — instead of firing one tiny IPC
        // message per partial read.
        const BURST_FAST_READS: u32 = 4;
        // In HighThroughput, flush once pending reaches this size.
        const HIGH_FLUSH_CAP: usize = 1024 * 64;
        // Reads closer together than this count as "fast" (a sustained stream).
        // Tight enough that ordinary interactive typing (gaps ~50ms+) stays in
        // LowLatency, but a continuous producer like `yes` (gaps ~0ms) crosses
        // it immediately.
        const LOW_SPARSE_GAP: Duration = Duration::from_millis(10);

        let mut buffer = vec![0u8; READ_BUF_SIZE];
        // Accumulator holding decoded-pending bytes (also carries an unfinished
        // UTF-8 character across a read boundary).
        let mut pending: Vec<u8> = Vec::with_capacity(READ_BUF_SIZE * 2);
        // Consecutive reads that arrived within LOW_SPARSE_GAP of the previous.
        // Replaces the old full-read-streak: a high rate of reads (regardless of
        // each read's size) is the real signal of a sustained output stream.
        let mut fast_read_streak: u32 = 0;
        let mut last_read = Instant::now();

        // Flush the longest valid UTF-8 prefix of `pending` over the channel.
        // Any trailing incomplete multi-byte sequence is retained for the next
        // read; nothing is ever dropped.
        //
        // The channel is read from the shared `output_channel` field on every
        // flush rather than captured by value, so `reattach_terminal` (tab
        // tear-off) can swap it atomically: the reader picks up the new
        // channel on the next flush and the old window stops receiving.
        let flush = |pending: &mut Vec<u8>| {
            // Decode + drain step is `flush_utf8_pass` (shared, unit-tested);
            // this closure adds the side effects: mirror into the bounded
            // recent-output tail, then forward over the (swappable) channel.
            let s = flush_utf8_pass(pending);
            if s.is_empty() {
                return;
            }
            // Mirror the decoded chunk into the bounded recent-output tail
            // for the read-only MCP server's `get_recent_output`. Done
            // before `s` is moved into the channel send below. try_lock so
            // the reader never blocks if an MCP tool happens to be reading;
            // a skipped mirror just means one fewer chunk in the tail
            // (caught up on the next flush).
            if let Ok(mut recent) = recent_output.try_lock() {
                recent.push_str(&s);
            }
            // Hold the channel lock only long enough to send. If no window
            // is attached (`None`, e.g. mid-tear-off), drop the bytes but
            // keep draining the PTY so the child never blocks on a full
            // pipe.
            let channel_guard = output_channel.lock().unwrap_or_else(|e| {
                log::error!("Failed to lock output channel for terminal {}: {}", id, e);
                panic!("Failed to lock output channel: {}", e);
            });
            if let Some(ch) = channel_guard.as_ref() {
                if let Err(e) = ch.send(s) {
                    log::warn!("Terminal {} output channel send failed: {}", id, e);
                }
            }
            drop(channel_guard);
        };

        loop {
            // Backpressure: when the frontend signals it's overwhelmed (its
            // write backlog exceeded the high watermark), pause reading so we
            // stop piling data into the IPC bridge / JS heap. The PTY pipe
            // buffer backpressures the child in the meantime, so no data is
            // lost — reading just resumes once the frontend catches up.
            while throttled.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(2));
            }
            match reader.read(&mut buffer) {
                Ok(0) => {
                    log::debug!("Terminal {} reader got EOF", id);
                    break;
                }
                Ok(n) => {
                    pending.extend_from_slice(&buffer[..n]);

                    let now = Instant::now();
                    let gap = now - last_read;
                    last_read = now;

                    // Data-driven mode detection. A high rate of reads (each one
                    // arriving soon after the last) means the PTY has a
                    // sustained stream to deliver, so we coalesce into bigger
                    // IPC messages. This keys off READ FREQUENCY, not read size:
                    // `yes` (many tiny reads) coalesces just like `cat bigfile`
                    // (few huge reads). A slow/idle shell or interactive typing
                    // has large gaps, resets the streak, and stays LowLatency.
                    if gap < LOW_SPARSE_GAP {
                        fast_read_streak = fast_read_streak.saturating_add(1);
                    } else {
                        fast_read_streak = 0;
                    }
                    let data_driven_high = fast_read_streak >= BURST_FAST_READS;
                    let force_low = force_low_latency.load(Ordering::Relaxed);
                    let high_throughput = data_driven_high && !force_low;

                    if high_throughput {
                        // Backpressure fast-path: if the frontend has already
                        // signalled it's overwhelmed, do NOT flush — flushing
                        // would push more messages onto the IPC Channel, which
                        // is exactly the heap pressure we're being asked to
                        // relieve (Tauri's out-of-order reordering buffer grows
                        // on the JS side). Hold `pending` here and let the loop
                        // top spin in the `while throttled` wait until the
                        // frontend catches up, then flush the accumulated bytes
                        // in one go once the brake releases. The PTY pipe buffer
                        // backpressures the child meanwhile, so nothing is lost.
                        if throttled.load(Ordering::Relaxed) {
                            continue;
                        }
                        // Coalesce: flush only once we've accumulated enough, or
                        // when this read was partial (pipe likely drained →
                        // finish the burst so the tail isn't delayed until the
                        // next read, which may never come for an idle shell).
                        if pending.len() >= HIGH_FLUSH_CAP || n < READ_BUF_SIZE {
                            flush(&mut pending);
                        }
                    } else {
                        // LowLatency (default / sparse / user interacting): flush
                        // immediately for the lowest possible output delay.
                        flush(&mut pending);
                    }
                }
                Err(e) => {
                    log::error!("Terminal {} reader error: {}", id, e);
                    break;
                }
            }
        }
        // Flush any tail (including a stranded incomplete UTF-8 prefix, though
        // in practice EOF means the stream ended cleanly).
        flush(&mut pending);
        log::debug!("Reader thread ended for {}", id);
    });
}

/// Spawn the watcher thread: polls child process exit, then cleans up. Also
/// tracks the foreground process group of the pty (the fallback path for the
/// "current command" feature) and emits `term-command-<id>` when it changes.
/// Extracted from `start_terminal`.
fn spawn_watcher_thread(
    app: AppHandle,
    state: TerminalState,
    id: String,
    shared_child: SharedChild,
) {
    let term_exit_event_name = format!("term-exit-{}", id);
    #[cfg(unix)]
    let term_command_event_name = format!("term-command-{}", id);
    thread::spawn(move || {
        log::debug!("Watcher thread started for {}", id);
        // The last foreground command reported to the frontend. `None` means
        // nothing reported yet; `Some(CommandInfo { command: "", .. })` means
        // idle at the shell prompt.
        #[cfg(unix)]
        let mut last_command: Option<CommandInfo> = None;
        #[cfg(unix)]
        let mut tick: u32 = 0;
        // The exit code/signal, captured when the child terminates (the loop
        // below breaks with it) and used to record the exit + emit
        // `term-exit-<id>` with it as payload.
        let exit: ExitInfo = loop {
            let exit_info: Option<ExitInfo> = {
                let mut child_guard = shared_child.try_lock().unwrap_or_else(|e| {
                    log::error!("Failed to lock child in watcher {}: {}", id, e);
                    panic!("Failed to lock child in watcher: {}", e);
                });
                match child_guard.try_wait() {
                    Ok(Some(status)) => {
                        let info = ExitInfo {
                            code: Some(status.exit_code() as i32),
                            signal: status.signal().map(|s| s.to_string()),
                        };
                        log::info!(
                            "Child process {} exited with code={} signal={:?}",
                            id,
                            info.code.unwrap_or(-1),
                            info.signal
                        );
                        Some(info)
                    }
                    Ok(None) => None,
                    Err(e) => {
                        log::error!("Child process {} wait error: {}", id, e);
                        Some(ExitInfo {
                            code: None,
                            signal: None,
                        })
                    }
                }
            };
            if let Some(info) = exit_info {
                break info;
            }

            // Foreground-command tracking runs on Unix only (the master pty
            // exposes the foreground process group there). Throttled to once
            // per second (every 5 ticks of the 200ms exit-poll).
            #[cfg(unix)]
            {
                tick = tick.wrapping_add(1);
                if tick % 5 == 0 {
                    let next = match foreground_command(&state, &id) {
                        Some(info) => info,
                        None => CommandInfo {
                            command: String::new(), // idle at the shell prompt
                            privileged: false,
                        },
                    };
                    if Some(&next) != last_command.as_ref() {
                        last_command = Some(next.clone());
                        if let Err(e) = app.emit(&term_command_event_name, next) {
                            log::warn!("Failed to emit term-command for {}: {}", id, e);
                        }
                    }
                }
            }

            thread::sleep(Duration::from_millis(200));
        };

        // Clean up terminal state. Before freeing the PTY entry, snapshot its
        // identity into `recent_exits` along with the exit code, so the
        // read-only MCP server can still answer get_tab / list_recent_exits
        // for this tab after its live entry is gone.
        log::debug!("Cleaning up state for terminal {}", id);
        {
            let mut terminals = state.terminals.try_lock().unwrap_or_else(|e| {
                log::error!("Failed to lock terminals in watcher {}: {}", id, e);
                panic!("Failed to lock terminals in watcher: {}", e);
            });
            if let Some(entry) = terminals.remove(&id) {
                state.record_exit(
                    id.clone(),
                    ExitedTab {
                        exit: exit.clone(),
                        shell: entry.exe_path.clone(),
                        is_ssh: entry.profile_type.as_deref() == Some("remote"),
                        ssh_host: entry.ssh_host.clone(),
                    },
                );
                log::debug!("Terminal {} removed from state (exit recorded)", id);
            } else {
                log::warn!(
                    "Watcher {}: terminal already gone on cleanup",
                    id
                );
            }
        }

        // Notify frontend — payload now carries the exit code/signal, for the
        // (future) proactive-suggestion UI and any frontend exit handling.
        log::debug!("Emitting term-exit event for {}", id);
        if let Err(e) = app.emit(&term_exit_event_name, exit.clone()) {
            log::error!("Failed to emit term-exit event for {}: {}", id, e);
        } else {
            log::debug!("term-exit event emitted for {}", id);
        }
    });
}

#[tauri::command]
pub fn start_terminal(
    app: AppHandle,
    id: String,
    exe_path: String,
    on_output: Channel<String>,
    state: State<TerminalState>,
    cols: Option<u16>,
    rows: Option<u16>,
    profile_type: Option<String>,
    ssh_config: Option<SshConfig>,
    cwd: Option<String>,
    startup_command: Option<String>,
    keep_after_exit: Option<String>,
) {
    {
        let terminals = state.terminals.try_lock().unwrap_or_else(|e| {
            log::error!("Failed to lock terminals for start {}: {}", id, e);
            panic!("Failed to lock terminals: {}", e);
        });
        if terminals.contains_key(&id) {
            log::warn!("Terminal with id {} already exists", id);
            return;
        }
    }

    let pty_system = portable_pty::native_pty_system();
    let size = PtySize {
        rows: rows.unwrap_or(24),
        cols: cols.unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pty_pair = pty_system.openpty(size).unwrap_or_else(|e| {
        log::error!("Failed to open pty for terminal {}: {}", id, e);
        panic!("Failed to open pty: {}", e);
    });

    let cmd = build_shell_command(
        &app,
        &ShellCommandParams {
            exe_path: &exe_path,
            profile_type: profile_type.as_deref(),
            ssh_config: ssh_config.as_ref(),
            cwd: cwd.as_deref(),
            startup_command: startup_command.as_deref(),
            keep_after_exit: keep_after_exit.as_deref(),
        },
    );
    let child: CommandChild = pty_pair.slave.spawn_command(cmd).unwrap_or_else(|e| {
        log::error!("Failed to spawn terminal {}: {}", id, e);
        panic!("Failed to spawn terminal: {}", e);
    });

    pty_pair.master.resize(size).unwrap_or_else(|e| {
        log::error!("Failed to resize pty for terminal {}: {}", id, e);
        panic!("Failed to resize pty: {}", e);
    });

    let reader = pty_pair.master.try_clone_reader().unwrap_or_else(|e| {
        log::error!("Failed to clone reader for terminal {}: {}", id, e);
        panic!("Failed to clone reader: {}", e);
    });
    let writer = pty_pair.master.take_writer().unwrap_or_else(|e| {
        log::error!("Failed to clone writer for terminal {}: {}", id, e);
        panic!("Failed to clone writer: {}", e);
    });

    let shared_child: SharedChild = Arc::new(std::sync::Mutex::new(child));
    let shell_pid = {
        let guard = shared_child.try_lock().unwrap_or_else(|e| {
            log::error!("Failed to lock child for terminal {}: {}", id, e);
            panic!("Failed to lock child: {}", e);
        });
        guard.process_id()
    };
    let force_low_latency = Arc::new(AtomicBool::new(false));
    // Frontend-driven backpressure: when true the reader pauses reading so it
    // can't outrun xterm and pile up unbounded data in the IPC bridge / JS
    // heap (which causes GC stalls and freezes on heavy workloads like
    // vtebench unicode / vim sessions). See `set_throttle` and state.rs.
    let throttled = Arc::new(AtomicBool::new(false));
    // Output channel shared with the reader thread. Stored as a swappable
    // Option so `reattach_terminal` (tab tear-off) can redirect the live PTY
    // stream to a different window without respawning the process.
    let output_channel: OutputChannel = Arc::new(std::sync::Mutex::new(Some(on_output)));
    // Bounded tail of decoded output, mirrored by the reader thread for the
    // read-only MCP server's `get_recent_output` tool. See `RecentOutput`.
    let recent_output: Arc<Mutex<RecentOutput>> = Arc::new(Mutex::new(RecentOutput::default()));

    // Store in state
    {
        let mut terminals = state.terminals.try_lock().unwrap_or_else(|e| {
            log::error!("Failed to lock terminals for state insert {}: {}", id, e);
            panic!("Failed to lock terminals: {}", e);
        });
        terminals.insert(
            id.clone(),
            TerminalEntry {
                pty_pair,
                child: shared_child.clone(),
                writer,
                shell_pid,
                force_low_latency: force_low_latency.clone(),
                throttled: throttled.clone(),
                output_channel: output_channel.clone(),
                recent_output: recent_output.clone(),
                exe_path: exe_path.clone(),
                profile_type: profile_type.clone(),
                ssh_host: ssh_config.as_ref().map(|c| c.host.clone()),
            },
        );
    }

    // Reader + watcher threads (extracted above): the reader forwards PTY
    // output over the swappable channel with burst coalescing; the watcher
    // polls exit, tracks the foreground command, cleans up state, and emits
    // term-exit.
    spawn_reader_thread(
        id.clone(),
        reader,
        output_channel,
        recent_output,
        force_low_latency,
        throttled,
    );
    spawn_watcher_thread(app, state.inner().clone(), id, shared_child);
}

/// Atomically redirect a terminal's PTY output stream to a new channel.
///
/// This is the backend half of "tear off tab into a new window": the original
/// window keeps the PTY process alive (it does NOT call `kill_terminal`), and
/// the new window — after replaying the serialized scrollback into its own
/// xterm — calls this with a fresh `Channel` owned by its webview. The reader
/// thread reads the channel from the shared `output_channel` field on every
/// flush, so this in-place swap takes effect on the very next flush: the old
/// window stops receiving immediately and the new window picks up the live
/// stream. There is no separate "detach" call — replacing the channel IS the
/// detach for the previous holder.
#[tauri::command]
pub fn reattach_terminal(id: String, on_output: Channel<String>, state: State<TerminalState>) {
    let terminals = state.terminals.try_lock().unwrap_or_else(|e| {
        log::error!("Failed to lock terminals for reattach {}: {}", id, e);
        panic!("Failed to lock terminals: {}", e);
    });
    if let Some(entry) = terminals.get(&id) {
        let mut guard = entry.output_channel.lock().unwrap_or_else(|e| {
            log::error!("Failed to lock output channel for reattach {}: {}", id, e);
            panic!("Failed to lock output channel: {}", e);
        });
        *guard = Some(on_output);
        log::info!("Reattached terminal {} to a new window", id);
    } else {
        log::warn!("reattach_terminal: terminal {} not found", id);
    }
}

#[tauri::command]
pub fn kill_terminal(id: String, state: State<TerminalState>) {
    let mut terminals = state.terminals.try_lock().unwrap_or_else(|e| {
        log::error!("Failed to lock terminals for kill {}: {}", id, e);
        panic!("Failed to lock terminals: {}", e);
    });
    if let Some(entry) = terminals.remove(&id) {
        log::info!("Killing terminal {}", id);
        let mut child = entry.child.try_lock().unwrap_or_else(|e| {
            log::error!("Failed to lock child for kill {}: {}", id, e);
            panic!("Failed to lock child: {}", e);
        });
        if let Err(e) = child.kill() {
            log::error!("Failed to kill child process {}: {}", id, e);
        }
    } else {
        log::warn!("Terminal with id {} not found", id);
    }
    // Drop this tab's MCP-side data (recent exit + command history) now that
    // the user closed it, so these bounded stores don't leak closed-tab entries.
    if let Ok(mut exits) = state.recent_exits.try_lock() {
        exits.remove(&id);
    }
    state.clear_command_history(&id);
}

#[tauri::command]
pub fn write_to_terminal(id: String, content: &[u8], state: State<TerminalState>) {
    let mut terminals = state.terminals.try_lock().unwrap_or_else(|e| {
        log::error!("Failed to lock terminals for write {}: {}", id, e);
        panic!("Failed to lock terminals: {}", e);
    });
    if let Some(entry) = terminals.get_mut(&id) {
        entry.writer.write_all(content).unwrap_or_else(|e| {
            log::error!("Failed to write to terminal {}: {}", id, e);
            panic!("Failed to write to terminal: {}", e);
        });
        entry.writer.flush().unwrap_or_else(|e| {
            log::error!("Failed to flush writer for terminal {}: {}", id, e);
            panic!("Failed to flush writer: {}", e);
        });
    } else {
        log::warn!("write_to_terminal: terminal {} not found", id);
    }
}

#[tauri::command]
pub fn resize_terminal(id: String, cols: u16, rows: u16, state: State<TerminalState>) {
    let mut terminals = state.terminals.try_lock().unwrap_or_else(|e| {
        log::error!("Failed to lock terminals for resize {}: {}", id, e);
        panic!("Failed to lock terminals: {}", e);
    });
    if let Some(entry) = terminals.get_mut(&id) {
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        entry.pty_pair.master.resize(size).unwrap_or_else(|e| {
            log::error!("Failed to resize terminal {}: {}", id, e);
            panic!("Failed to resize terminal: {}", e);
        });
    } else {
        log::warn!("resize_terminal: terminal {} not found", id);
    }
}

/// Toggle the per-terminal LowLatency override. While `low_latency` is true the
/// reader thread flushes every read immediately instead of coalescing, so user
/// interaction (typing / mouse / resize) sees the lowest possible output delay.
/// Called by the frontend's `useOutputMode` hook, debounced so it only fires on
/// boolean transitions — never per input event.
#[tauri::command]
pub fn set_output_mode(id: String, low_latency: bool, state: State<TerminalState>) {
    let terminals = state.terminals.try_lock().unwrap_or_else(|e| {
        log::error!("Failed to lock terminals for set_output_mode {}: {}", id, e);
        panic!("Failed to lock terminals: {}", e);
    });
    if let Some(entry) = terminals.get(&id) {
        entry.force_low_latency.store(low_latency, Ordering::Relaxed);
    } else {
        log::warn!("set_output_mode: terminal {} not found", id);
    }
}

/// Toggle per-terminal read backpressure. While `throttled` is true the reader
/// thread pauses reading so it can't outrun xterm and pile up unbounded data in
/// the IPC bridge / JS heap — which causes GC stalls and freezes on heavy
/// workloads (vtebench unicode / vim sessions, where a single xterm render can
/// take tens of ms). The frontend's ChunkedWriter drives this with hysteresis:
/// throttle ON when its backlog exceeds a high watermark, OFF once it drains
/// below a low one. No data is lost while throttled: the PTY pipe buffer
/// backpressures the child process naturally. Only called on watermark
/// transitions, never per chunk.
#[tauri::command]
pub fn set_throttle(id: String, throttled: bool, state: State<TerminalState>) {
    let terminals = state.terminals.try_lock().unwrap_or_else(|e| {
        log::error!("Failed to lock terminals for set_throttle {}: {}", id, e);
        panic!("Failed to lock terminals: {}", e);
    });
    if let Some(entry) = terminals.get(&id) {
        entry.throttled.store(throttled, Ordering::Relaxed);
    } else {
        log::warn!("set_throttle: terminal {} not found", id);
    }
}

/// Resolve the current working directory of a terminal's shell process, for
/// the frontend's "inherit working directory" option: when the user creates a
/// new tab, it starts in the active terminal's current directory instead of
/// the profile default. Reads the SHELL's cwd (the directory the user last
/// `cd`'d to), not a running foreground command's — a vim/npm session must not
/// move the inherited directory. Returns `None` when the terminal is gone or
/// the platform can't expose a cwd (Windows: no documented public API); the
/// frontend then falls back to the profile's configured cwd untouched.
#[tauri::command]
pub fn get_terminal_cwd(id: String, state: State<TerminalState>) -> Option<String> {
    let shell_pid = {
        let terminals = match state.terminals.try_lock() {
            Ok(t) => t,
            Err(e) => {
                log::error!("Failed to lock terminals for get_terminal_cwd {}: {}", id, e);
                return None;
            }
        };
        match terminals.get(&id) {
            Some(entry) => entry.shell_pid,
            None => {
                log::warn!("get_terminal_cwd: terminal {} not found", id);
                return None;
            }
        }
    };
    let cwd = shell_pid.and_then(process_cwd);
    log::debug!("get_terminal_cwd for {}: {:?}", id, cwd);
    cwd
}

/// Mirror the frontend's focused tab id into backend state so the read-only
/// MCP server can answer `get_active_tab`. The frontend (the UI's tab list) is
/// the single source of truth; this only caches the value for the backend's
/// MCP surface. Called by the frontend whenever the active tab changes.
#[tauri::command]
pub fn set_active_tab(id: Option<String>, state: State<TerminalState>) {
    let mut active = state.active_id.try_lock().unwrap_or_else(|e| {
        log::error!("Failed to lock active_id for set_active_tab: {}", e);
        panic!("Failed to lock active_id: {}", e);
    });
    *active = id;
}

/// Record a finished command (text + exit code) in a tab's history. Called by
/// the frontend when shell integration reports `CurrentCommandExit=<code>`
/// (parsed in currentCommand.ts), paired with the command text from preexec or
/// /proc. Feeds the read-only MCP server's `list_command_history`.
#[tauri::command]
pub fn report_command_finished(
    id: String,
    command: Option<String>,
    exit_code: i32,
    state: State<TerminalState>,
) {
    state.record_command(id, CommandHistoryEntry { command, exit_code });
}

/// Resolve a process's current working directory (platform-specific).
#[cfg(target_os = "linux")]
pub fn process_cwd(pid: u32) -> Option<String> {
    // `/proc/<pid>/cwd` is a symlink to the process cwd; `read_link` gives the
    // target as an absolute path without shelling out.
    std::fs::read_link(format!("/proc/{}/cwd", pid))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Resolve a process's current working directory (platform-specific).
#[cfg(all(unix, not(target_os = "linux")))]
pub fn process_cwd(pid: u32) -> Option<String> {
    // macOS/BSD have no /proc. `lsof -a -d cwd -p <pid> -Fn` prints the cwd as
    // an `n`-prefixed line; same-user processes are queryable without special
    // privileges.
    let out = std::process::Command::new("lsof")
        .args(["-a", "-d", "cwd", "-p", &pid.to_string(), "-Fn"])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix('n') {
            let path = path.trim();
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

/// Resolve a process's current working directory (platform-specific).
#[cfg(windows)]
pub fn process_cwd(_pid: u32) -> Option<String> {
    // Windows has no documented public API for another process's cwd (the
    // NtQueryInformationProcess trick is undocumented and needs PROCESS_QUERY
    // rights). Return None so the frontend falls back to the profile cwd.
    None
}
