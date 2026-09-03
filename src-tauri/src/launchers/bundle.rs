//! macOS .app bundle content for one profile launcher: the POSIX exec
//! script and the `Info.plist`. Pure string building — the parent module
//! (`launchers`) assembles the bundle directory around these.

/// Quote a token for a POSIX shell script. Unquoted when it is plainly safe
/// (the classic `[A-Za-z0-9_@%+=:,./-]` set); otherwise single-quoted with
/// `'\''` escapes.
pub fn quote_sh(s: &str) -> String {
    let safe = !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "@%+=:,./-_".contains(c));
    if safe {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The macOS bundle executable: a `/bin/sh` script that `exec`s the real
/// binary with the launcher's CLI args. (The window belongs to the Lumina
/// process, so the Dock shows Lumina's icon — a documented v1 tradeoff.)
pub fn launcher_script_content(exe: &str, args: &[String]) -> String {
    let mut line = String::from("exec ");
    line.push_str(&quote_sh(exe));
    for a in args {
        line.push(' ');
        line.push_str(&quote_sh(a));
    }
    format!("#!/bin/sh\n{line}\n")
}

/// XML-escape a plist string value.
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// The bundle's `Info.plist`. `icon_file` is a file *name* inside
/// `Contents/Resources` (None = no `CFBundleIconFile` key).
pub fn plist_content(
    bundle_executable: &str,
    bundle_id: &str,
    display_name: &str,
    icon_file: Option<&str>,
) -> String {
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n");
    out.push_str("<plist version=\"1.0\">\n<dict>\n");
    fn key(out: &mut String, k: &str, v: &str) {
        out.push_str(&format!(
            "    <key>{k}</key>\n    <string>{}</string>\n",
            xml_escape(v)
        ));
    }
    key(&mut out, "CFBundlePackageType", "APPL");
    key(&mut out, "CFBundleName", display_name);
    key(&mut out, "CFBundleDisplayName", display_name);
    key(&mut out, "CFBundleIdentifier", bundle_id);
    key(&mut out, "CFBundleExecutable", bundle_executable);
    if let Some(icon) = icon_file {
        key(&mut out, "CFBundleIconFile", icon);
    }
    key(&mut out, "CFBundleVersion", "1");
    out.push_str("</dict>\n</plist>\n");
    out
}
