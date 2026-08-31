//! Launch-flag parsing (`src/cli.rs`): the `-e` command-region split (known
//! window-shaping flags after `-e` still parse as flags, unknown dash tokens
//! stay command data, `--` is the verbatim escape hatch), per-field overrides,
//! `--hold`, plus the macOS `-psn_*` LaunchServices filter `parse_cli` applies
//! before parsing.

use lumina_terminal_lib::cli::{try_parse_cli, without_psn_args, CliArgs};
use std::ffi::OsString;

/// Parse with a fake argv[0] prepended, mirroring real process args. Goes
/// through `try_parse_cli` so the `-e` split runs exactly as `parse_cli` does.
fn parse(args: &[&str]) -> Result<CliArgs, clap::Error> {
    let argv: Vec<OsString> = std::iter::once(OsString::from("lumina-terminal"))
        .chain(args.iter().map(OsString::from))
        .collect();
    try_parse_cli(argv)
}

#[test]
fn no_args_parse_to_default() {
    let cli = parse(&[]).expect("empty argv must parse");
    assert!(cli.command.is_empty());
    assert_eq!(cli.working_directory, None);
    assert_eq!(cli.title, None);
    assert!(!cli.hold);
    assert_eq!(cli.profile, None);
}

#[test]
fn short_e_captures_everything_after_it() {
    let cli = parse(&["-e", "vim", "notes.txt"]).expect("parse -e");
    assert_eq!(cli.command, vec!["vim", "notes.txt"]);
}

#[test]
fn long_command_flag_matches_short_e() {
    let cli = parse(&["--command", "htop"]).expect("parse --command");
    assert_eq!(cli.command, vec!["htop"]);
}

#[test]
fn plain_arguments_after_the_command_are_captured() {
    let cli = parse(&["-e", "echo", "hello world"]).expect("parse");
    assert_eq!(cli.command, vec!["echo", "hello world"]);
}

#[test]
fn known_flags_after_the_command_parse_as_flags() {
    // The motivating case: `-T` after `-e` shapes the window instead of being
    // handed to the command (nvim has no `-T` and would exit instantly).
    let cli = parse(&["-e", "nvim", "-T", "nvim"]).expect("parse");
    assert_eq!(cli.command, vec!["nvim"]);
    assert_eq!(cli.title.as_deref(), Some("nvim"));

    let cli = parse(&["-e", "nvim", "--hold"]).expect("parse");
    assert_eq!(cli.command, vec!["nvim"]);
    assert!(cli.hold, "--hold after -e is the flag, not command data");

    let cli = parse(&["-e", "cargo", "build", "--working-directory", "/tmp", "--profile", "dev"])
        .expect("parse");
    assert_eq!(cli.command, vec!["cargo", "build"]);
    assert_eq!(cli.working_directory.as_deref(), Some("/tmp"));
    assert_eq!(cli.profile.as_deref(), Some("dev"));

    // `=value` and short-attached spellings end the capture too.
    let cli = parse(&["-e", "nvim", "--title=nvim"]).expect("parse");
    assert_eq!(cli.command, vec!["nvim"]);
    assert_eq!(cli.title.as_deref(), Some("nvim"));

    let cli = parse(&["-e", "nvim", "-Tnvim"]).expect("parse");
    assert_eq!(cli.command, vec!["nvim"]);
    assert_eq!(cli.title.as_deref(), Some("nvim"));
}

#[test]
fn dash_tokens_after_the_command_are_captured_verbatim() {
    // Unknown dash tokens belong to the command (`allow_hyphen_values` would
    // have made bare clap reject them; Alacritty-style capture keeps them).
    let cli = parse(&["-e", "grep", "-n", "pattern"]).expect("parse");
    assert_eq!(cli.command, vec!["grep", "-n", "pattern"]);

    let cli = parse(&["-e", "sh", "-c", "echo hi"]).expect("parse");
    assert_eq!(cli.command, vec!["sh", "-c", "echo hi"]);

    // A repeated `-e` is command data, not a new command start (grep -e).
    let cli = parse(&["-e", "grep", "-e", "pattern", "file"]).expect("parse");
    assert_eq!(cli.command, vec!["grep", "-e", "pattern", "file"]);

    // `--help` after the command stays command data — `-e curl --help` should
    // run curl's help in the terminal, not print Lumina's and exit.
    let cli = parse(&["-e", "curl", "--help"]).expect("parse");
    assert_eq!(cli.command, vec!["curl", "--help"]);
}

