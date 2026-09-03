//! Profile launcher ("wrap as app") generation: the backend half of the
//! per-profile desktop-launcher feature (frontend `lib/launcherApi.ts` +
//! `lib/launcherIcon.ts` + the ProfileSettings "wrap as app" section).
//!
//! A launcher is just the app's own CLI re-invoked with window-shaping flags
//! (`--profile <name> -T <title> [--working-directory <dir>] [--sidebar
//! hide]` — see `cli.rs`), materialized as a platform launcher file:
//!   - Linux   `~/.local/share/applications/lumina-<stem>.desktop`
//!   - macOS   `~/Applications/<Title>.app` (Info.plist + exec script + icns)
//!   - Windows `<Start Menu>\Programs\Lumina\<name>.lnk` (created by a
//!              one-shot PowerShell `WScript.Shell` call — no COM crates)
//!
//! One command drives everything: [`sync_profile_launchers`] receives the
//! full spec list and regenerates every launcher (idempotent overwrite),
//! then prunes files this module owns that no spec references anymore — so
//! renaming/deleting a profile (or turning the feature off) self-heals on the
//! next config save. Ownership is proven before any delete: filename prefix
//! on Linux, a dedicated Start-Menu subdir on Windows, and the bundle id
//! inside `Info.plist` on macOS (never a bare `*.app` name match).
//!
//! Everything file-shaped is a pure, dir-parameterized `pub fn` so the
//! integration tests (`tests/launchers.rs`) can drive all three formats on
//! every platform; only the real PowerShell execution is `cfg(windows)`.

mod bundle;
mod desktop;
mod icons;
mod shortcut;

// The platform content builders live in their own files; re-exported here so
// `crate::launchers::*` (lib.rs) and the integration tests keep their
// existing paths.
pub use bundle::{launcher_script_content, plist_content, quote_sh};
pub use desktop::{desktop_entry_content, escape_desktop_exec_arg};
pub use icons::{icns_from_png, ico_from_png, png_width};
pub use shortcut::shortcut_ps1;
use shortcut::write_shortcut_file;

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::utils::{content_hash_hex, prune_files_not_in, write_atomic};
use tauri::Manager;

/// Prefix every generated bundle id shares — the macOS ownership mark.
pub const BUNDLE_ID_PREFIX: &str = "com.iewnfod.lumina-terminal.launcher.";

/// Directory (under the app data dir) holding launcher icon files.
pub const LAUNCHER_ICONS_DIR: &str = "launcher-icons";

// ---------------------------------------------------------------------------
// Spec types (the frontend contract)
// ---------------------------------------------------------------------------

/// Icon payload for one launcher — exactly one field set. The frontend
/// resolves the profile's icon choice (explicit override, auto-derive from
/// the startup command, or nothing) into whichever form it can produce:
/// SVG text (crisp on Linux), a rasterized PNG (wrapped into icns/ico on
/// macOS/Windows), or a file already stored in the command-icons dir.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherIcon {
    /// SVG document text.
    pub svg: Option<String>,
    /// PNG bytes, base64-encoded.
    pub png_base64: Option<String>,
    /// File name inside the app's `command-icons` dir (png or svg).
    pub command_icon_file: Option<String>,
}

/// One profile launcher as computed by the frontend from the saved config.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherSpec {
    /// Profile name passed to `--profile` (resolved against the config at
    /// launch; falls back to the default profile when missing).
    pub profile: String,
    /// Display name + `-T` window title. Empty falls back to the profile
    /// name (see [`display_name`]).
    pub title: String,
    /// `--working-directory` override (empty/None = profile default).
    pub working_directory: Option<String>,
    /// `--sidebar show|hide` (anything else is dropped).
    pub sidebar: Option<String>,
    /// Icon payload; `None` = the app's own bundled icon.
    pub icon: Option<LauncherIcon>,
}

/// Outcome of a sync, surfaced to the frontend for logging/feedback.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherSyncReport {
    pub created: Vec<String>,
    pub removed: Vec<String>,
    /// The platform directory launchers were written to.
    pub dir: String,
}

