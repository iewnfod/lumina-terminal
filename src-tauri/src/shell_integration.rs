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
//! All sequences use BEL (`\007`) as the string terminator; the frontend parser
//! accepts BEL or ESC\, and BEL is one byte simpler to emit portably.

use std::path::PathBuf;

use portable_pty::CommandBuilder;
use tauri::{AppHandle, Manager};

/// Bash init script, sourced via `bash --init-file <this> -i`.
const BASH_INIT: &str = r#"# Lumina shell integration (bash). Sourced via `bash --init-file <this> -i`.
# A login shell ignores --init-file, so Lumina drops -l and we simulate the
# login sequence here (the same files bash -l reads), then the interactive rc,
# then a precmd hook reporting the previous command's exit code. No preexec
# (bash has none natively; command text comes from /proc on the backend).
if [ -r /etc/profile ]; then source /etc/profile; fi
for __lumina_pf in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [ -r "$__lumina_pf" ]; then source "$__lumina_pf"; break; fi
done
unset __lumina_pf
if [ -r "$HOME/.bashrc" ]; then source "$HOME/.bashrc"; fi
__lumina_precmd() {
    local __lumina_code=$?
    builtin printf '\033]1337;CurrentCommandExit=%s\007' "$__lumina_code"
    __lumina_proxy
    return "$__lumina_code"
}
case " ${PROMPT_COMMAND:-} " in
    *"__lumina_precmd"*) ;;
    *) PROMPT_COMMAND="__lumina_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
esac
"#;

/// zsh `.zshrc` (lives in the temp ZDOTDIR, so it REPLACES the user's — we
/// source their real rc first, then install hooks).
const ZSH_INIT: &str = r#"# Lumina shell integration (zsh). This .zshrc lives in a ZDOTDIR Lumina sets,
# so it REPLACES the user's — source their real rc first, then add hooks.
if [ -r "$HOME/.zshrc" ]; then source "$HOME/.zshrc"; fi
lumina_preexec() { printf '\033]1337;CurrentCommand=%s\007' "$1"; }
lumina_precmd() { printf '\033]1337;CurrentCommandExit=%s\007' "$?"; }
preexec_functions+=(lumina_preexec)
precmd_functions+=(lumina_precmd)
"#;

const ZSH_ENV: &str = r#"[ -r "$HOME/.zshenv" ] && source "$HOME/.zshenv""#;
const ZSH_PROFILE: &str = r#"[ -r "$HOME/.zprofile" ] && source "$HOME/.zprofile""#;
const ZSH_LOGIN: &str = r#"[ -r "$HOME/.zlogin" ] && source "$HOME/.zlogin""#;

/// fish preexec hook (passed via `fish -C`).
const FISH_PREEXEC: &str = r#"function __lumina_preexec --on-event fish_preexec; printf '\033]1337;CurrentCommand=%s\007' $argv[1]; end"#;
/// fish precmd hook (passed via `fish -C`).
const FISH_PRECMD: &str = r#"function __lumina_precmd --on-event fish_prompt; printf '\033]1337;CurrentCommandExit=%s\007' $status; end"#;

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
pub fn apply_interactive(c: &mut CommandBuilder, shell_base: &str, app: &AppHandle) {
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
            let zshrc = format!("{ZSH_INIT}\n{proxy}");
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
        return;
    }
    // Fallback (nu/pwsh/sh/… or init-file write failure): plain login shell.
    c.args(["--login", "-i"]);
}

// ---------------------------------------------------------------------------
// Proxy-sync hooks (see src-tauri/src/proxy.rs for the writer side)
// ---------------------------------------------------------------------------

/// Single-quote a path for bash/zsh/fish literals (`'` → `'\''`, which all
/// three shells accept inside single quotes).
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The env-var keys the hooks manage, in a fixed order shared by all three
/// shells. Keys ARE env-var names (both cases), so the env-file's `KEY=value`
/// lines map 1:1 with no case conversion.
const PROXY_ENV_KEYS: &str = "http_proxy HTTP_PROXY https_proxy HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY";

/// bash proxy-sync hook source with the env-file path baked in. Called from
/// `__lumina_precmd` (PROMPT_COMMAND) before every prompt. Steady state (file
/// unchanged since the last prompt) costs one builtin file read + one string
/// compare — no subprocesses. The `-d ''` read pulls the whole file into one
/// variable (read returns nonzero at EOF without a NUL, hence `|| true`).
/// Public for the real-shell lifecycle tests in tests/shell_hooks.rs.
pub fn proxy_hook_bash(env_path: &str) -> String {
    format!(
        r#"# Lumina proxy sync (bash): apply the system-proxy env-file before each
# prompt. Values Lumina injects are tracked per key; only those are ever
# unset, so manually exported proxies survive a proxy-off transition.
__lumina_proxy_get() {{
    local __lumina_line
    while IFS= read -r __lumina_line; do
        case "$__lumina_line" in
            "$1="*) printf '%s' "${{__lumina_line#*=}}"; return 0 ;;
        esac
    done <<< "$__LUMINA_PROXY_CUR"
    return 1
}}
__lumina_proxy_set() {{
    local __lumina_key=$1 __lumina_val=$2
    local __lumina_marker="__LUMINA_INJ_$1"
    if [ -n "$__lumina_val" ]; then
        export "$__lumina_key=$__lumina_val"
        printf -v "$__lumina_marker" '%s' "$__lumina_val"
    elif [ -n "${{!__lumina_marker-}}" ] && [ "${{!__lumina_key-}}" = "${{!__lumina_marker-}}" ]; then
        unset "$__lumina_key"
        unset "$__lumina_marker"
    else
        unset "$__lumina_marker"
    fi
}}
__lumina_proxy() {{
    local __lumina_f={env_path}
    local __lumina_cur=''
    if [ -r "$__lumina_f" ]; then
        IFS= read -r -d '' __lumina_cur < "$__lumina_f" || true
    fi
    if [ "$__lumina_cur" = "${{__LUMINA_PROXY_FILE-}}" ]; then
        return 0
    fi
    __LUMINA_PROXY_FILE=$__lumina_cur
    __LUMINA_PROXY_CUR=$__lumina_cur
    local __lumina_key __lumina_val
    for __lumina_key in {proxy_keys}; do
        __lumina_val=''
        __lumina_val=$(__lumina_proxy_get "$__lumina_key") || true
        __lumina_proxy_set "$__lumina_key" "$__lumina_val"
    done
}}"#,
        env_path = shell_quote(env_path),
        proxy_keys = PROXY_ENV_KEYS,
    )
}

