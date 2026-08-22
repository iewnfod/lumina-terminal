//! Foreground-command resolution (`src/command_tracker.rs`): the pure
//! basename / privileged-name classification, and the real `/proc/<pid>/cmdline`
//! (Linux) or `ps` (macOS) argv resolution pointed at a live child process.
//! Unix-only — the whole file is cfg-gated away on Windows.

#![cfg(unix)]

use lumina_terminal_lib::command_tracker::{basename, is_privileged_name, proc_command_info};

#[test]
fn basename_strips_directory_components() {
    assert_eq!(basename("/usr/bin/npm"), "npm");
    assert_eq!(basename("npm"), "npm");
    assert_eq!(basename("/opt/homebrew/bin/fish"), "fish");
}

#[test]
fn privilege_escalation_wrappers_are_recognized() {
    for name in ["sudo", "su", "doas", "pkexec", "gsudo", "runuser"] {
        assert!(is_privileged_name(name), "{name} must be privileged");
    }
    // Lookalikes that are NOT wrappers.
    for name in ["npm", "sudoedit", "vim", "ssh"] {
        assert!(!is_privileged_name(name), "{name} must not be privileged");
    }
}

/// Spawn a real `sleep` child so the /proc / ps reads have a live target.
fn spawn_sleep() -> std::process::Child {
    std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("spawn sleep 30")
}

#[test]
fn proc_command_info_resolves_a_live_child() {
    let mut child = spawn_sleep();
    // `/proc/<pid>/cmdline` is briefly EMPTY between fork and execve, so poll
    // (≤2s) until the exec settles and argv becomes readable.
    let mut info = None;
    for _ in 0..40 {
        info = proc_command_info(child.id());
        if info.is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let info = info.expect("resolve live child after exec settles");

    // Linux joins argv with argv[0] as basename; macOS `ps args=` prints the
    // full line — both start with "sleep".
    assert!(info.command.starts_with("sleep"), "got {:?}", info.command);
    assert!(!info.privileged, "sleep is not privileged");

    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn proc_command_info_returns_none_for_dead_pid() {
    // PIDs this high are effectively never allocated.
    assert!(proc_command_info(u32::MAX).is_none());
}

/// The euid probe must report non-root for this (non-root) test process. When
/// the suite itself runs as root the assertion is vacuous, so skip there.
#[cfg(target_os = "linux")]
#[test]
fn proc_euid_is_root_agrees_with_proc_status() {
    use lumina_terminal_lib::command_tracker::proc_euid_is_root;

    let status =
        std::fs::read_to_string("/proc/self/status").expect("read /proc/self/status");
    let uid_line = status.lines().find(|l| l.starts_with("Uid:")).expect("Uid line");
    let real_uid: u32 = uid_line
        .split_whitespace()
        .nth(1)
        .expect("real uid field")
        .parse()
        .expect("uid number");
    if real_uid == 0 {
        eprintln!("skipping: test suite runs as root");
        return;
    }
    assert!(!proc_euid_is_root(std::process::id()));
    // A pid that cannot exist reads as non-root (missing status → false).
    assert!(!proc_euid_is_root(u32::MAX));
}
