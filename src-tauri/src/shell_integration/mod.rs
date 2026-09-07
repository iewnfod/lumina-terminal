//! Shell-integration injection: makes bash/zsh/fish emit OSC 1337 sequences
//! around each command so Lumina can capture per-command text (preexec) and
//! exit codes (precmd). See `src/lib/currentCommand.ts` for the frontend parser
//! and `state.rs::CommandHistoryEntry` for where they're stored.
//!
//! Per shell:
//!  - **bash**: no native preexec (`trap DEBUG` is noisy and fires inside
//!    functions), so we inject ONLY precmd (the exit code). Command text still
//!    comes from `/proc` on the backend. A login shell ignores `--init-file`,
//!    so we drop `-l` and simulate the login sequence inside the init file.
//!  - **zsh**: native `preexec_functions` / `precmd_functions`. Injected via a
//!    temporary `ZDOTDIR` whose startup files source the user's real ones
//!    first, so the full zsh startup is preserved.
//!  - **fish**: native `fish_preexec` / `fish_prompt` events, injected via `-C`.
//!
//! nu / pwsh / plain sh / SSH are NOT injected — they fall back to `/proc`
//! (command name only, no per-command exit code).
//!
//! On top of the markers, zsh and fish can also get **completion
//! interception** (`completion_hook_zsh` / `completion_hook_fish`, gated by
//! the `enableShellCompletions` config threaded through `start_terminal`):
//! TAB runs the shell's real completion machinery with the candidate sink
//! wrapped, and the candidates leave as `OSC 1337;Completions=` sequences the
//! frontend renders as its suggest popup (see `src/lib/completions.ts`).
//!
//! All sequences use BEL (`\007`) as the string terminator; the frontend parser
//! accepts BEL or ESC\, and BEL is one byte simpler to emit portably.
//!
//! The shell snippets live in sibling per-shell files (`bash/`, `zsh/`,
//! `fish/`) and are embedded at compile time via `include_str!` — they stay
//! real, syntax-highlightable shell scripts. The proxy-sync templates carry
//! `{env_path}` / `{proxy_keys}` tokens substituted by [`render_proxy`] (plain
//! string replace, not `format!`, so the files need no brace escaping).

use std::path::PathBuf;

use portable_pty::CommandBuilder;
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Embedded shell templates (see the sibling bash/, zsh/, fish/ directories)
// ---------------------------------------------------------------------------

const BASH_INIT: &str = include_str!("bash/init.sh");
const ZSH_INIT: &str = include_str!("zsh/zshrc.zsh");
const ZSH_ENV: &str = include_str!("zsh/zshenv.zsh");
const ZSH_PROFILE: &str = include_str!("zsh/zprofile.zsh");
const ZSH_LOGIN: &str = include_str!("zsh/zlogin.zsh");
const FISH_PREEXEC: &str = include_str!("fish/preexec.fish");
const FISH_PRECMD: &str = include_str!("fish/precmd.fish");
const PROXY_BASH: &str = include_str!("bash/proxy.sh");
const PROXY_ZSH: &str = include_str!("zsh/proxy.zsh");
const PROXY_FISH: &str = include_str!("fish/proxy.fish");
const COMPLETE_ZSH: &str = include_str!("zsh/complete.zsh");
const COMPLETE_FISH: &str = include_str!("fish/complete.fish");

/// Argv (after the bash executable) for the interactive shell Lumina spawns.
/// Order is load-bearing: bash documents that multi-character options must
/// appear BEFORE single-character ones, and bash 5.3 enforces it —
/// `-i --init-file <path>` dies with `bash: --: invalid option` (exit 2),
/// which closed the tab (and with it the window) right after startup on
/// every bash 5.3 system. Long-option-first parses on all bash versions.
/// Public for the real-shell test in tests/shell_hooks.rs.
pub fn bash_interactive_argv(init_path: &str) -> Vec<String> {
    vec!["--init-file".into(), init_path.to_string(), "-i".into()]
}

/// Resolve (creating) the per-app shell-integration dir under app data. Shared
/// with `proxy.rs`, which drops the proxy env-file next to the init scripts so
/// the hooks (whose paths are baked into those scripts) can read it.
pub(crate) fn integration_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("lumina-shell-integration");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// Write `content` to `path`, overwriting. Content is constant and tiny, so we
/// rewrite each launch rather than tracking freshness — avoids stale-file bugs
/// if the script changes between versions.
fn write_script(path: &PathBuf, content: &str) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| {
        log::warn!("Failed to write shell-integration {}: {}", path.display(), e);
        format!("write {}", path.display())
    })
}

