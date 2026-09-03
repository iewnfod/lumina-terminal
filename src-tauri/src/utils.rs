/// Tiny filesystem helpers exposed to the frontend. Kept as their own module
/// since they are general-purpose (not SSH / shell / system / update specific).
/// Larger concerns each have their own module — see `ssh`, `shells`, `system`,
/// `install_source`, `file_manager`. Also home to the shared fs idioms
/// (content-hash naming, atomic writes, prune loops) that
/// `command_icons` / `launchers` / `proxy` previously each hand-rolled.

use std::hash::{Hash, Hasher};
use std::path::Path;

#[tauri::command]
pub fn path_exist(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
pub fn read_file(path: String) -> String {
    match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            // Often called speculatively (theme probing), so debug-level.
            log::debug!("read_file failed for {}: {}", path, e);
            String::new()
        }
    }
}

/// 16-hex-digit content hash for content-addressed file names: identical
/// payloads collide on the same storage name, so re-importing/re-generating
/// the same icon reuses the file and pruning stays natural. NOT
/// cryptographic — dedupe is the only goal. (Previously duplicated in
/// command_icons and launchers with drifting formats.)
pub fn content_hash_hex(bytes: &[u8]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Write via tmp+rename so readers never see a half-written file (a torn
/// .desktop entry or proxy env-file). POSIX rename overwrites atomically;
/// Windows' does not, so drop the target first — the gap is harmless for our
/// readers (hooks/pickers treat a missing file as "keep current state").
/// Creates parent directories as needed.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    #[cfg(windows)]
    let _ = std::fs::remove_file(path);
    std::fs::rename(&tmp, path)
}

/// Delete plain files directly inside `dir` whose name is not in `keep`;
/// returns the removed file names. A missing `dir` is a no-op (nothing stored
/// yet). Subdirectories are left alone — only files this app wrote are
/// candidates. Errors listing the dir fail with a message mentioning `what`;
/// individual remove failures are logged (warn) and skipped — prune is
/// best-effort. Shared by the command-icons and launcher-icon caches.
pub fn prune_files_not_in(dir: &Path, keep: &[String], what: &str) -> Result<Vec<String>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut removed = Vec::new();
    for entry in std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to list {what} directory {}: {e}", dir.display()))?
        .flatten()
    {
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
            Err(e) => log::warn!("Failed to prune unused {what} {}: {e}", path.display()),
        }
    }
    Ok(removed)
}