/// All filesystem locations the generator touches. Parameterized (rather
/// than resolved from the app handle here) so tests can point everything at
/// a temp dir. Only the field matching [`LauncherFormat`] is read; the
/// others are still resolved to real paths so a mismatch is visible.
pub struct LauncherDirs {
    /// Linux: `~/.local/share/applications`.
    pub applications: PathBuf,
    /// macOS: `~/Applications`.
    pub applications_mac: PathBuf,
    /// Windows: Start Menu `...\Programs\Lumina` (exclusively ours).
    pub programs: PathBuf,
    /// `<app data dir>/launcher-icons` — shared icon cache.
    pub launcher_icons: PathBuf,
    /// `<app data dir>/command-icons` — user-imported icon source.
    pub command_icons: PathBuf,
}

/// The app's own icon resources, bundled via `tauri.conf.json`
/// `bundle.resources`. Both are optional so a missing resource degrades to
/// a launcher without an icon instead of failing the whole sync.
pub struct AppIconResources {
    /// `icons/icon.png` bytes (Linux default icon).
    pub png: Option<Vec<u8>>,
    /// `icons/icon.icns` bytes (macOS default icon).
    pub icns: Option<Vec<u8>>,
}

/// Which platform's launcher file format to generate. Picked by `cfg!` in
/// the command wrapper; the generator itself stays cfg-free so tests on any
/// host can build and inspect all three.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LauncherFormat {
    DesktopEntry,
    AppBundle,
    Shortcut,
}

/// Display name for the launcher: the trimmed title, falling back to the
/// profile name.
pub fn display_name(spec: &LauncherSpec) -> &str {
    let title = spec.title.trim();
    if title.is_empty() {
        spec.profile.as_str()
    } else {
        title
    }
}

/// The full CLI argument vector a launcher invokes the app with. Shared by
/// all three formats so `.desktop` Exec, the macOS exec script and the
/// Windows shortcut arguments can never drift apart.
pub fn launcher_cli_args(spec: &LauncherSpec) -> Vec<String> {
    let mut args = vec![
        "--profile".to_string(),
        spec.profile.clone(),
        "-T".to_string(),
        display_name(spec).to_string(),
    ];
    if let Some(wd) = spec
        .working_directory
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.push("--working-directory".to_string());
        args.push(wd.to_string());
    }
    if let Some(sidebar) = spec.sidebar.as_deref() {
        if sidebar == "show" || sidebar == "hide" {
            args.push("--sidebar".to_string());
            args.push(sidebar.to_string());
        }
    }
    args
}

/// File-name-safe stem for launcher files: reuses the command-icon
/// sanitizer (lowercase `[a-z0-9-]`, capped) behind a `lumina-` prefix so
/// generated files are recognizable and never collide with other apps'.
pub fn launcher_stem(profile: &str) -> String {
    format!("lumina-{}", crate::command_icons::sanitize_stem(profile))
}

/// The bundle id for a launcher stem.
pub fn bundle_id(stem: &str) -> String {
    format!("{BUNDLE_ID_PREFIX}{stem}")
}

/// Turn a display name into a usable file/dir name on any platform: map
/// path-hostile characters to `-`, drop control chars, trim separators and
/// dots/spaces (Windows dislikes trailing dots). Keeps unicode — macOS
/// bundle names and Start-Menu entries read best verbatim. Falls back to
/// `launcher` when nothing survives.
pub fn sanitize_file_name(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = mapped.trim_matches(|c: char| c == '-' || c == '.' || c.is_whitespace());
    if trimmed.is_empty() {
        "launcher".to_string()
    } else {
        trimmed.to_string()
    }
}

// ---------------------------------------------------------------------------
// Icon materialization
// ---------------------------------------------------------------------------

/// An icon reduced to bytes before any format-specific wrapping.
enum IconMaterial {
    Svg(String),
    Png(Vec<u8>),
}

