//! Windows .lnk shortcut generation: the one-line PowerShell
//! `WScript.Shell` script (pure, its shape tested on every platform) and the
//! write step that executes it for real on Windows / writes the script text
//! on other hosts so the sync/prune tests can run anywhere.

use std::path::Path;

use super::write_file;

/// Escape a PowerShell single-quoted string literal (quote doubling).
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// A one-line PowerShell script that creates a `.lnk` via the
/// `WScript.Shell` COM object. Single line + `;` separators so it can be
/// passed as one `-Command` argument without newline quoting concerns.
/// `icon` is an optional `IconLocation` value (the `<path>,0` form is
/// expected from the caller). Pure — the string shape is tested on every
/// platform; the Windows-only test executes it for real.
pub fn shortcut_ps1(
    lnk_path: &str,
    exe: &str,
    args: &[String],
    working_directory: Option<&str>,
    icon: Option<&str>,
) -> String {
    let mut script = format!(
        "$ErrorActionPreference='Stop';$s=(New-Object -ComObject WScript.Shell).CreateShortcut({});$s.TargetPath={};$s.Arguments={}",
        ps_quote(lnk_path),
        ps_quote(exe),
        ps_quote(&args.join(" ")),
    );
    if let Some(wd) = working_directory.filter(|s| !s.is_empty()) {
        script.push_str(&format!(";$s.WorkingDirectory={}", ps_quote(wd)));
    }
    if let Some(icon) = icon.filter(|s| !s.is_empty()) {
        script.push_str(&format!(";$s.IconLocation={}", ps_quote(icon)));
    }
    script.push_str(";$s.Save()");
    script
}

/// Create a `.lnk`. On Windows, run the PowerShell script for real; on other
/// hosts, write the script text into the file — production never reaches
/// this branch (the command layer picks the format via `cfg!`), but tests
/// on every platform exercise the sync/prune flow for the Shortcut format.
pub(crate) fn write_shortcut_file(lnk: &Path, script: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .map_err(|e| format!("Failed to spawn powershell for {}: {e}", lnk.display()))?;
        if !output.status.success() {
            return Err(format!(
                "powershell failed to create {}: {}",
                lnk.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        write_file(lnk, script.as_bytes())
    }
}
