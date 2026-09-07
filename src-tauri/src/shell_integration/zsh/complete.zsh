# Lumina completion interception (zsh): TAB runs the completion system with
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
bindkey '^I' lumina_complete