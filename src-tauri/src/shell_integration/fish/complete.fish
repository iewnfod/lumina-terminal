# Lumina completion interception (fish): TAB asks fish's own completion
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
		# Skip candidates whose label would break the OSC framing; drop broken
		# descriptions.
		if string match -qr '[\t\n\r\x1b\x07\x1e\x1f]' -- $__lumina_label
			continue
		end
		if string match -qr '[\t\n\r\x1b\x07\x1e\x1f]' -- $__lumina_desc
			set __lumina_desc ''
		end
		# complete -C reports raw tokens, but the insert text is replayed as
		# keystrokes — a typed bare space would split the argument. Backslash-
		# escape it exactly like fish's own completion accept does; -n is
		# required: the default style stopped escaping spaces in fish 4.9.
		# The label displays only the last path component — the typed line
		# already carries the path prefix, and full paths overflow the row.
		set -l __lumina_ins (string escape -n -- $__lumina_label)
		set -l __lumina_tail (string match -r -- '[^/]+/?$' $__lumina_label)
		if not set -q __lumina_tail[1]
			set __lumina_tail $__lumina_label
		end
		set -a __lumina_payload $__lumina_ins$__lumina_US$__lumina_tail$__lumina_US$__lumina_desc
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
bind \t __lumina_complete