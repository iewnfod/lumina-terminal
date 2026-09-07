# Lumina shell integration (bash). Sourced via `bash --init-file <this> -i`.
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
