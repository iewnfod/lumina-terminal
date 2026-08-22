//! Command-line argument parsing for the launcher (Alacritty-style).
//!
//! Parsed once at startup (see `lib::run`) before the Tauri window is built, so
//! `--help` / `--version` can print and exit without ever spawning a window.
//! The parsed [`CliArgs`] is stored in [`CliState`] and surfaced to the
//! frontend via [`get_cli_args`]; the frontend decides how the flags shape the
//! initial tab in the seed effect (keeping all UI logic in the frontend, per
//! the project's layering rules).
//!
//! `--command` / `-e` uses `trailing_var_arg`, so it must be the final flag —
//! every argument after it is captured as part of the command, matching
//! Alacritty's `-e` semantics.

use std::ffi::OsString;
use std::sync::Mutex;

use clap::Parser;
use serde::Serialize;
use tauri::State;

/// Parsed launch flags. Serialized to the frontend as camelCase JSON
/// (`workingDirectory`, `startupCommand`-style naming).
#[derive(Parser, Serialize, Clone, Debug, Default)]
#[command(name = "lumina-terminal", version, about = "Lumina Terminal")]
#[serde(rename_all = "camelCase")]
pub struct CliArgs {
    /// Command and args to run on startup (passed to the configured shell).
    /// Must be the final argument; consumes everything after it. Empty = none.
    #[arg(
        short = 'e',
        long = "command",
        num_args = 1..,
        trailing_var_arg = true,
        value_name = "COMMAND"
    )]
    pub command: Vec<String>,

    /// Start the shell in this working directory.
    #[arg(long = "working-directory", value_name = "DIRECTORY")]
    pub working_directory: Option<String>,

    /// Window title.
    #[arg(short = 'T', long = "title", value_name = "TITLE")]
    pub title: Option<String>,

    /// Keep the terminal open (frozen, read-only) after the command exits.
    #[arg(long, action = clap::ArgAction::SetTrue)]
    pub hold: bool,

    /// Open a configured profile by name (Lumina-specific). Other flags layer
    /// on top of the chosen profile; falls back to the default if not found.
    #[arg(long = "profile", value_name = "NAME")]
    pub profile: Option<String>,
}

/// Holds the parsed CLI args for the lifetime of the app, so the frontend can
/// query them once via [`get_cli_args`]. Process-global: the same value is
/// returned in every window, but the frontend only consumes it for the main
/// window's initial tab.
pub struct CliState {
    args: Mutex<CliArgs>,
}

impl CliState {
    pub fn new(args: CliArgs) -> Self {
        Self {
            args: Mutex::new(args),
        }
    }
}

/// Drop the macOS LaunchServices `-psn_*` process-serial-number flag
/// (injected when a `.app` is launched from Finder/Dock), which clap would
/// otherwise reject as an unknown option. Pure — takes the args explicitly so
/// tests can drive it with fixture argv lists.
pub fn without_psn_args(args: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
    args.into_iter()
        .filter(|a| !a.to_string_lossy().starts_with("-psn_"))
        .collect()
}

/// Parse the process's command-line arguments. Filters out the macOS
/// LaunchServices `-psn_*` flag (see [`without_psn_args`]).
///
/// On `--help` / `--version` / a parse error, `e.exit()` prints the
/// appropriate message and exits the process with the right status code — no
/// panic, so this never bypasses the log framework for a *recoverable* failure.
pub fn parse_cli() -> CliArgs {
    match CliArgs::try_parse_from(without_psn_args(std::env::args_os())) {
        Ok(args) => args,
        Err(e) => e.exit(),
    }
}

/// Return the parsed launch flags to the frontend. Always succeeds with a
/// default value (empty command, no overrides) when no flags were given, so the
/// caller can treat "no launch args" uniformly.
#[tauri::command]
pub fn get_cli_args(state: State<CliState>) -> CliArgs {
    match state.args.lock() {
        Ok(guard) => guard.clone(),
        Err(e) => {
            log::warn!("CliState lock poisoned, returning default CLI args: {e}");
            CliArgs::default()
        }
    }
}
