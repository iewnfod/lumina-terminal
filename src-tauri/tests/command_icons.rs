//! Command icon storage (`src/command_icons.rs`) exercised over real temp
//! dirs: the pure name/validation helpers plus the import/prune file flows
//! the two `#[tauri::command]`s delegate to.

use lumina_terminal_lib::command_icons::{
    ext_of, import_icon_into, is_allowed_ext, list_icons, prune_icons, sanitize_stem,
};

/// Unique temp dir per test (process id + label) so parallel tests don't
/// collide, cleaned up best-effort at the end.
fn temp_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "lumina-command-icons-{}-{label}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn write_source(dir: &std::path::Path, name: &str, bytes: &[u8]) -> String {
    let path = dir.join(name);
    std::fs::write(&path, bytes).expect("write source file");
    path.to_string_lossy().to_string()
}

#[test]
fn ext_of_handles_both_separators_and_case() {
    assert_eq!(ext_of("/home/u/pics/Logo.PNG"), ".png");
    assert_eq!(ext_of("C:\\Users\\u\\icon.svg"), ".svg");
    assert_eq!(ext_of("no-extension"), "");
    assert_eq!(ext_of("/dir.d/file"), "");
}

#[test]
fn is_allowed_ext_accepts_only_svg_and_png() {
    assert!(is_allowed_ext(".svg"));
    assert!(is_allowed_ext(".png"));
    assert!(!is_allowed_ext(".jpg"));
    assert!(!is_allowed_ext(".svgx"));
    assert!(!is_allowed_ext(""));
}

#[test]
fn sanitize_stem_collapses_to_safe_fragments() {
    assert_eq!(sanitize_stem("NeoVim"), "neovim");
    assert_eq!(sanitize_stem("my tool.exe"), "my-tool-exe");
    assert_eq!(sanitize_stem("--..--"), "icon"); // nothing survives → fallback
    assert_eq!(sanitize_stem("工具"), "icon"); // CJK-only → fallback
    let long = "a".repeat(80);
    assert_eq!(sanitize_stem(&long).len(), 32); // capped
}

#[test]
fn import_rejects_wrong_extension_and_size() {
    let dir = temp_dir("reject");

    let jpg = write_source(&dir, "photo.jpg", b"x");
    let err = import_icon_into(&dir, &jpg).unwrap_err();
    assert!(err.contains("Unsupported"), "got: {err}");

    // Exactly at the cap passes, one byte over is rejected.
    let at_cap = write_source(&dir, "cap.svg", &vec![b'<'; 1024 * 1024]);
    assert!(import_icon_into(&dir, &at_cap).is_ok());
    let over = write_source(&dir, "over.svg", &vec![b'<'; 1024 * 1024 + 1]);
    let err = import_icon_into(&dir, &over).unwrap_err();
    assert!(err.contains("too large"), "got: {err}");

    let missing = dir.join("ghost.svg").to_string_lossy().to_string();
    let err = import_icon_into(&dir, &missing).unwrap_err();
    assert!(err.contains("does not exist"), "got: {err}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn import_stores_hash_suffixed_name_and_is_idempotent() {
    let dir = temp_dir("import");

    let src = write_source(&dir, "My Tool.svg", b"<svg>lumina</svg>");
    let name = import_icon_into(&dir, &src).expect("import ok");
    assert!(name.starts_with("my-tool-"), "got: {name}");
    assert!(name.ends_with(".svg"));

    // Stored file exists with identical content, and re-importing the same
    // bytes yields the same name (content hash dedup).
    let stored = dir.join(&name);
    assert_eq!(std::fs::read(&stored).unwrap(), b"<svg>lumina</svg>");
    let again = import_icon_into(&dir, &src).expect("re-import ok");
    assert_eq!(name, again);

    // Different content with the same stem gets a different stored name.
    let other = write_source(&dir, "My Tool.svg", b"<svg>different</svg>");
    let other_name = import_icon_into(&dir, &other).expect("import other ok");
    assert_ne!(name, other_name);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn list_icons_returns_sorted_files_only() {
    let src_dir = temp_dir("list-src");
    let dir = temp_dir("list");

    assert!(list_icons(&dir).unwrap().is_empty()); // missing dir → empty list

    for (stem, bytes) in [("b.svg", b"2"), ("a.svg", b"1"), ("c.png", b"3")] {
        let src = write_source(&src_dir, stem, bytes);
        import_icon_into(&dir, &src).expect("import");
    }
    // Subdirectories are not listed.
    std::fs::create_dir_all(dir.join("nested")).expect("mkdir");

    let names = list_icons(&dir).expect("list");
    assert_eq!(names.len(), 3);
    assert!(names.windows(2).all(|w| w[0] < w[1]), "sorted: {names:?}");

    let _ = std::fs::remove_dir_all(&src_dir);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn prune_removes_unreferenced_files_only() {
    let src_dir = temp_dir("prune-src");
    let dir = temp_dir("prune");

    let mut imported = Vec::new();
    for (stem, bytes) in [("a.svg", b"1"), ("b.svg", b"2"), ("c.png", b"3")] {
        let src = write_source(&src_dir, stem, bytes);
        imported.push(import_icon_into(&dir, &src).expect("import"));
    }
    assert_eq!(imported.len(), 3);

    // A subdirectory must survive pruning (only files this module wrote are
    // candidates for deletion).
    let sub = dir.join("nested");
    std::fs::create_dir_all(&sub).expect("mkdir");
    std::fs::write(sub.join("keep-dir.txt"), b"x").expect("write in subdir");

    let removed = prune_icons(&dir, &imported[..2]).expect("prune");
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0], imported[2]);
    assert!(dir.join(&imported[0]).is_file());
    assert!(dir.join(&imported[1]).is_file());
    assert!(!dir.join(&imported[2]).is_file());
    assert!(sub.join("keep-dir.txt").is_file());

    // Pruning a missing directory is a no-op, not an error.
    assert!(prune_icons(&dir.join("ghost"), &[]).unwrap().is_empty());

    let _ = std::fs::remove_dir_all(&src_dir);
    let _ = std::fs::remove_dir_all(&dir);
}
