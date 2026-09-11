/// Open a path in the platform's file manager.
///
/// - If the path is a **file**, its **parent directory** is opened (and the
///   file is selected where supported).
/// - If the path is a **directory**, the directory itself is opened.
///
/// This bypasses `plugin-opener` (whose `openPath` is unreliable on Linux for
/// directories and unregistered file types) by calling the OS file manager
/// directly.
#[tauri::command]
pub fn open_in_file_manager(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    // Determine what to open: the directory itself, or the parent (if it's a file).
    let (dir, file_name) = if p.is_dir() {
        (p.to_path_buf(), None)
    } else {
        (
            p.parent().unwrap_or(p).to_path_buf(),
            p.file_name().map(|n| n.to_string_lossy().to_string()),
        )
    };

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        // xdg-open opens the directory in the default file manager. For files,
        // we already resolved to the parent directory above so the user lands
        // in the right folder. (File selection isn't broadly supported via
        // xdg-open, so we just open the containing directory.)
        let _ = file_name;
        match Command::new("xdg-open").arg(&dir).status() {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => {
                // xdg-open returned a non-zero exit code (e.g. no default app,
                // missing desktop file). Report it rather than hiding as success.
                let msg = format!("xdg-open exited with {}", status);
                log::warn!("{}", msg);
                Err(msg)
            }
            Err(e) => {
                let msg = format!("Failed to open: {}", e);
                log::warn!("{}", msg);
                Err(msg)
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let result = if let Some(ref name) = file_name {
            // `open -R <file>` reveals the file in Finder
            Command::new("open").args(["-R", &path]).status().map(|_| ())
        } else {
            Command::new("open").arg(&dir).status().map(|_| ())
        };
        match result {
            Ok(()) => Ok(()),
            Err(e) => {
                let msg = format!("Failed to open: {}", e);
                log::warn!("{}", msg);
                Err(msg)
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let result = if let Some(ref _name) = file_name {
            // `explorer /select,<path>` selects the file in Explorer
            Command::new("explorer")
                .args(["/select,", &path.replace('/', "\\")])
                .status()
                .map(|_| ())
        } else {
            Command::new("explorer").arg(&dir).status().map(|_| ())
        };
        match result {
            Ok(()) => Ok(()),
            Err(e) => {
                let msg = format!("Failed to open: {}", e);
                log::warn!("{}", msg);
                Err(msg)
            }
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (dir, file_name);
        Err("Unsupported platform".to_string())
    }
}
