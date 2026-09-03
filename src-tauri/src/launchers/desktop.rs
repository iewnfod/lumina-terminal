//! Linux Desktop Entry content for one profile launcher: the
//! `[Desktop Entry]` document and its Exec= escaping (per the spec). Pure
//! string building — the parent module (`launchers`) writes these files.

/// Escape one argv token for a Desktop Entry `Exec=` value, per the spec:
/// `%` doubles (field codes are reserved), a token containing any reserved
/// character is double-quoted, and `"` `` ` `` `$` `\` gain a backslash
/// inside quotes. Pure — tests drive the nasty inputs.
pub fn escape_desktop_exec_arg(arg: &str) -> String {
    let doubled = arg.replace('%', "%%");
    let reserved = |c: char| {
        matches!(
            c,
            ' ' | '\t'
                | '\n'
                | '\r'
                | '"'
                | '\''
                | '\\'
                | '>'
                | '<'
                | '~'
                | '|'
                | '&'
                | ';'
                | '$'
                | '*'
                | '?'
                | '#'
                | '('
                | ')'
                | '`'
        )
    };
    if !doubled.chars().any(reserved) {
        return doubled;
    }
    let mut out = String::with_capacity(doubled.len() + 2);
    out.push('"');
    for c in doubled.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// A `[Desktop Entry]` document for one launcher. `icon_path` may be None
/// (no icon resource available → the entry renders with a generic icon).
pub fn desktop_entry_content(
    exe: &str,
    args: &[String],
    name: &str,
    icon_path: Option<&str>,
) -> String {
    let exec = std::iter::once(exe.to_string())
        .chain(args.iter().cloned())
        .map(|a| escape_desktop_exec_arg(&a))
        .collect::<Vec<_>>()
        .join(" ");
    let mut out = String::new();
    out.push_str("[Desktop Entry]\n");
    out.push_str("Type=Application\n");
    out.push_str(&format!("Name={}\n", desktop_value(name)));
    out.push_str(&format!("Exec={}\n", exec));
    if let Some(icon) = icon_path {
        out.push_str(&format!("Icon={}\n", desktop_value(icon)));
    }
    out.push_str("Terminal=false\n");
    out.push_str("Categories=System;TerminalEmulator;\n");
    out.push_str(&format!(
        "Comment=Lumina Terminal profile: {}\n",
        desktop_value(name)
    ));
    out
}

/// Escape a desktop-file value: control characters become spaces (the spec
/// forbids them outright; a space keeps the file parseable).
fn desktop_value(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}
