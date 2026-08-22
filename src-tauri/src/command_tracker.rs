use serde::Serialize;

use crate::state::TerminalState;

/// Payload for the `term-command-<id>` event: the currently-running command
/// and whether it looks like a privileged/elevated operation (sudo, su, doas,
/// pkexec, or a process running as root). The frontend shows a red dot before
/// the command name when `privileged` is true.
#[derive(Debug, Serialize, schemars::JsonSchema, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    /// argv[0] basename (e.g. "npm", "sudo"). Empty string = idle at prompt.
    pub command: String,
    pub privileged: bool,
}

/// Resolve the command name of the terminal's foreground process group, for
/// the "current command" fallback path. Returns `None` when the foreground
/// process group is the shell itself (i.e. idle at the prompt), and `Some`
/// when a child command is running. Unix-only; reads `/proc/<pgid>/cmdline`
/// on Linux and shells out to `ps` on macOS/other Unix. The returned
/// `CommandInfo.privileged` flag is true for elevated commands (sudo/su/doas/
/// pkexec, or a process whose effective uid is 0).
#[cfg(unix)]
pub fn foreground_command(state: &TerminalState, id: &str) -> Option<CommandInfo> {
    let (shell_pid, fg_pgid) = {
        let terminals = state.terminals.try_lock().ok()?;
        let entry = terminals.get(id)?;
        // process_group_leader() returns libc::pid_t (i32); process_id() is u32.
        // Normalize to u32 — a real pid/gid is always non-negative.
        let fg = entry.pty_pair.master.process_group_leader()?.max(0) as u32;
        (entry.shell_pid, fg)
    };

    // The shell is the foreground process group -> idle at the prompt.
    if shell_pid == Some(fg_pgid) {
        return None;
    }

    proc_command_info(fg_pgid)
}

/// Names of argv[0] basenames that indicate elevation/privilege escalation.
const PRIVILEGED_COMMANDS: &[&str] = &["sudo", "su", "doas", "pkexec", "gsudo", "runuser"];

/// True if the command basename is a known privilege-escalation wrapper.
/// Pure — `pub` so the integration tests can drive it directly.
#[cfg(unix)]
pub fn is_privileged_name(basename: &str) -> bool {
    PRIVILEGED_COMMANDS.iter().any(|&p| p == basename)
}

/// Resolve argv[0..] into a `CommandInfo` for one pid: reads
/// `/proc/<pid>/cmdline` on Linux, `ps -o args=` elsewhere. Reads REAL process
/// state, so tests spawn a live child to point it at.
#[cfg(unix)]
pub fn proc_command_info(pid: u32) -> Option<CommandInfo> {
    #[cfg(target_os = "linux")]
    {
        // `/proc/<pid>/cmdline` is NUL-separated argv. We join argv[0..] into a
        // single space-separated command line (argv[0] reduced to its basename,
        // the rest verbatim), so e.g. "sudo sleep 10" shows in full. The
        // frontend truncates the overflow.
        let path = format!("/proc/{}/cmdline", pid);
        let raw = std::fs::read(&path).ok()?;
        let argv: Vec<String> = raw
            .split(|&b| b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect();
        let argv0 = argv.first()?;
        let base0 = basename(argv0);
        if base0.is_empty() {
            return None;
        }
        let mut line = String::from(base0);
        for arg in argv.iter().skip(1) {
            line.push(' ');
            line.push_str(arg);
        }
        let privileged = is_privileged_name(base0) || proc_euid_is_root(pid);
        Some(CommandInfo {
            command: line,
            privileged,
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        // macOS and other Unix without /proc: ask `ps` for the full command
        // line (`args=`), which is already space-joined with argv[0].
        let out = std::process::Command::new("ps")
            .args(["-o", "args=", "-p"])
            .arg(pid.to_string())
            .output()
            .ok()?;
        let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if line.is_empty() {
            return None;
        }
        // argv[0] basename is the first whitespace-delimited token's basename;
        // re-normalize argv[0] to its basename to match the Linux path.
        let base0 = line.split_whitespace().next().unwrap_or("");
        let base0 = basename(base0);
        let privileged = is_privileged_name(base0);
        Some(CommandInfo {
            command: line,
            privileged,
        })
    }
}

/// Return the final path component of `s` (e.g. "/usr/bin/npm" -> "npm").
/// Pure — `pub` so the integration tests can drive it directly.
#[cfg(unix)]
pub fn basename(s: &str) -> &str {
    s.rsplit('/').next().unwrap_or(s)
}

/// On Linux, read `/proc/<pid>/status` and return true if the effective uid is
/// 0 (root). This catches binaries with the setuid bit, `sudoedit`, or any
/// process that ended up privileged without argv[0] naming a wrapper.
#[cfg(target_os = "linux")]
pub fn proc_euid_is_root(pid: u32) -> bool {
    let path = format!("/proc/{}/status", pid);
    let status = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("Uid:") {
            // Fields are: real, effective, saved set, fs uid.
            let mut fields = rest.split_whitespace();
            fields.next(); // real uid
            if let Some(euid) = fields.next() {
                if euid == "0" {
                    return true;
                }
            }
            return false;
        }
    }
    false
}