/// Validate and reduce a [`LauncherIcon`] to [`IconMaterial`]. `None` means
/// "use the app's own icon". Fails when more than one field is set, the
/// base64 is malformed, or `command_icon_file` names anything other than a
/// plain file inside the command-icons dir (traversal guard).
fn materialize_icon(
    icon: &LauncherIcon,
    command_icons_dir: &Path,
) -> Result<Option<IconMaterial>, String> {
    let svg = icon.svg.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let png = icon
        .png_base64
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let file = icon
        .command_icon_file
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let set = svg.is_some() as u8 + png.is_some() as u8 + file.is_some() as u8;
    if set > 1 {
        return Err("Launcher icon carries more than one payload".to_string());
    }
    if let Some(svg) = svg {
        return Ok(Some(IconMaterial::Svg(svg.to_string())));
    }
    if let Some(png) = png {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(png)
            .map_err(|e| format!("Launcher icon PNG is not valid base64: {e}"))?;
        return Ok(Some(IconMaterial::Png(bytes)));
    }
    if let Some(file) = file {
        if file.contains(['/', '\\']) || file.contains("..") {
            return Err(format!(
                "Launcher icon file must be a plain name inside the command-icons dir: {file}"
            ));
        }
        let path = command_icons_dir.join(file);
        let ext = crate::command_icons::ext_of(file);
        let bytes = std::fs::read(&path)
            .map_err(|e| format!("Failed to read launcher icon {}: {e}", path.display()))?;
        return match ext.as_str() {
            ".svg" => Ok(Some(IconMaterial::Svg(String::from_utf8(bytes).map_err(
                |_| format!("Launcher icon {file} is not valid UTF-8 SVG"),
            )?))),
            ".png" => Ok(Some(IconMaterial::Png(bytes))),
            _ => Err(format!(
                "Unsupported launcher icon extension {ext:?} — use SVG or PNG"
            )),
        };
    }
    Ok(None)
}

/// Content-addressed storage name for an icon payload, so identical icons
/// share one file and prune naturally.
fn icon_storage_name(bytes: &[u8], ext: &str) -> String {
    format!("icon-{}{ext}", content_hash_hex(bytes))
}

// ---------------------------------------------------------------------------
// Generation + sync
// ---------------------------------------------------------------------------

/// Write `bytes` to `path` atomically (tmp+rename), creating parent
/// directories as needed — a torn .desktop entry must never be visible.
pub(crate) fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic(path, bytes).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

/// Store icon bytes in the launcher-icons cache under their content-hashed
/// name and return the path.
fn store_icon(dir: &Path, bytes: &[u8], ext: &str) -> Result<PathBuf, String> {
    let path = dir.join(icon_storage_name(bytes, ext));
    write_file(&path, bytes)?;
    Ok(path)
}

/// One launcher's filesystem footprint (main file + icon side files).
struct Generated {
    path: PathBuf,
    extras: Vec<PathBuf>,
}

/// Generate one launcher of `format` into its platform dir. Pure-ish over
/// the injected dirs; all failures are `Err(String)` per the module style.
fn generate_launcher(
    dirs: &LauncherDirs,
    format: LauncherFormat,
    spec: &LauncherSpec,
    icon: Option<&IconMaterial>,
    resources: &AppIconResources,
    exe: &str,
) -> Result<Generated, String> {
    let stem = launcher_stem(&spec.profile);
    let name = display_name(spec);
    let args = launcher_cli_args(spec);

    match format {
        LauncherFormat::DesktopEntry => {
            let mut extras = Vec::new();
            // Icon: prefer SVG (vector on HiDPI), then PNG, then the
            // bundled app png. No resource at all → no Icon key.
            let icon_path = match icon {
                Some(IconMaterial::Svg(svg)) => Some(
                    store_icon(&dirs.launcher_icons, svg.as_bytes(), ".svg").map(|p| {
                        extras.push(p.clone());
                        p
                    })?,
                ),
                Some(IconMaterial::Png(png)) => {
                    Some(store_icon(&dirs.launcher_icons, png, ".png").map(|p| {
                        extras.push(p.clone());
                        p
                    })?)
                }
                None => match resources.png.as_ref() {
                    Some(png) => Some(store_icon(&dirs.launcher_icons, png, ".png").map(|p| {
                        extras.push(p.clone());
                        p
                    })?),
                    None => None,
                },
            };
            let content = desktop_entry_content(
                exe,
                &args,
                name,
                icon_path
                    .map(|p| p.to_string_lossy().to_string())
                    .as_deref(),
            );
            let path = dirs.applications.join(format!("{stem}.desktop"));
            write_file(&path, content.as_bytes())?;
            Ok(Generated { path, extras })
        }
        LauncherFormat::AppBundle => {
            let bundle_dir = dirs
                .applications_mac
                .join(format!("{}.app", sanitize_file_name(name)));
            let contents = bundle_dir.join("Contents");
            let macos = contents.join("MacOS");
            let resources_dir = contents.join("Resources");

            // Icon: PNG → wrap into icns; SVG can't rasterize on this side,
            // so it falls back to the bundled app icns (caller warns).
            let icns_bytes = match icon {
                Some(IconMaterial::Png(png)) => Some(icns_from_png(png)),
                _ => resources.icns.clone(),
            };
            let icon_file = icns_bytes.as_ref().map(|_| format!("{stem}.icns"));

            let script_path = macos.join(&stem);
            write_file(&script_path, launcher_script_content(exe, &args).as_bytes())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ =
                    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755));
            }
            if let Some(bytes) = icns_bytes.as_ref() {
                write_file(&resources_dir.join(format!("{stem}.icns")), bytes)?;
            }
            let plist = plist_content(&stem, &bundle_id(&stem), name, icon_file.as_deref());
            write_file(&contents.join("Info.plist"), plist.as_bytes())?;
            Ok(Generated {
                path: bundle_dir,
                extras: Vec::new(),
            })
        }
        LauncherFormat::Shortcut => {
            let mut extras = Vec::new();
            let lnk = dirs
                .programs
                .join(format!("{}.lnk", sanitize_file_name(name)));
            // IconLocation: PNG → wrapped .ico beside the shortcuts; SVG
            // (unrasterizable here) and no icon → `<exe>,0` — the binary's
            // embedded icon, free and always present.
            let icon_location = match icon {
                Some(IconMaterial::Png(png)) => {
                    let ico = ico_from_png(png);
                    let path = store_icon(&dirs.programs, &ico, ".ico").map(|p| {
                        extras.push(p.clone());
                        p
                    })?;
                    format!("{},0", path.to_string_lossy())
                }
                _ => format!("{exe},0"),
            };
            let script = shortcut_ps1(
                &lnk.to_string_lossy(),
                exe,
                &args,
                spec.working_directory
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
                Some(icon_location.as_str()),
            );
            write_shortcut_file(&lnk, &script)?;
            Ok(Generated { path: lnk, extras })
        }
    }
}