/// Apply shell-integration argv/env to an interactive shell `CommandBuilder`,
/// based on the (lowercased) shell basename. Falls back to the standard
/// `--login -i` for unsupported shells or if writing the init files fails — so
/// the terminal always works, just without per-command exit codes for that tab.
///
/// `shell_completions` additionally installs the TAB-completion interception
/// hook for zsh/fish (config `enableShellCompletions`, decided by the frontend
/// at spawn time — existing terminals keep whatever they booted with, like
/// webgl/graphemes).
pub fn apply_interactive(
    c: &mut CommandBuilder,
    shell_base: &str,
    app: &AppHandle,
    shell_completions: bool,
) {
    if shell_base == "bash" {
        if let Ok(dir) = integration_dir(app) {
            let path = dir.join("lumina.bash");
            let proxy = proxy_hook_bash(&dir.join("proxy.env").to_string_lossy());
            let init = format!("{BASH_INIT}\n{proxy}");
            if write_script(&path, &init).is_ok() {
                // Drop -l: a login shell ignores --init-file, and the init
                // file simulates the login sequence itself.
                c.args(&bash_interactive_argv(&path.to_string_lossy()));
                return;
            }
        }
    } else if shell_base == "zsh" {
        if let Ok(dir) = integration_dir(app) {
            let zdir = dir.join("zsh");
            let proxy = proxy_hook_zsh(&dir.join("proxy.env").to_string_lossy());
            let mut zshrc = format!("{ZSH_INIT}\n{proxy}");
            if shell_completions {
                zshrc.push('\n');
                zshrc.push_str(&completion_hook_zsh());
            }
            if std::fs::create_dir_all(&zdir).is_ok()
                && write_script(&zdir.join(".zshenv"), ZSH_ENV).is_ok()
                && write_script(&zdir.join(".zshrc"), &zshrc).is_ok()
                && write_script(&zdir.join(".zprofile"), ZSH_PROFILE).is_ok()
                && write_script(&zdir.join(".zlogin"), ZSH_LOGIN).is_ok()
            {
                c.env("ZDOTDIR", zdir.to_string_lossy().into_owned());
                c.args(["--login", "-i"]);
                return;
            }
        }
    } else if shell_base == "fish" {
        // No init file needed — fish runs -C commands before the first prompt.
        c.args(["--login", "-i", "-C", FISH_PREEXEC, "-C", FISH_PRECMD]);
        if let Ok(dir) = integration_dir(app) {
            c.args(["-C", &proxy_hook_fish(&dir.join("proxy.env").to_string_lossy())]);
        }
        if shell_completions {
            c.args(["-C", &completion_hook_fish()]);
        }
        return;
    }
    // Fallback (nu/pwsh/sh/… or init-file write failure): plain login shell.
    c.args(["--login", "-i"]);
}

// ---------------------------------------------------------------------------
// Completion interception (zsh + fish) — the terminal-suggest feature
// ---------------------------------------------------------------------------

/// zsh completion-interception hook, appended to the generated `.zshrc`.
/// Public for the real-shell test in tests/completion_hooks.rs; the script
/// itself lives in [`COMPLETE_ZSH`] (`zsh/complete.zsh`).
pub fn completion_hook_zsh() -> String {
    COMPLETE_ZSH.to_string()
}

/// fish completion-interception hook (passed via `-C`). Public for the
/// real-shell test in tests/completion_hooks.rs; the script itself lives in
/// [`COMPLETE_FISH`] (`fish/complete.fish`).
pub fn completion_hook_fish() -> String {
    COMPLETE_FISH.to_string()
}

// ---------------------------------------------------------------------------
// Proxy-sync hooks (see src-tauri/src/proxy.rs for the writer side)
// ---------------------------------------------------------------------------

/// Single-quote a path for bash/zsh/fish literals (`'` → `'\''`, which all
/// three shells accept inside single quotes).
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The env-var keys the hooks manage, as the space-separated list the
/// for-loops consume. Single source: [`crate::proxy::PROXY_ENV_KEYS`] — the
/// env-file contract the hooks and the spawn-time parser both parse against.
fn proxy_key_words() -> String {
    crate::proxy::PROXY_ENV_KEYS.join(" ")
}

/// Substitute the proxy template's `{env_path}` / `{proxy_keys}` tokens. Plain
/// replaces (not `format!`) so the template files keep literal, valid shell
/// brace syntax without escaping.
fn render_proxy(template: &str, env_path: &str) -> String {
    template
        .replace("{env_path}", &shell_quote(env_path))
        .replace("{proxy_keys}", &proxy_key_words())
}

/// bash proxy-sync hook source with the env-file path baked in. Called from
/// `__lumina_precmd` (PROMPT_COMMAND) before every prompt. Steady state (file
/// unchanged since the last prompt) costs one builtin file read + one string
/// compare — no subprocesses. The `-d ''` read pulls the whole file into one
/// variable (read returns nonzero at EOF without a NUL, hence `|| true`).
/// Public for the real-shell lifecycle tests in tests/shell_hooks.rs.
pub fn proxy_hook_bash(env_path: &str) -> String {
    render_proxy(PROXY_BASH, env_path)
}

/// zsh proxy-sync hook source, registered on `precmd_functions`. Same protocol
/// as the bash hook; zsh-specific bits: `${(P)name}` indirection for reading
/// dynamic variables and `typeset -g` for writing them.
/// Public for the real-shell lifecycle tests in tests/shell_hooks.rs.
pub fn proxy_hook_zsh(env_path: &str) -> String {
    render_proxy(PROXY_ZSH, env_path)
}

/// fish proxy-sync hook source (passed via `-C`, fires on `fish_prompt`).
/// Same protocol as the POSIX hooks; fish-specific bits: locals are visible to
/// called functions, `$$name` double expansion reads a computed variable, and
/// `string split` (a builtin) extracts KEY/VALUE without globbing.
/// Public for the real-shell lifecycle tests in tests/shell_hooks.rs.
pub fn proxy_hook_fish(env_path: &str) -> String {
    render_proxy(PROXY_FISH, env_path)
}
