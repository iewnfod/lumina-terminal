# Lumina proxy sync (zsh): apply the system-proxy env-file before each
# prompt. Values Lumina injects are tracked per key; only those are ever
# unset, so manually exported proxies survive a proxy-off transition.
__lumina_proxy_get() {
    local __lumina_line
    while IFS= read -r __lumina_line; do
        case "$__lumina_line" in
            "$1="*) printf '%s' "${__lumina_line#*=}"; return 0 ;;
        esac
    done <<< "$__LUMINA_PROXY_CUR"
    return 1
}
__lumina_proxy_set() {
    local __lumina_key=$1 __lumina_val=$2
    local __lumina_marker="__LUMINA_INJ_$1"
    if [ -n "$__lumina_val" ]; then
        export "$__lumina_key=$__lumina_val"
        typeset -g "$__lumina_marker=$__lumina_val"
    elif [ -n "${(P)__lumina_marker-}" ] && [ "${(P)__lumina_key-}" = "${(P)__lumina_marker-}" ]; then
        unset "$__lumina_key"
        unset "$__lumina_marker"
    else
        unset "$__lumina_marker"
    fi
}
__lumina_proxy() {
    local __lumina_f={env_path}
    local __lumina_cur=''
    if [ -r "$__lumina_f" ]; then
        IFS= read -r -d '' __lumina_cur < "$__lumina_f" || true
    fi
    if [ "$__lumina_cur" = "${__LUMINA_PROXY_FILE-}" ]; then
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
}
precmd_functions+=(__lumina_proxy)