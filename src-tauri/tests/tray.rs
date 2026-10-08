//! Pure surface of `src/tray.rs`: label sanitization for the frontend-
//! supplied (localized) tray menu labels. The tray itself needs a live
//! AppHandle — Tauri plumbing, exercised manually per the close-to-tray
//! checklist instead of here.

use lumina_terminal_lib::tray::sanitize_label;

#[test]
fn sanitize_label_keeps_real_labels_trimmed() {
    assert_eq!(sanitize_label("Show Lumina", "fallback"), "Show Lumina");
    assert_eq!(sanitize_label("  Quit  ", "fallback"), "Quit");
    // CJK labels must survive byte-for-byte (only surrounding space trims).
    assert_eq!(sanitize_label(" 显示 Lumina ", "fallback"), "显示 Lumina");
}

#[test]
fn sanitize_label_falls_back_on_empty_or_blank() {
    assert_eq!(sanitize_label("", "Show Lumina"), "Show Lumina");
    assert_eq!(sanitize_label("   ", "Show Lumina"), "Show Lumina");
    assert_eq!(sanitize_label("\t\n", "Quit"), "Quit");
    // The fallback itself is used verbatim.
    assert_eq!(sanitize_label("", "fallback"), "fallback");
}