/// Regenerate every launcher in `specs` (idempotent overwrite), then prune
/// files this module owns that no spec produced. Returns what happened.
pub fn sync_launchers(
    dirs: &LauncherDirs,
    specs: &[LauncherSpec],
    resources: &AppIconResources,
    exe: &str,
    format: LauncherFormat,
) -> Result<LauncherSyncReport, String> {
    let target_dir = match format {
        LauncherFormat::DesktopEntry => &dirs.applications,
        LauncherFormat::AppBundle => &dirs.applications_mac,
        LauncherFormat::Shortcut => &dirs.programs,
    };
    std::fs::create_dir_all(&dirs.launcher_icons)
        .map_err(|e| format!("Failed to create {}: {e}", dirs.launcher_icons.display()))?;
    std::fs::create_dir_all(target_dir)
        .map_err(|e| format!("Failed to create {}: {e}", target_dir.display()))?;

    let mut created: Vec<PathBuf> = Vec::new();
    let mut owned_files: Vec<PathBuf> = Vec::new();
    for spec in specs {
        if spec.profile.trim().is_empty() {
            log::warn!("Skipping launcher spec with an empty profile name");
            continue;
        }
        let icon = match spec
            .icon
            .as_ref()
            .map(|i| materialize_icon(i, &dirs.command_icons))
        {
            Some(Ok(icon)) => icon,
            Some(Err(e)) => {
                log::warn!(
                    "Launcher icon for profile {:?} rejected, using the app icon: {e}",
                    spec.profile
                );
                None
            }
            None => None,
        };
        if matches!(icon, Some(IconMaterial::Svg(_))) && format != LauncherFormat::DesktopEntry {
            log::warn!(
                "Launcher icon for profile {:?} is SVG-only; macOS/Windows cannot rasterize it, falling back to the app icon",
                spec.profile
            );
        }
        match generate_launcher(dirs, format, spec, icon.as_ref(), resources, exe) {
            Ok(generated) => {
                created.push(generated.path);
                owned_files.extend(generated.extras);
            }
            Err(e) => {
                log::error!(
                    "Failed to generate launcher for profile {:?}: {e}",
                    spec.profile
                );
                return Err(e);
            }
        }
    }

    let removed = prune_launchers(dirs, format, &created, &owned_files)?;

    Ok(LauncherSyncReport {
        created: created
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
        removed,
        dir: target_dir.to_string_lossy().to_string(),
    })
}

