//! User-imported command icon storage: the backend half of configurable
//! command→icon rules (frontend `lib/appIcon.ts` + `lib/commandIconApi.ts`).
//!
//! Imported images are copied into `<app data dir>/command-icons/` so they
//! survive restarts and can be served to the webview via the asset protocol
//! (scope limited to that directory). Storage names embed a content-hash
//! suffix, so importing the same file twice lands on the same name instead of
//! piling up duplicates. Unreferenced files are pruned by the settings panel
//! on save (`prune_command_icons` receives the still-referenced names).

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

use tauri::Manager;

/// Directory (under the app data dir) that holds imported icon files.
pub const COMMAND_ICONS_DIR: &str = "command-icons";

/// Allowed icon extensions, lowercase with the leading dot.
const ALLOWED_EXTS: [&str; 2] = [".svg", ".png"];
/// Size cap for an imported icon (1 MiB). Icons render at ~14px; anything
/// larger is a wrong file (e.g. a photo), rejected before it is copied.
const MAX_ICON_SIZE: usize = 1024 * 1024;
/// Length cap for the sanitized stem fragment of a storage name.
const MAX_STEM_LEN: usize = 32;

/// Lowercased extension (with leading dot) of a path string; "" when the file
/// name has no extension.
pub fn ext_of(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name.rfind('.') {
        Some(i) => name[i..].to_lowercase(),
        None => String::new(),
    }
}

/// Collapse a file stem into a safe storage-name fragment: lowercase, keep
/// `[a-z0-9]`, turn everything else (including non-ASCII) into `-`, trim the
/// edges, cap the length. Falls back to "icon" when nothing survives (pure
/// punctuation / CJK-only stems), so a storage name is never empty or only a
/// hash. CJK input degrades to the fallback rather than being stripped from
/// the name entirely — the hash suffix still disambiguates files.
pub fn sanitize_stem(stem: &str) -> String {
    let mut out = String::new();
    for ch in stem.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    let capped: String = trimmed.chars().take(MAX_STEM_LEN).collect();
    let capped = capped.trim_matches('-').to_string();
    if capped.is_empty() {
        "icon".to_string()
    } else {
        capped
    }
}

/// Is `ext` (lowercase, with dot) an accepted icon extension?
pub fn is_allowed_ext(ext: &str) -> bool {
    ALLOWED_EXTS.contains(&ext)
}

/// Import (copy) an icon file into `dir`. Validates extension + size cap,
/// then stores the bytes as `<sanitized-stem>-<content-hash>.<ext>`. Returns
/// the stored file name the frontend embeds in a `custom:` icon id.
///
/// Parameterized by `dir` (rather than reading the app data dir here) so the
/// integration tests can point it at a temp directory.
pub fn import_icon_into(dir: &Path, src: &str) -> Result<String, String> {
    let ext = ext_of(src);
    if !is_allowed_ext(&ext) {
        return Err(format!(
            "Unsupported icon format {:?} — use SVG or PNG",
            if ext.is_empty() { "(none)" } else { &ext }
        ));
    }

    let src_path = Path::new(src);
    if !src_path.is_file() {
        return Err(format!("Icon file does not exist: {src}"));
    }

    let bytes = std::fs::read(src_path)
        .map_err(|e| format!("Failed to read icon file {src}: {e}"))?;
    if bytes.len() > MAX_ICON_SIZE {
        return Err(format!(
            "Icon file is too large ({} bytes; limit {})",
            bytes.len(),
            MAX_ICON_SIZE
        ));
    }

    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    let stem = src_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let stored_name = format!("{}-{:016x}{}", sanitize_stem(&stem), hasher.finish(), ext);

    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create icon directory {}: {e}", dir.display()))?;
    let dest = dir.join(&stored_name);
    std::fs::write(&dest, &bytes)
        .map_err(|e| format!("Failed to write icon file {}: {e}", dest.display()))?;

    Ok(stored_name)
}

/// Delete every *file* directly inside `dir` whose name is not in `keep`.
/// Returns the removed names. A missing `dir` is a no-op (nothing imported
/// yet); subdirectories are left alone — only files this module wrote are
/// candidates for deletion.
pub fn prune_icons(dir: &Path, keep: &[String]) -> Result<Vec<String>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut removed = Vec::new();
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to list icon directory {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if keep.iter().any(|k| k == &name) {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => removed.push(name),
            Err(e) => log::warn!("Failed to prune unused icon {}: {e}", path.display()),
        }
    }
    Ok(removed)
}

/// List the stored (imported) icon file names, sorted. A missing `dir` is an
/// empty list. Subdirectories are skipped — only files this module wrote are
/// listed. The settings picker shows every stored icon so a user can switch a
/// rule away and back without re-importing; files only disappear at save time
/// (`prune_command_icons`).
pub fn list_icons(dir: &Path) -> Result<Vec<String>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to list icon directory {}: {e}", dir.display()))?;
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    Ok(names)
}

/// Copy a user-picked icon file (path from the frontend file dialog) into the
/// app data dir's `command-icons/` directory. Returns the stored file name.
#[tauri::command]
pub fn import_command_icon(app: tauri::AppHandle, src: String) -> Result<String, String> {
    let dir = icon_dir(&app)?;
    match import_icon_into(&dir, &src) {
        Ok(name) => {
            log::info!("Imported command icon {name} from {src}");
            Ok(name)
        }
        Err(e) => {
            log::warn!("Command icon import from {src} rejected: {e}");
            Err(e)
        }
    }
}

/// Delete imported icon files that no configured rule references anymore.
/// `keep` carries the stored names still in use (the frontend derives it from
/// the saved rules' `custom:` icon ids).
#[tauri::command]
pub fn prune_command_icons(app: tauri::AppHandle, keep: Vec<String>) -> Result<(), String> {
    let dir = icon_dir(&app)?;
    match prune_icons(&dir, &keep) {
        Ok(removed) => {
            if !removed.is_empty() {
                log::info!("Pruned {} unused command icon(s)", removed.len());
            }
            Ok(())
        }
        Err(e) => {
            log::warn!("Command icon prune failed: {e}");
            Err(e)
        }
    }
}

/// List the stored (imported) icon file names for the settings picker.
#[tauri::command]
pub fn list_command_icons(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = icon_dir(&app)?;
    match list_icons(&dir) {
        Ok(names) => Ok(names),
        Err(e) => {
            log::warn!("Failed to list command icons: {e}");
            Err(e)
        }
    }
}

/// Resolve `<app data dir>/command-icons`, creating it on first use.
fn icon_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(base.join(COMMAND_ICONS_DIR))
}
