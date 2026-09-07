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

/// zsh completion-interception hook, appended to the generated `.zshrc`. TAB
/// is re-bound to a widget that runs the REAL completion machinery (`zle
/// complete-word`) with `compadd` temporarily shadowed by a recording shim:
/// the shim mirrors just enough of compadd's option grammar (zshcompwid) to
/// pull out the candidate words (`-a` arrays, `-k` assoc keys, positionals),
/// the `-d` display strings and the forced `-P/-p/-s/-S` prefix/suffix — and
/// adds nothing, so no menu is listed and no prefix inserted. Because the
/// candidates never reach the real matcher, the shim re-applies the PREFIX
/// filter compsys would have done (zsh exposes `PREFIX` in completion
/// context). The captured set is emitted as ONE `OSC 1337;Completions=`
/// sequence; the terminal renders its popup and inserts the choice as plain
/// keystrokes (DEL × word-length + replacement).
///
/// Payload framing uses ASCII RS (`\x1e`) between candidates and US (`\x1f`)
/// between fields — the PTY line discipline's ONLCR would rewrite any `\n`,
/// xterm.js silently drops 0x1c–0x1f inside OSC, and Lumina's parser sees the
/// raw stream anyway (see `src/lib/completions.ts`).
///
/// Zero captures (completion system not loaded via compinit, or genuinely no
/// matches — the shim swallowed them either way) falls back to a native second
/// `zle complete-word`, so behavior degrades to stock zsh. The `always` block
/// guarantees the compadd shadow is lifted even if a user completion function
/// throws mid-run.
///
/// Public for the real-shell test in tests/completion_hooks.rs.
pub fn completion_hook_zsh() -> String {
    r#"# Lumina completion interception (zsh): TAB runs the completion system with
# compadd recording candidates instead of adding them; they leave as one OSC
# 1337;Completions sequence for the terminal's suggest popup. See
# src-tauri/src/shell_integration.rs (completion_hook_zsh) for the rationale.
typeset -a _lumina_ins _lumina_lbl _lumina_dsc
typeset -A _lumina_seen
typeset _lumina_word= _lumina_ctx=
lumina_compadd() {
	emulate -L zsh
	local -a _lld _lla _llP _llS _llp _lls _lrest
	zparseopts -D -E -a _lrest d:=_lld a:=_lla k:=_lla P:=_llP S:=_llS p:=_llp s:=_lls \
		F: i: I: W: J: V: X: x: D: O: A: M: R: E: o:: r:: 1 2 q Q f e n U l C
	local _ln _lsrc _lfrom
	local -a _lw
	for (( _ln = 1; _ln <= $#_lla; _ln += 2 )); do
		_lfrom=${_lla[_ln]}
		_lsrc=${_lla[_ln+1]}
		if [[ $_lfrom == -k ]]; then
			_lw+=("${(k@P)_lsrc}")
		else
			_lw+=("${(@P)_lsrc}")
		fi
	done
	# zparseopts stops at (and keeps) a lone - or -- before the words.
	[[ $1 == - || $1 == -- ]] && shift
	_lw+=("$@")
	(( $#_lw )) || return 0
	[[ -z $_lumina_word ]] && {
		_lumina_word=${words[CURRENT]:-}
		# Line context for the frontend's warm cache: the tokens before the
		# word being completed (command position → empty), joined by single
		# spaces. Only a cache KEY — never replayed — so joined form suffices.
		_lumina_ctx=${(j: :)words[1,CURRENT-1]}
	}
	local -a _ldsp
	if (( $#_lld )); then
		_lsrc=${_lld[$#_lld]}
		_ldsp=("${(@P)_lsrc}")
	fi
	local _lP=${_llP[$#_llP]} _lS=${_llS[$#_llS]} _lhp=${_llp[$#_llp]} _lhs=${_lls[$#_lls]}
	local _li _lw2 _lldisp _llabel _ldesc _lfull
	for (( _li = 1; _li <= $#_lw; _li++ )); do
		_lw2=${_lw[_li]}
		_lfull=${_lP}${_lhp}${_lw2}${_lhs}${_lS}
		# The real matcher never ran, so re-apply the prefix filter compsys
		# would have applied (PREFIX is exposed in completion context).
		[[ -n $PREFIX && $_lfull != "$PREFIX"* ]] && continue
		[[ -z ${_lumina_seen[$_lfull]} ]] || continue
		_lumina_seen[$_lfull]=1
		_lldisp=${_ldsp[_li]:-}
		if [[ -n $_lldisp && $_lldisp == *:* ]]; then
			_llabel=${_lldisp%%:*}
			_ldesc=${_lldisp#*:}
		else
			_llabel=$_lldisp
			_ldesc=
		fi
		# Keep the OSC framing intact: skip candidates whose insert text
		# contains a field/record/terminator byte; drop broken labels/descs.
		[[ $_lfull == *[$'\t\n\r\033\007\036\037']* ]] && continue
		[[ -n $_llabel && $_llabel == *[$'\t\n\r\033\007\036\037']* ]] && _llabel=$_lfull
		[[ $_ldesc == *[$'\t\n\r\033\007\036\037']* ]] && _ldesc=
		_lumina_ins+=("$_lfull")
		_lumina_lbl+=("$_llabel")
		_lumina_dsc+=("$_ldesc")
	done
	return 0
}
lumina_complete() {
	emulate -L zsh
	_lumina_ins=() _lumina_lbl=() _lumina_dsc=() _lumina_word= _lumina_ctx=
	_lumina_seen=()
	local -r _lbuf=$BUFFER _lcur=$CURSOR
	functions[compadd]=$functions[lumina_compadd]
	{
		zle complete-word
	} always {
		unset "functions[compadd]"
	}
	BUFFER=$_lbuf CURSOR=$_lcur
	if (( $#_lumina_ins )); then
		[[ $_lumina_ctx == *[$'\t\n\r\033\007\036\037']* ]] && _lumina_ctx=
		local _li2 _lout="${_lumina_ctx}"$'\037'"$_lumina_word"
		for (( _li2 = 1; _li2 <= $#_lumina_ins; _li2++ )); do
			_lout+=$'\036'"${_lumina_ins[_li2]}"$'\037'"${_lumina_lbl[_li2]}"$'\037'"${_lumina_dsc[_li2]}"
		done
		printf '\033]1337;Completions=%s\007' "$_lout"
	else
		zle complete-word
	fi
}
zle -N lumina_complete
bindkey '^I' lumina_complete"#
        .to_string()
}

/// fish completion-interception hook (passed via `-C`). `complete -C` IS
/// fish's completion engine entry point — it honors every user completion
/// (commands, options, file paths, git subfunctions…) and returns
/// `candidate\tdescription` lines — so the hook is a thin shim: derive the
/// command line up to the cursor, query the engine, forward the candidates as
/// one `OSC 1337;Completions=` sequence (RS/US framing, see
/// `completion_hook_zsh` for why not \n/\t), repaint. No candidates → run
/// fish's native TAB (`commandline -f complete`).
///
/// Candidates arrive pre-escaped by fish (`My\ Dir/`), which is exactly what
/// the line editor accepts as typed text — the terminal inserts them verbatim.
///
/// Public for the real-shell test in tests/completion_hooks.rs.
pub fn completion_hook_fish() -> String {
    r#"# Lumina completion interception (fish): TAB asks fish's own completion
# engine (complete -C) for the candidates and ships them to the terminal as
# one OSC 1337;Completions sequence. See src-tauri/src/shell_integration.rs
# (completion_hook_fish).
function __lumina_complete
	set -l __lumina_RS (printf '\036')
	set -l __lumina_US (printf '\037')
	set -l __lumina_line (commandline -c)
	set -l __lumina_word (commandline -ct)
	# Line context for the frontend's warm cache: the tokens before the word
	# being completed (command position → empty), joined by single spaces.
	# `commandline -opc` already EXCLUDES the token under the cursor, so the
	# whole token list IS the context (no slicing). Cache KEY only, so the
	# joined form suffices.
	set -l __lumina_toks (commandline -opc)
	set -l __lumina_ctx (string join ' ' -- $__lumina_toks)
	if string match -qr '[\t\n\r\x1b\x07\x1e\x1f]' -- $__lumina_ctx
		set __lumina_ctx ''
	end
	set -l __lumina_out
	if set -q __lumina_line[1]
		set __lumina_out (complete -C -- "$__lumina_line")
	end
	if not set -q __lumina_out[1]
		commandline -f complete
		return
	end
	set -l __lumina_payload "$__lumina_ctx$__lumina_US$__lumina_word"
	for __lumina_cand in $__lumina_out
		set -l __lumina_parts (string split -m1 \t -- $__lumina_cand)
		set -l __lumina_label $__lumina_parts[1]
		set -l __lumina_desc ''
		if set -q __lumina_parts[2]
			set __lumina_desc $__lumina_parts[2]
		end
		# Skip candidates whose text would break the OSC framing; drop broken
		# descriptions (label equals the insert text for fish).
		if string match -qr '[\t\n\r\x1b\x07\x1e\x1f]' -- $__lumina_label
			continue
		end
		if string match -qr '[\t\n\r\x1b\x07\x1e\x1f]' -- $__lumina_desc
			set __lumina_desc ''
		end
		set -a __lumina_payload $__lumina_label$__lumina_US$__lumina_US$__lumina_desc
	end
	if not set -q __lumina_payload[2]
		commandline -f complete
		return
	end
	printf '\033]1337;Completions=%s\007' (string join $__lumina_RS -- $__lumina_payload)
	commandline -f repaint
end
# -C commands run BEFORE the config files, so a system/user `bind \t` there
# (e.g. fish's bundled autopair installs `bind tab _autopair_tab`) would
# override ours. Re-binding on every fish_prompt event — fired after all
# config, right before the first prompt — keeps ours last.
function __lumina_bind_complete --on-event fish_prompt
	bind \t __lumina_complete
end
bind \t __lumina_complete"#
        .to_string()
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
        proxy_keys = proxy_key_words(),
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
        proxy_keys = proxy_key_words(),
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
        proxy_keys = proxy_key_words(),
    )
}
