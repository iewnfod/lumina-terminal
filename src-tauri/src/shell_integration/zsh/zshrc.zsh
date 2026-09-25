# Lumina shell integration (zsh). This .zshrc lives in a ZDOTDIR Lumina sets,
# so it REPLACES the user's — source their real rc first, then add hooks.
if [ -r "$HOME/.zshrc" ]; then source "$HOME/.zshrc"; fi
lumina_preexec() { printf '\033]1337;CurrentCommand=%s\007' "$1"; }
# Capture $? into a local FIRST and return it at the end: anything the printf
# itself runs would otherwise clobber the status we still need to report.
lumina_precmd() {
    local -i __lumina_code=$?
    printf '\033]1337;CurrentCommandExit=%s\007' "$__lumina_code"
    return "$__lumina_code"
}
preexec_functions+=(lumina_preexec)
# PREPEND, don't append: the user's rc was sourced above, so their precmd
# hooks (oh-my-zsh, powerlevel10k, starship, …) are already queued. Running
# after them means $? is the previous hook's exit status, not the user's
# command's — every command would report the theme hook's status instead.
# Running first (and returning the preserved code) keeps both correct.
precmd_functions=(lumina_precmd $precmd_functions)
