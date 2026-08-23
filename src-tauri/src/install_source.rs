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

/// Run a package-manager query with the C locale forced on the child only.
///
/// pacman localizes its `pacman -Qo` hit line — under zh_CN it prints
/// `"<path> 由 <pkg> <ver> 所拥有"` — which the English-shaped parsers above
/// cannot split, so a non-English user locale silently broke detection.
/// Forcing `LC_ALL`/`LANG`/`LANGUAGE=C` keeps stdout parseable regardless of
/// the user's locale. dpkg/rpm hit lines aren't localized today; they go
/// through the same helper for uniformity and future-proofing.
pub fn query_with_c_locale(
    program: &str,
    args: &[&str],
) -> std::io::Result<std::process::Output> {
    std::process::Command::new(program)
        .args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("LANGUAGE", "C")
        .output()
}

/// Ask one package manager whether it owns `args`' target and map its stdout
/// to the owning package. Every miss is logged so a `None` from
/// [`install_source`] is always diagnosable from the log file: manager absent
/// or failed to run (`debug`), reported not-owned (`debug`, with its stderr),
/// or exited 0 with stdout the parser couldn't split (`warn` — the locale-shape
/// regression class).
#[cfg(target_os = "linux")]
fn owning_package(
    manager: &str,
    args: &[&str],
    parse: impl Fn(&str) -> Option<&str>,
) -> Option<String> {
    let out = match query_with_c_locale(manager, args) {
        Ok(out) => out,
        Err(e) => {
            log::debug!("install_source: {manager} not runnable ({e})");
            return None;
        }
    };
    if !out.status.success() {
        log::debug!(
            "install_source: {manager} reports not owned: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    match parse(&stdout) {
        Some(pkg) => Some(pkg.to_string()),
        None => {
            log::warn!("install_source: {manager} exited 0 but stdout didn't parse: {stdout}");
            None
        }
    }
}

/// Detect whether the running binary is owned by a system package manager.
///
/// On Linux, resolves the current executable with `current_exe()` and asks each
/// package manager (via [`query_with_c_locale`]) whether it owns that path:
///   - `pacman -Qo <path>` → "<path> is owned by <pkg> <ver>"
///   - `dpkg -S <path>`    → "<pkg>: <path>"
///   - `rpm -qf <path>`    → "<pkg>"
///
/// Returns the first hit (pacman → dpkg → rpm order). AppImage mounts
/// (`/tmp/.mount_...`), manual extracts, and every non-Linux platform return
/// `None`, so the in-app updater keeps working where it is actually supported.
/// The resolved path and every per-manager miss are logged, so a dev build
/// running from `target/` explains its own `None` in the log.
#[tauri::command]
pub fn install_source() -> Option<InstallSource> {
    #[cfg(not(target_os = "linux"))]
    {
        None
    }

    #[cfg(target_os = "linux")]
    {
        let exe = match std::env::current_exe() {
            Ok(exe) => exe,
            Err(e) => {
                log::warn!("install_source: cannot resolve current_exe ({e})");
                return None;
            }
        };
        let path = exe.to_string_lossy().to_string();
        log::debug!("install_source: checking package ownership of {path}");

        if let Some(pkg) = owning_package("pacman", &["-Qo", &path], pacman_owner_package) {
            log::info!("install_source: managed by pacman ({pkg})");
            return Some(InstallSource {
                manager: "pacman".into(),
                package: pkg,
            });
        }

        if let Some(pkg) = owning_package("dpkg", &["-S", &path], dpkg_owner_package) {
            log::info!("install_source: managed by dpkg ({pkg})");
            return Some(InstallSource {
                manager: "dpkg".into(),
                package: pkg,
            });
        }

        if let Some(pkg) = owning_package("rpm", &["-qf", "--queryformat", "%{NAME}", &path], rpm_owner_package) {
            log::info!("install_source: managed by rpm ({pkg})");
            return Some(InstallSource {
                manager: "rpm".into(),
                package: pkg,
            });
        }

        log::info!(
            "install_source: {path} is not owned by any package manager (in-app updater OK)"
        );
        None
    }
}