/// zsh proxy-sync hook source, registered on `precmd_functions`. Same protocol
/// as the bash hook; zsh-specific bits: `${(P)name}` indirection for reading
/// dynamic variables and `typeset -g` for writing them.
/// Public for the real-shell lifecycle tests in tests/shell_hooks.rs.
pub fn proxy_hook_zsh(env_path: &str) -> String {
    format!(
        r#"# Lumina proxy sync (zsh): apply the system-proxy env-file before each
# prompt. Values Lumina injects are tracked per key; only those are ever
# unset, so manually exported proxies survive a proxy-off transition.
__lumina_proxy_get() {{
    local __lumina_line
    while IFS= read -r __lumina_line; do
        case "$__lumina_line" in
            "$1="*) printf '%s' "${{__lumina_line#*=}}"; return 0 ;;
        esac
    done <<< "$__LUMINA_PROXY_CUR"
    return 1
}}
__lumina_proxy_set() {{
    local __lumina_key=$1 __lumina_val=$2
    local __lumina_marker="__LUMINA_INJ_$1"
    if [ -n "$__lumina_val" ]; then
        export "$__lumina_key=$__lumina_val"
        typeset -g "$__lumina_marker=$__lumina_val"
    elif [ -n "${{(P)__lumina_marker-}}" ] && [ "${{(P)__lumina_key-}}" = "${{(P)__lumina_marker-}}" ]; then
        unset "$__lumina_key"
        unset "$__lumina_marker"
    else
        unset "$__lumina_marker"
    fi
}}
__lumina_proxy() {{
    local __lumina_f={env_path}
    local __lumina_cur=''
    if [ -r "$__lumina_f" ]; then
        IFS= read -r -d '' __lumina_cur < "$__lumina_f" || true
    fi
    if [ "$__lumina_cur" = "${{__LUMINA_PROXY_FILE-}}" ]; then
        return 0
    fi
    __LUMINA_PROXY_FILE=$__lumina_cur
    __LUMINA_PROXY_CUR=$__lumina_cur
    local __lumina_key __lumina_val
    for __lumina_key in {proxy_keys}; do
        __lumina_val=''
        __lumina_val=$(__lumina_proxy_get "$__lumina_key") || true
        __lumina_proxy_set "$__lumina_key" "$__lumina_val"
    done
}}
precmd_functions+=(__lumina_proxy)"#,
        env_path = shell_quote(env_path),
        proxy_keys = PROXY_ENV_KEYS,
    )
}

/// fish proxy-sync hook source (passed via `-C`, fires on `fish_prompt`).
/// Same protocol as the POSIX hooks; fish-specific bits: locals are visible to
/// called functions, `$$name` double expansion reads a computed variable, and
/// `string split` (a builtin) extracts KEY/VALUE without globbing.
/// Public for the real-shell lifecycle tests in tests/shell_hooks.rs.
pub fn proxy_hook_fish(env_path: &str) -> String {
    format!(
        r#"# Lumina proxy sync (fish): apply the system-proxy env-file before each
# prompt. Values Lumina injects are tracked per key; only those are ever
# unset, so manually exported proxies survive a proxy-off transition.
function __lumina_proxy_get --argument-names __lumina_key
    for __lumina_line in $__LUMINA_PROXY_CUR
        set -l __lumina_parts (string split -m1 = -- $__lumina_line)
        if test "$__lumina_parts[1]" = "$__lumina_key"
            printf '%s' $__lumina_parts[2]
            return 0
        end
    end
    return 1
end
function __lumina_proxy_set --argument-names __lumina_key __lumina_val
    set -l __lumina_marker __LUMINA_INJ_$__lumina_key
    if test -n "$__lumina_val"
        set -gx $__lumina_key $__lumina_val
        set -g $__lumina_marker $__lumina_val
    else if test -n "$$__lumina_marker"; and test "$$__lumina_key" = "$$__lumina_marker"
        set -e $__lumina_key
        set -e $__lumina_marker
    else
        set -e $__lumina_marker
    end
end
function __lumina_proxy --on-event fish_prompt
    set -l __lumina_cur
    if test -r {env_path}
        while read -l __lumina_line
            set -a __lumina_cur $__lumina_line
        end <{env_path}
    end
    if test "$__LUMINA_PROXY_FILE" = "$__lumina_cur"
        return 0
    end
    set -g __LUMINA_PROXY_FILE $__lumina_cur
    set -g __LUMINA_PROXY_CUR $__lumina_cur
    for __lumina_key in {proxy_keys}
        set -l __lumina_val ''
        if set __lumina_val (__lumina_proxy_get $__lumina_key)
            __lumina_proxy_set $__lumina_key $__lumina_val
        else
            __lumina_proxy_set $__lumina_key ''
        end
    end
end"#,
        env_path = shell_quote(env_path),
        proxy_keys = PROXY_ENV_KEYS,
    )
}
