# Lumina proxy sync (fish): apply the system-proxy env-file before each
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
end