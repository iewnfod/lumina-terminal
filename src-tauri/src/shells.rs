use std::path::PathBuf;

/// Scan one PATH-style value (`sep`-joined directories, `:` on Unix / `;` on
/// Windows) for candidate binary names, appending existing hits to `out` in
/// scan order with dedup. Fully parameterized (no env reads) so tests can
/// drive it with a controlled temp directory; [`find_shells`] feeds it the
/// process PATH.
pub fn scan_path_for(path_value: &str, sep: char, candidates: &[&str], out: &mut Vec<String>) {
    for dir in path_value.split(sep) {
        for name in candidates {
            let full = PathBuf::from(dir).join(name);
            if full.is_file() {
                let s = full.to_string_lossy().to_string();
                if !out.contains(&s) {
                    out.push(s);
                }
            }
        }
    }
}

/// Discover installed shells on the system by scanning PATH plus known install
/// directories. Used by the profile editor's shell picker so the user can
/// choose from shells that actually exist on their machine.
///
/// On Windows this also scans MSYS2 / Git Bash / Scoop install roots, since
/// those shells rarely live on the system PATH. Duplicates are deduped;
/// results are unordered.
#[tauri::command]
pub fn find_shells() -> Vec<String> {
    let mut shells: Vec<String> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        // Common Windows shells
        let candidates = [
            "powershell.exe",
            "pwsh.exe",
            "cmd.exe",
            "bash.exe",
            "wsl.exe",
            "zsh.exe",
            "fish.exe",
            "nu.exe",
        ];
        // Check PATH
        if let Ok(path) = std::env::var("PATH") {
            scan_path_for(&path, ';', &candidates, &mut shells);
        } else {
            log::warn!("PATH env var not set; Windows shell discovery limited to known dirs");
        }
        // Also check known install directories
        let extra_dirs = [
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Program Files (x86)\PowerShell\7\pwsh.exe",
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files\Git\usr\bin\bash.exe",
            r"C:\msys64\usr\bin\bash.exe",
            r"C:\msys64\usr\bin\zsh.exe",
            r"C:\cygwin64\bin\bash.exe",
            r"C:\cygwin64\bin\zsh.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Windows\System32\cmd.exe",
            r"C:\Windows\SysWOW64\cmd.exe",
        ];
        for path in &extra_dirs {
            let p = PathBuf::from(path);
            if p.is_file() && !shells.contains(&p.to_string_lossy().to_string()) {
                shells.push(p.to_string_lossy().to_string());
            }
        }

        // Scan MSYS2 directories
        let msys2_roots = [
            r"C:\msys64",
            r"C:\msys2",
        ];
        // Also check Scoop-installed MSYS2
        let scoop_msys2 = std::env::var("USERPROFILE")
            .map(|home| PathBuf::from(home).join(r"scoop\apps\msys2\current"))
            .ok();

        let shell_names = ["bash.exe", "zsh.exe", "fish.exe", "sh.exe"];

        for root in &msys2_roots {
            let usr_bin = PathBuf::from(root).join(r"usr\bin");
            if usr_bin.is_dir() {
                for name in &shell_names {
                    let full = usr_bin.join(name);
                    if full.is_file() && !shells.contains(&full.to_string_lossy().to_string()) {
                        shells.push(full.to_string_lossy().to_string());
                    }
                }
            }
        }

        if let Some(ref scoop_path) = scoop_msys2 {
            let usr_bin = scoop_path.join(r"usr\bin");
            if usr_bin.is_dir() {
                for name in &shell_names {
                    let full = usr_bin.join(name);
                    if full.is_file() && !shells.contains(&full.to_string_lossy().to_string()) {
                        shells.push(full.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Unix-like: common shells
        let candidates = [
            "bash", "zsh", "fish", "sh", "dash", "tcsh", "csh", "ksh", "nu", "elvish",
        ];
        if let Ok(path) = std::env::var("PATH") {
            scan_path_for(&path, ':', &candidates, &mut shells);
        } else {
            log::warn!("PATH env var not set; shell discovery limited to known dirs");
        }
        // Also check common install directories
        let extra_dirs = [
            "/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash",
            "/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh",
            "/bin/fish", "/usr/bin/fish", "/usr/local/bin/fish",
            "/bin/sh", "/usr/bin/sh",
            "/opt/homebrew/bin/bash", "/opt/homebrew/bin/zsh", "/opt/homebrew/bin/fish",
            "/home/linuxbrew/.linuxbrew/bin/bash",
            "/home/linuxbrew/.linuxbrew/bin/zsh",
            "/home/linuxbrew/.linuxbrew/bin/fish",
        ];
        for path in &extra_dirs {
            let p = PathBuf::from(path);
            if p.is_file() && !shells.contains(&p.to_string_lossy().to_string()) {
                shells.push(p.to_string_lossy().to_string());
            }
        }
    }

    log::debug!("find_shells: discovered {} shell(s)", shells.len());
    shells
}
