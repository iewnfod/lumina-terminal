//! Filesystem helpers (`src/utils.rs`) exercised over real temp files:
//! `path_exist` and `read_file`'s missing-file degradation (empty string, no
//! panic — it's called speculatively for theme probing).

use lumina_terminal_lib::utils::{path_exist, read_file};

#[test]
fn path_exist_tracks_real_files() {
    let path = std::env::temp_dir().join(format!("lumina-utils-{}.txt", std::process::id()));
    std::fs::write(&path, b"x").expect("write temp file");

    assert!(path_exist(path.to_string_lossy().to_string()));
    assert!(!path_exist(
        path.with_extension("definitely-missing").to_string_lossy().to_string()
    ));
}

#[test]
fn read_file_roundtrips_content() {
    let path = std::env::temp_dir().join(format!("lumina-utils-read-{}.txt", std::process::id()));
    std::fs::write(&path, "你好 terminal").expect("write temp file");
    assert_eq!(read_file(path.to_string_lossy().to_string()), "你好 terminal");
}

#[test]
fn read_file_missing_file_returns_empty_not_panic() {
    let missing = std::env::temp_dir()
        .join(format!("lumina-utils-missing-{}", std::process::id()))
        .to_string_lossy()
        .to_string();
    assert_eq!(read_file(missing), "");
}
