# Lumina shell integration (zsh). This .zshrc lives in a ZDOTDIR Lumina sets,
# so it REPLACES the user's — source their real rc first, then add hooks.
if [ -r "$HOME/.zshrc" ]; then source "$HOME/.zshrc"; fi
lumina_preexec() { printf '\033]1337;CurrentCommand=%s\007' "$1"; }
lumina_precmd() { printf '\033]1337;CurrentCommandExit=%s\007' "$?"; }
preexec_functions+=(lumina_preexec)
precmd_functions+=(lumina_precmd)
