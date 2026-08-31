//! Command-line argument parsing for the launcher.
//!
//! Parsed once at startup (see `lib::run`) before the Tauri window is built, so
//! `--help` / `--version` can print and exit without ever spawning a window.
//! The parsed [`CliArgs`] is stored in [`CliState`] and surfaced to the
//! frontend via [`get_cli_args`]; the frontend decides how the flags shape the
//! initial tab in the seed effect (keeping all UI logic in the frontend, per
//! the project's layering rules).
//!
//! `-e` / `--command` semantics: the tokens after it are the command, EXCEPT
//! that Lumina's own window-shaping flags (`-T/--title`, `--hold`,
//! `--working-directory`, `--profile`, `--sidebar`) still parse as flags — so
//! `lumina-terminal -e nvim -T nvim` runs nvim with the window titled "nvim".
//! Unknown dash tokens (e.g. `grep -n`), repeated `-e` tokens (e.g.
//! `grep -e pat`) and `--help`/`--version` stay command data, preserving the
//! Alacritty-style verbatim capture. `--` switches to fully verbatim mode:
//! every token after it belongs to the command even if it spells a Lumina flag
//! (the escape hatch for commands that use the same spellings, e.g.
//! `lumina-terminal -e -- ssh -T host`).
//!
//! clap alone cannot express this (with `allow_hyphen_values` it swallows the
//! flags; without it, an unknown dash token is a parse error), so
//! [`split_command_region`] carves the command region out of argv BEFORE clap
//! runs and the captured tokens are injected into the parsed result.

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
    /// Captured after `-e` until one of Lumina's window-shaping flags
    /// (`-T/--title`, `--hold`, `--working-directory`, `--profile`,
    /// `--sidebar`) or `--` (verbatim escape hatch) appears — see
    /// [`split_command_region`]. Empty = none.
    #[arg(
        short = 'e',
        long = "command",
        num_args = 1..,
        trailing_var_arg = true,
        allow_hyphen_values = true,
        value_name = "COMMAND"
    )]
    // The clap attributes above are only the FALLBACK semantics (raw
    // Alacritty-style swallow). In the normal path `split_command_region`
    // removes the whole `-e …` region from argv before clap runs, so clap
    // never applies them; they stay as a safety net for any `-e` form the
    // splitter misses (fail-old rather than fail-error).
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

    /// Show/hide the sidebar at startup for this launch only (Lumina-specific):
    /// it overrides the `showTabBar` setting WITHOUT persisting — the frontend
    /// holds it as local state and drops it on the first explicit toggle.
    #[arg(long = "sidebar", value_enum, value_name = "SHOW|HIDE")]
    pub sidebar: Option<SidebarVisibility>,
}

/// One-shot startup visibility for the sidebar (`--sidebar show|hide`).
#[derive(clap::ValueEnum, Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SidebarVisibility {
    Show,
    Hide,
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

/// Token forms of the window-shaping flags that END the `-e` command capture:
/// exact (`-T`, `--title`, `--hold`, `--working-directory`, `--profile`),
/// `=value` (`--title=x`), and short-attached (`-Ttitle`, `-T=title`).
///
/// Deliberately excludes `-e`/`--command` itself (so `grep -e PATTERN` keeps
/// its tokens) and `--help`/`--version` (so `-e curl --help` runs curl's help
/// in the terminal instead of printing Lumina's and exiting).
fn ends_command_capture(token: &str) -> bool {
    matches!(
        token,
        "-T" | "--title" | "--hold" | "--working-directory" | "--profile" | "--sidebar"
    ) || (token.starts_with("-T") && token.len() > 2)
        || token.starts_with("--title=")
        || token.starts_with("--working-directory=")
        || token.starts_with("--profile=")
        || token.starts_with("--sidebar=")
}

/// The first command token for an `-e`-style token that carries its value
/// attached: `--command=v`, `-e<value>`, `-e=<value>`. `None` for the plain
/// `-e` / `--command` spellings (the value comes from the NEXT argv token).
fn attached_command_value(token: &str) -> Option<String> {
    if let Some(v) = token.strip_prefix("--command=") {
        return Some(v.to_string());
    }
    if token.starts_with("-e") && token.len() > 2 {
        return Some(token[2..].trim_start_matches('=').to_string());
    }
    None
}

/// Carve the `-e`/`--command` region out of a full argv (argv[0] included).
/// Returns `(command, argv)`: the captured command tokens, and the argv clap
/// should parse (everything else, with the command region removed).
///
/// Capture rules, walking tokens after the first `-e`/`--command`:
///   - a window-shaping flag ([`ends_command_capture`]) ends the capture;
///     it and everything after it return to normal flag parsing;
///   - `--` ends flag interception for the whole rest of the line: every
///     following token is command data verbatim (escape hatch, e.g.
///     `-e -- ssh -T host`);
///   - anything else — unknown dash tokens (`grep -n`), repeated `-e` tokens
///     (`grep -e pat`), `--help` — is command data, exactly like the old
///     Alacritty-style verbatim capture.
///
/// When `-e` was given but nothing was captured (a bare `-e` at the end of
/// the line), the start token is kept in the returned argv so clap still
/// rejects it with "requires a value". Pure — takes argv explicitly so tests
/// drive it with fixture lists.
fn split_command_region(args: &[OsString]) -> (Vec<String>, Vec<OsString>) {
    let mut argv: Vec<OsString> = Vec::with_capacity(args.len());
    let mut command: Vec<String> = Vec::new();
    let mut start_token: Option<OsString> = None;

    let mut i = 0;
    while i < args.len() {
        let token = args[i].clone();
        let text = token.to_string_lossy().into_owned();

        if start_token.is_none() {
            if text == "-e" || text == "--command" {
                start_token = Some(token);
            } else if let Some(v) = attached_command_value(&text) {
                start_token = Some(token);
                command.push(v);
            } else {
                argv.push(token);
            }
        } else if text == "--" {
            command.extend(
                args[i + 1..]
                    .iter()
                    .map(|t| t.to_string_lossy().into_owned()),
            );
            break;
        } else if ends_command_capture(&text) {
            // Bare `-e` directly followed by one of our flags captured
            // nothing: put the start token back so clap reports the missing
            // value instead of silently parsing the flags alone.
            if command.is_empty() {
                argv.push(start_token.take().expect("start token set above"));
            }
            argv.extend_from_slice(&args[i..]);
            break;
        } else {
            command.push(text);
        }
        i += 1;
    }
    // Natural end of argv with a bare `-e` that captured nothing — same
    // keep-the-token rule as above (clap: "requires a value").
    if let Some(t) = start_token {
        if command.is_empty() {
            argv.push(t);
        }
    }
    (command, argv)
}

/// Parse the process's command-line arguments (see [`parse_cli`]).
/// Pure over the given argv — the test entry point.
pub fn try_parse_cli(argv: Vec<OsString>) -> Result<CliArgs, clap::Error> {
    let (command, argv) = split_command_region(&argv);
    let mut cli = CliArgs::try_parse_from(argv)?;
    if !command.is_empty() {
        cli.command = command;
    }
    Ok(cli)
}

/// Parse the process's command-line arguments. Filters out the macOS
/// LaunchServices `-psn_*` flag (see [`without_psn_args`]).
///
/// On `--help` / `--version` / a parse error, `e.exit()` prints the
/// appropriate message and exits the process with the right status code — no
/// panic, so this never bypasses the log framework for a *recoverable* failure.
pub fn parse_cli() -> CliArgs {
    let argv: Vec<OsString> = without_psn_args(std::env::args_os()).into_iter().collect();
    match try_parse_cli(argv) {
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