/// Delete launcher files this module owns that are not in `keep` /
/// `keep_files`. Every deletion requires an ownership proof (see the module
/// doc); unknown files are never touched.
fn prune_launchers(
    dirs: &LauncherDirs,
    format: LauncherFormat,
    keep: &[PathBuf],
    keep_files: &[PathBuf],
) -> Result<Vec<String>, String> {
    let mut removed = Vec::new();

    // Launcher icon cache: a dedicated dir, so every plain file in it was
    // written by this module.
    prune_dir_files(&dirs.launcher_icons, keep_files, &mut removed)?;

    let target_dir = match format {
        LauncherFormat::DesktopEntry => &dirs.applications,
        LauncherFormat::AppBundle => &dirs.applications_mac,
        LauncherFormat::Shortcut => &dirs.programs,
    };
    match format {
        LauncherFormat::DesktopEntry => {
            // Ownership = the `lumina-` filename prefix.
            for entry in read_dir_entries(target_dir)? {
                let name = entry
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if name.starts_with("lumina-")
                    && name.ends_with(".desktop")
                    && !keep.contains(&entry)
                {
                    match std::fs::remove_file(&entry) {
                        Ok(()) => removed.push(name),
                        Err(e) => log::warn!("Failed to prune launcher {}: {e}", entry.display()),
                    }
                }
            }
        }
        LauncherFormat::AppBundle => {
            // Ownership = our bundle id inside the bundle's Info.plist. A
            // bundle whose plist can't be read is NOT ours — never delete.
            for entry in read_dir_entries(target_dir)? {
                if !entry.is_dir() || entry.extension().map(|e| e != "app").unwrap_or(true) {
                    continue;
                }
                if keep.contains(&entry) {
                    continue;
                }
                let Ok(plist) = std::fs::read_to_string(entry.join("Contents").join("Info.plist"))
                else {
                    continue;
                };
                if plist.contains(BUNDLE_ID_PREFIX) && std::fs::remove_dir_all(&entry).is_ok() {
                    removed.push(entry.to_string_lossy().to_string());
                }
            }
        }
        LauncherFormat::Shortcut => {
            // The Start-Menu `Lumina` subdir is exclusively ours; only the
            // file extensions we write are candidates.
            for entry in read_dir_entries(target_dir)? {
                if !entry.is_file() {
                    continue;
                }
                let name = entry
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let ours = (name.ends_with(".lnk") || name.ends_with(".ico"))
                    && !keep.contains(&entry)
                    && !keep_files.contains(&entry);
                if ours {
                    match std::fs::remove_file(&entry) {
                        Ok(()) => removed.push(name),
                        Err(e) => log::warn!("Failed to prune launcher {}: {e}", entry.display()),
                    }
                }
            }
        }
    }
    Ok(removed)
}

/// Delete plain files in `dir` that are not in `keep`. A missing dir is a
/// no-op (nothing generated yet). `keep` holds full paths from the same dir;
/// only the file names participate in the comparison.
fn prune_dir_files(dir: &Path, keep: &[PathBuf], removed: &mut Vec<String>) -> Result<(), String> {
    let keep_names: Vec<String> = keep
        .iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .collect();
    let pruned = prune_files_not_in(dir, &keep_names, "icon file")?;
    removed.extend(pruned);
    Ok(())
}

fn read_dir_entries(dir: &Path) -> Result<Vec<PathBuf>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).collect())
        .map_err(|e| format!("Failed to list {}: {e}", dir.display()))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Resolve the executable a launcher should invoke. Linux AppImages mount
/// at a fresh `/tmp/.mount_*` per run, so `current_exe()` there is NOT
/// stable — `$APPIMAGE` (the .AppImage file path itself) survives updates
/// and is preferred whenever it is set.
fn resolve_lumina_exe() -> String {
    #[cfg(target_os = "linux")]
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        if !appimage.trim().is_empty() {
            return appimage;
        }
    }
    match std::env::current_exe() {
        Ok(exe) => exe.to_string_lossy().to_string(),
        Err(e) => {
            log::error!(
                "Cannot resolve current_exe for launchers ({e}); falling back to PATH lookup"
            );
            "lumina-terminal".to_string()
        }
    }
}

/// The launcher format for the host platform.
fn current_format() -> LauncherFormat {
    if cfg!(target_os = "macos") {
        LauncherFormat::AppBundle
    } else if cfg!(target_os = "windows") {
        LauncherFormat::Shortcut
    } else {
        LauncherFormat::DesktopEntry
    }
}

