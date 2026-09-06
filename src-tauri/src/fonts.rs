//! System font discovery for ligature support.
//!
//! The frontend's ligature feature needs the raw binary of the font file
//! (`.ttf`/`.otf`) so it can parse the OpenType GSUB table client-side (via
//! `opentype.js`). In a browser-only environment there's no way to read a
//! system font file; this command bridges that gap by using `font-kit` to
//! resolve a CSS `font-family` string to an actual file on disk.
//!
//! Cross-platform: `font-kit` delegates to fontconfig (Linux), Core Text
//! (macOS), and DirectWrite (Windows), so family-name → file-path resolution
//! matches what the OS itself does.

use font_kit::family_name::FamilyName;
use font_kit::handle::Handle;
use font_kit::properties::Properties;
use font_kit::source::SystemSource;
use tauri::ipc::Response;

/// CSS generic font families that the browser resolves itself — we can't map
/// these to a specific file, and neither can the frontend's ligature parser.
/// Matches the list in xterm.js addon-ligatures `parse.ts`.
const GENERIC_FAMILIES: &[&str] = &[
    "serif",
    "sans-serif",
    "cursive",
    "fantasy",
    "monospace",
    "system-ui",
    "emoji",
    "math",
    "fangsong",
];

/// Parse a CSS `font-family` string (e.g. `"Fira Code, monospace"`) and return
/// the first concrete (non-generic) family name, trimmed of quotes/whitespace.
/// Returns `None` if the string is empty or only contains generic families.
/// Pure — `pub` so the integration tests can drive it directly.
pub fn first_concrete_family(css_family: &str) -> Option<String> {
    for part in css_family.split(',') {
        let trimmed = part.trim().trim_matches(|c| c == '"' || c == '\'');
        if trimmed.is_empty() {
            continue;
        }
        if !GENERIC_FAMILIES.contains(&trimmed.to_lowercase().as_str()) {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Find a system font file by CSS family name and return its binary contents.
///
/// Resolves the family name (e.g. `"Fira Code, monospace"`) to an actual
/// `.ttf`/`.otf` file on disk via the OS font subsystem, then reads and
/// returns the raw bytes. The frontend passes these to `font-ligatures`'
/// `loadBuffer()` to parse the GSUB table for ligature rules.
///
/// **Raw IPC payload**: the bytes are returned as a `tauri::ipc::Response`
/// (delivered to the webview as an `ArrayBuffer`), NOT as a `Vec<u8>` return
/// value. The default `Vec<u8>` JSON serialization expands every byte into a
/// number — a 20 MB CJK family (e.g. Maple Mono NF CN) becomes ~70 MB of JSON
/// and a 20M-element JS array in the webview, which stalled startup on the
/// exact moment the window appears. Raw transfer keeps the payload at the
/// font's actual size.
///
/// **Async + spawn_blocking**: `font-kit`'s `select_best_match` queries the OS
/// font database (fontconfig on Linux, Core Text on macOS, DirectWrite on
/// Windows), which can take tens of ms on first call (font cache warm-up) and
/// must NOT block Tauri's main thread (which stalls terminal startup). The
/// entire lookup + file read runs on a blocking thread pool.
///
/// Returns an error if the font can't be found or the file can't be read.
#[tauri::command]
pub async fn find_font(family: String) -> Result<Response, String> {
    // Parse the CSS family string on the async thread (cheap, no I/O).
    let concrete = first_concrete_family(&family).ok_or_else(|| {
        log::warn!("find_font: no concrete family in \"{}\" (only generic)", family);
        format!("No concrete font family in \"{}\"", family)
    })?;

    // Move the blocking font-system query + file read off the main thread.
    // font-kit's select_best_match can be slow (fontconfig scan, DirectWrite
    // init) and would freeze terminal startup if run inline.
    tauri::async_runtime::spawn_blocking(move || {
        let source = SystemSource::new();
        let handle = source
            .select_best_match(&[FamilyName::Title(concrete.clone())], &Properties::default())
            .map_err(|e| {
                log::warn!("find_font: font \"{}\" not found: {}", concrete, e);
                format!("Font \"{}\" not found", concrete)
            })?;

        let path = match handle {
            Handle::Path { path, .. } => path,
            // Memory-backed fonts have no file path; we can't get raw bytes this way.
            Handle::Memory { .. } => {
                log::warn!("find_font: font \"{}\" is memory-backed, no file path", concrete);
                return Err(format!("Font \"{}\" has no file path", concrete));
            }
        };

        log::debug!("find_font: \"{}\" → {}", concrete, path.display());

        std::fs::read(&path).map_err(|e| {
            log::warn!("find_font: failed to read {}: {}", path.display(), e);
            e.to_string()
        })
    })
    .await
    .map_err(|e| {
        log::error!("find_font: blocking task panicked: {}", e);
        e.to_string()
    })?
    .map(Response::new)
}
