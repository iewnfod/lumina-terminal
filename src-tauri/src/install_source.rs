/// How this copy of the app was installed, if it can be determined.
///
/// When present, the frontend disables the in-app self-updater and points the
/// user at their system package manager instead: Tauri v2's updater only
/// supports AppImage on Linux, so it fails on `.deb`/pacman-managed installs
/// with errors like "Cannot run updater on this platform".
///
/// `manager` is the lowercase family name; `package` is the owning package as
/// reported by that manager (e.g. "lumina-terminal-bin").
#[derive(Debug, serde::Serialize)]
pub struct InstallSource {
    pub manager: String,
    pub package: String,
}

/// Parse `pacman -Qo <path>` stdout: `"<path> is owned by <pkg> <ver>"` → pkg.
/// Pure — extracted so tests can drive it with captured sample output.
pub fn pacman_owner_package(stdout: &str) -> Option<&str> {
    stdout
        .split("is owned by")
        .nth(1)
        .and_then(|x| x.split_whitespace().next())
}

/// Parse `dpkg -S <path>` stdout: `"<pkg>: <path>"` → pkg. Arch-qualified
/// packages (`pkg:amd64: path`) keep only the name before the first colon.
/// Pure — see [`pacman_owner_package`].
pub fn dpkg_owner_package(stdout: &str) -> Option<&str> {
    let pkg = stdout.split(':').next().unwrap_or("").trim();
    if pkg.is_empty() {
        None
    } else {
        Some(pkg)
    }
}

/// Parse `rpm -qf --queryformat=%{NAME} <path>` stdout → pkg. `rpm` prints
/// "not installed" / "not owned by any package" on a miss; guard against both
/// (and empty output) in case a distro customizes the exit code. Pure — see
/// [`pacman_owner_package`].
pub fn rpm_owner_package(stdout: &str) -> Option<&str> {
    let pkg = stdout.trim();
    if pkg.is_empty() || pkg.starts_with("not") {
        None
    } else {
        Some(pkg)
    }
}

/// Detect whether the running binary is owned by a system package manager.
///
/// On Linux, resolves the current executable with `current_exe()` and asks each
/// package manager whether it owns that path:
///   - `pacman -Qo <path>` → "<path> is owned by <pkg> <ver>"
///   - `dpkg -S <path>`    → "<pkg>: <path>"
///   - `rpm -qf <path>`    → "<pkg>"
///
/// Returns the first hit (pacman → dpkg → rpm order). AppImage mounts
/// (`/tmp/.mount_...`), manual extracts, and every non-Linux platform return
/// `None`, so the in-app updater keeps working where it is actually supported.
#[tauri::command]
pub fn install_source() -> Option<InstallSource> {
    #[cfg(not(target_os = "linux"))]
    {
        None
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;

        let exe = std::env::current_exe().ok()?;
        let path = exe.to_string_lossy().to_string();

        // pacman: "<path> is owned by lumina-terminal-bin 0.1.6-1"
        if let Ok(out) = Command::new("pacman").args(["-Qo", &path]).output() {
            if out.status.success() {
                if let Some(pkg) = pacman_owner_package(&String::from_utf8_lossy(&out.stdout)) {
                    log::info!("install_source: managed by pacman ({})", pkg);
                    return Some(InstallSource {
                        manager: "pacman".into(),
                        package: pkg.into(),
                    });
                }
            }
        }

        // dpkg: "lumina-terminal: /usr/bin/lumina-terminal"
        if let Ok(out) = Command::new("dpkg").args(["-S", &path]).output() {
            if out.status.success() {
                if let Some(pkg) = dpkg_owner_package(&String::from_utf8_lossy(&out.stdout)) {
                    log::info!("install_source: managed by dpkg ({})", pkg);
                    return Some(InstallSource {
                        manager: "dpkg".into(),
                        package: pkg.into(),
                    });
                }
            }
        }

        // rpm: query just the owning package name.
        if let Ok(out) = Command::new("rpm")
            .args(["-qf", "--queryformat", "%{NAME}", &path])
            .output()
        {
            if out.status.success() {
                if let Some(pkg) = rpm_owner_package(&String::from_utf8_lossy(&out.stdout)) {
                    log::info!("install_source: managed by rpm ({})", pkg);
                    return Some(InstallSource {
                        manager: "rpm".into(),
                        package: pkg.into(),
                    });
                }
            }
        }

        log::debug!(
            "install_source: not owned by any package manager (in-app updater OK)"
        );
        None
    }
}
