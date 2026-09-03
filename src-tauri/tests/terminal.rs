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

// ---- shell argv construction (build_shell_command's pure helpers) ----

use lumina_terminal_lib::terminal::{shell_family, ssh_remote_command, startup_command_argv};

#[test]
fn shell_family_takes_lowercase_basename() {
    assert_eq!(shell_family("/usr/bin/fish"), "fish");
    assert_eq!(shell_family("/usr/local/bin/PowerShell.exe"), "powershell.exe");
    assert_eq!(shell_family("pwsh"), "pwsh");
    assert_eq!(shell_family("/opt/Weird Path/Zsh"), "zsh");
    // Degenerate inputs must not panic — they degrade to an unknown family,
    // which the POSIX branch handles.
    assert_eq!(shell_family(""), "");
    assert_eq!(shell_family("/"), "");
}

#[test]
fn startup_command_without_keep_shell_runs_login_c_and_exits() {
    // keepAfterExit "exit"/"freeze"/unset all let the shell exit with the
    // command (the tab then closes / freezes via the frontend).
    assert_eq!(
        startup_command_argv("htop", false, "zsh", "/usr/bin/zsh"),
        vec!["--login", "-i", "-c", "htop"]
    );
}

#[test]
fn startup_command_keep_shell_pwsh_uses_noexit() {
    // PowerShell has no exec; -NoExit keeps the session interactive.
    assert_eq!(
        startup_command_argv("nvim", true, "powershell.exe", "C:\\pwsh.exe"),
        vec!["-NoExit", "-Command", "nvim"]
    );
    assert_eq!(
        startup_command_argv("nvim", true, "pwsh", "pwsh"),
        vec!["-NoExit", "-Command", "nvim"]
    );
}

#[test]
fn startup_command_keep_shell_posix_execs_self_with_argv0() {
    // POSIX: exec "$0" --login -i, with exe_path passed as the trailing
    // argv[0] arg so $0 resolves inside the -c script.
    let argv = startup_command_argv("make", true, "zsh", "/bin/zsh");
    assert_eq!(argv[..4], ["--login", "-i", "-c", "make; exec \"$0\" --login -i"][..4]);
    assert_eq!(argv[4], "/bin/zsh", "exe_path rides as argv[0] for POSIX shells");
    assert_eq!(argv.len(), 5);
}

#[test]
fn startup_command_keep_shell_fish_and_nu_skip_argv0() {
    // fish: `exec fish -i` (empty $0 and no --login support).
    let fish = startup_command_argv("make", true, "fish", "/usr/bin/fish");
    assert_eq!(fish, vec!["--login", "-i", "-c", "make; exec fish -i"]);
    // nu: `exec nu` (rejects --login/-i, but the flags sit before -c).
    let nu = startup_command_argv("make", true, "nu", "/usr/bin/nu");
    assert_eq!(nu, vec!["--login", "-i", "-c", "make; exec nu"]);
}

#[test]
fn ssh_remote_command_appends_login_shell_only_for_keep_shell() {
    assert_eq!(ssh_remote_command("top", false), "top");
    assert_eq!(ssh_remote_command("top", true), "top; exec $SHELL -l");
}
