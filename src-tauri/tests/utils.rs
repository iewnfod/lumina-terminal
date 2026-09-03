//! Filesystem helpers (`src/utils.rs`) exercised over real temp files:
//! `path_exist` and `read_file`'s missing-file degradation (empty string, no
//! panic — it's called speculatively for theme probing), plus the shared fs
//! idioms (`content_hash_hex`, `write_atomic`, `prune_files_not_in`) that
//! command_icons / launchers / proxy build on.

use lumina_terminal_lib::utils::{content_hash_hex, path_exist, prune_files_not_in, read_file, write_atomic};

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

#[test]
fn content_hash_hex_is_stable_and_16_hex_digits() {
    assert_eq!(content_hash_hex(b"same bytes"), content_hash_hex(b"same bytes"));
    assert_ne!(content_hash_hex(b"same bytes"), content_hash_hex(b"other bytes"));
    for bytes in [b"".as_slice(), b"x".as_slice(), &[0u8; 64][..]] {
        let hash = content_hash_hex(bytes);
        assert_eq!(hash.len(), 16, "16 hex digits");
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()), "hex only: {hash}");
    }
}

#[test]
fn write_atomic_overwrites_creates_parents_and_leaves_no_tmp() {
    let dir = std::env::temp_dir().join(format!("lumina-utils-atomic-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let target = dir.join("nested").join("file.env");

    write_atomic(&target, b"first").expect("first write (creates parents)");
    assert_eq!(std::fs::read(&target).unwrap(), b"first");

    write_atomic(&target, b"second").expect("overwrite");
    assert_eq!(std::fs::read(&target).unwrap(), b"second");

    // The tmp sidecar must not linger next to the target.
    let siblings: Vec<_> = std::fs::read_dir(target.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(siblings, vec!["file.env".to_string()]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn prune_files_not_in_removes_unreferenced_and_keeps_referenced() {
    let dir = std::env::temp_dir().join(format!("lumina-utils-prune-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("keep.svg"), b"k").unwrap();
    std::fs::write(dir.join("drop.svg"), b"d").unwrap();
    std::fs::write(dir.join("drop.png"), b"d").unwrap();
    // Subdirectories must be left alone even when unreferenced.
    std::fs::create_dir_all(dir.join("subdir")).unwrap();

    let removed = prune_files_not_in(&dir, &["keep.svg".to_string()], "test icon").unwrap();
    assert_eq!(removed, vec!["drop.png".to_string(), "drop.svg".to_string()]);

    assert!(dir.join("keep.svg").is_file());
    assert!(!dir.join("drop.svg").exists());
    assert!(!dir.join("drop.png").exists());
    assert!(dir.join("subdir").is_dir());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn prune_files_not_in_missing_dir_is_noop() {
    let missing = std::env::temp_dir().join(format!("lumina-utils-prune-missing-{}", std::process::id()));
    assert_eq!(prune_files_not_in(&missing, &[], "test icon").unwrap(), Vec::<String>::new());
}