#[test]
fn double_dash_makes_the_rest_verbatim_command_data() {
    // Escape hatch for commands that use the same flag spellings as Lumina.
    let cli = parse(&["-e", "--", "ssh", "-T", "user@host"]).expect("parse");
    assert_eq!(cli.command, vec!["ssh", "-T", "user@host"]);
    assert_eq!(cli.title, None);

    let cli = parse(&["-e", "vim", "--", "--hold"]).expect("parse");
    assert_eq!(cli.command, vec!["vim", "--hold"]);
    assert!(!cli.hold, "-- after -e switches to verbatim capture");
}

#[test]
fn flags_before_the_command_still_parse_as_flags() {
    let cli = parse(&["--hold", "--profile", "dev", "-T", "t", "-e", "vim"]).expect("parse");
    assert_eq!(cli.command, vec!["vim"]);
    assert!(cli.hold);
    assert_eq!(cli.profile.as_deref(), Some("dev"));
    assert_eq!(cli.title.as_deref(), Some("t"));
}

#[test]
fn command_equals_form_still_works() {
    let cli = parse(&["--command=htop"]).expect("parse");
    assert_eq!(cli.command, vec!["htop"]);
}

#[test]
fn attached_short_command_form_still_works() {
    let cli = parse(&["-ehtop"]).expect("parse");
    assert_eq!(cli.command, vec!["htop"]);

    // Attached form + a trailing flag: the flag still parses.
    let cli = parse(&["-envim", "-T", "nvim"]).expect("parse");
    assert_eq!(cli.command, vec!["nvim"]);
    assert_eq!(cli.title.as_deref(), Some("nvim"));
}

#[test]
fn all_overrides_parse_together() {
    let cli = parse(&[
        "--working-directory",
        "/tmp",
        "-T",
        "My Title",
        "--hold",
        "--profile",
        "dev",
    ])
    .expect("parse overrides");
    assert_eq!(cli.working_directory.as_deref(), Some("/tmp"));
    assert_eq!(cli.title.as_deref(), Some("My Title"));
    assert!(cli.hold);
    assert_eq!(cli.profile.as_deref(), Some("dev"));
    assert!(cli.command.is_empty());
}

#[test]
fn unknown_flag_is_rejected() {
    assert!(parse(&["--nope"]).is_err());
}

#[test]
fn flag_missing_value_is_rejected() {
    assert!(parse(&["--profile"]).is_err());
    assert!(parse(&["-T"]).is_err());
    // A bare trailing `-e` captured nothing: clap must still reject it.
    assert!(parse(&["-e"]).is_err());
    assert!(parse(&["-T", "t", "-e"]).is_err());
}

#[test]
fn psn_args_are_filtered_out() {
    let argv: Vec<OsString> = vec![
        "/Applications/Lumina.app/Contents/MacOS/lumina-terminal".into(),
        "-psn_0_123456".into(),
        "--hold".into(),
    ];
    let filtered = without_psn_args(argv);
    assert_eq!(
        filtered,
        vec![
            OsString::from("/Applications/Lumina.app/Contents/MacOS/lumina-terminal"),
            OsString::from("--hold"),
        ]
    );
}

#[test]
fn non_psn_dash_args_are_kept() {
    let argv: Vec<OsString> = vec!["lumina-terminal".into(), "-e".into(), "vim".into()];
    let filtered = without_psn_args(argv.clone());
    assert_eq!(filtered, argv);
}

#[test]
fn filtered_psn_argv_parses_cleanly() {
    // The exact macOS Finder-launch shape: argv[0] + a stray -psn_* + real
    // flags must parse exactly like the flags alone.
    let argv: Vec<OsString> = vec![
        "/Applications/Lumina.app/Contents/MacOS/lumina-terminal".into(),
        "-psn_0_987654321".into(),
        "--hold".into(),
    ];
    let cli = try_parse_cli(without_psn_args(argv)).expect("filtered argv parses");
    assert!(cli.hold);
}