/// Resolve every directory the generator touches. Fields for other
/// platforms still point at their real locations (visible in logs if a
/// resolution ever fails); only the current format's field is read.
fn resolve_launcher_dirs(app: &tauri::AppHandle) -> Result<LauncherDirs, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let launcher_icons = data.join(LAUNCHER_ICONS_DIR);
    let command_icons = data.join(crate::command_icons::COMMAND_ICONS_DIR);

    #[cfg(target_os = "linux")]
    let applications = app
        .path()
        .data_dir()
        .map(|d| d.join("applications"))
        .unwrap_or_else(|_| launcher_icons.clone());
    #[cfg(not(target_os = "linux"))]
    let applications = launcher_icons.clone();

    #[cfg(target_os = "macos")]
    let applications_mac = app
        .path()
        .home_dir()
        .map(|h| h.join("Applications"))
        .unwrap_or_else(|_| launcher_icons.clone());
    #[cfg(not(target_os = "macos"))]
    let applications_mac = launcher_icons.clone();

    #[cfg(target_os = "windows")]
    let programs = app
        .path()
        .data_dir()
        .map(|d| {
            d.join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("Lumina")
        })
        .unwrap_or_else(|_| launcher_icons.clone());
    #[cfg(not(target_os = "windows"))]
    let programs = launcher_icons.clone();

    Ok(LauncherDirs {
        applications,
        applications_mac,
        programs,
        launcher_icons,
        command_icons,
    })
}

/// Read the app's own bundled icon resources (see `bundle.resources` in
/// tauri.conf.json). Missing files degrade to `None` — a launcher without
/// an icon beats a failed sync.
fn resolve_app_icon_resources(app: &tauri::AppHandle) -> AppIconResources {
    let read = |name: &str| -> Option<Vec<u8>> {
        let path = app.path().resource_dir().ok()?.join("icons").join(name);
        match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(e) => {
                log::warn!(
                    "Bundled icon {} unavailable for launchers: {e}",
                    path.display()
                );
                None
            }
        }
    };
    AppIconResources {
        png: read("icon.png"),
        icns: read("icon.icns"),
    }
}

/// Regenerate every profile launcher and prune orphaned ones. Called by the
/// frontend after each config save with the full spec list (empty list =
/// remove all launchers). See the module doc for the ownership rules.
#[tauri::command]
pub fn sync_profile_launchers(
    app: tauri::AppHandle,
    specs: Vec<LauncherSpec>,
) -> Result<LauncherSyncReport, String> {
    let dirs = resolve_launcher_dirs(&app)?;
    let resources = resolve_app_icon_resources(&app);
    let exe = resolve_lumina_exe();
    let format = current_format();
    log::info!(
        "Syncing {} launcher spec(s) (exe={exe}, format={format:?})",
        specs.len()
    );
    match sync_launchers(&dirs, &specs, &resources, &exe, format) {
        Ok(report) => {
            log::info!(
                "Launcher sync: {} created/updated, {} removed (dir: {})",
                report.created.len(),
                report.removed.len(),
                report.dir
            );
            // Best-effort desktop database refresh so new entries appear in
            // app menus without relogin; absence is normal on minimal systems.
            #[cfg(target_os = "linux")]
            if format == LauncherFormat::DesktopEntry {
                match std::process::Command::new("update-desktop-database")
                    .arg(&dirs.applications)
                    .status()
                {
                    Ok(status) if !status.success() => {
                        log::debug!("update-desktop-database exited with {status}");
                    }
                    Err(e) => {
                        log::debug!("update-desktop-database not runnable ({e})");
                    }
                    Ok(_) => {}
                }
            }
            Ok(report)
        }
        Err(e) => {
            log::error!("Launcher sync failed: {e}");
            Err(e)
        }
    }
}

/// The directory launchers are written to on this platform (created if
/// missing), so the settings page can reveal it in the file manager.
#[tauri::command]
pub fn get_launcher_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dirs = resolve_launcher_dirs(&app)?;
    let dir = match current_format() {
        LauncherFormat::DesktopEntry => dirs.applications,
        LauncherFormat::AppBundle => dirs.applications_mac,
        LauncherFormat::Shortcut => dirs.programs,
    };
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create launcher dir {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().to_string())
}
