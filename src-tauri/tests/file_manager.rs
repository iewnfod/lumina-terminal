//! `open_in_file_manager` guard (`src/file_manager.rs`): a nonexistent path
//! must be rejected before any OS file manager is spawned — the only
//! headless-safe path through the command.

use lumina_terminal_lib::file_manager::open_in_file_manager;

#[test]
fn nonexistent_path_is_rejected_without_spawning() {
    let missing = std::env::temp_dir()
        .join(format!("lumina-file-manager-missing-{}", std::process::id()))
        .to_string_lossy()
        .to_string();
    let err = open_in_file_manager(missing).expect_err("missing path must error");
    assert!(err.contains("does not exist"), "unexpected error: {err}");
}
