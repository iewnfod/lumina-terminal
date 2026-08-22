//! Launch-flag parsing (`src/cli.rs`): the Alacritty-style clap semantics
//! (trailing `-e` capture, per-field overrides, `--hold`) plus the macOS
//! `-psn_*` LaunchServices filter `parse_cli` applies before parsing.

use clap::Parser;
use lumina_terminal_lib::cli::{without_psn_args, CliArgs};
use std::ffi::OsString;

/// Parse with a fake argv[0] prepended, mirroring real process args.
fn parse(args: &[&str]) -> Result<CliArgs, clap::Error> {
    let argv: Vec<&str> = std::iter::once("lumina-terminal")
        .chain(args.iter().copied())
        .collect();
    CliArgs::try_parse_from(argv)
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
fn trailing_var_arg_captures_all_plain_arguments() {
    // Everything after -e is captured — up to the next dash-token: a
    // recognized long flag still parses as a flag, and an unknown dash-token
    // errors (see the two tests below). Quoted/multi-word commands work as
    // long as no argument starts with '-'.
    let cli = parse(&["-e", "echo", "hello world"]).expect("parse");
    assert_eq!(cli.command, vec!["echo", "hello world"]);
}

#[test]
fn flags_after_the_command_are_still_parsed_as_flags() {
    let cli = parse(&["-e", "vim", "--hold"]).expect("parse");
    assert_eq!(cli.command, vec!["vim"]);
    assert!(cli.hold);
}

#[test]
fn unknown_dash_token_after_command_is_rejected() {
    // `-n` here is not a known Lumina flag, so clap rejects it instead of
    // silently folding it into the command.
    assert!(parse(&["-e", "grep", "-n", "pattern"]).is_err());
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
    let cli = CliArgs::try_parse_from(without_psn_args(argv)).expect("filtered argv parses");
    assert!(cli.hold);
}
