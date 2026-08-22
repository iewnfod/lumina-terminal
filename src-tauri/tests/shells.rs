//! PATH-scan shell discovery (`src/shells.rs::scan_path_for`) against
//! controlled temp directories: hits across dirs, dedup on repeated dirs,
//! misses for absent names / nonexistent dirs. The fn is parameterized (no env
//! reads) precisely so these tests never mutate PATH.

use lumina_terminal_lib::shells::scan_path_for;

/// Host-platform PATH separator. Tests joining real temp paths must use it:
/// Windows paths carry a drive-letter colon (`C:\...`), so splitting on `:`
/// there would shred the directories instead of listing them.
#[cfg(windows)]
const SEP: char = ';';
#[cfg(not(windows))]
const SEP: char = ':';

/// A temp dir unique to this test process, holding fake shell "binaries"
/// (regular files — the scan only checks `is_file`).
fn temp_shell_dir(tag: &str, names: &[&str]) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("lumina-shells-{}-{}", tag, std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    for name in names {
        std::fs::write(dir.join(name), b"#!/bin/sh\n").expect("write fake shell");
    }
    dir
}

#[test]
fn discovers_candidates_across_dirs() {
    let a = temp_shell_dir("multi-a", &["bash", "zsh"]);
    let b = temp_shell_dir("multi-b", &["fish"]);
    let path_value = format!("{}{SEP}{}", a.display(), b.display());

    let mut found = Vec::new();
    scan_path_for(&path_value, SEP, &["bash", "zsh", "fish", "nu"], &mut found);

    assert!(found.contains(&a.join("bash").to_string_lossy().to_string()));
    assert!(found.contains(&a.join("zsh").to_string_lossy().to_string()));
    assert!(found.contains(&b.join("fish").to_string_lossy().to_string()));
    // "nu" exists in neither dir — exactly 3 hits.
    assert_eq!(found.len(), 3);
}

#[test]
fn repeated_dirs_are_deduped() {
    let a = temp_shell_dir("dedup", &["bash"]);
    let path_value = format!("{}{SEP}{}", a.display(), a.display());

    let mut found = Vec::new();
    scan_path_for(&path_value, SEP, &["bash"], &mut found);
    assert_eq!(found.len(), 1);
}

#[test]
fn same_name_in_different_dirs_yields_both() {
    // Two different bash installs are different shells — both stay.
    let a = temp_shell_dir("two-a", &["bash"]);
    let b = temp_shell_dir("two-b", &["bash"]);
    let path_value = format!("{}{SEP}{}", a.display(), b.display());

    let mut found = Vec::new();
    scan_path_for(&path_value, SEP, &["bash"], &mut found);
    assert_eq!(found.len(), 2);
}

#[test]
fn nonexistent_dirs_and_absent_names_yield_nothing() {
    let mut found = Vec::new();
    scan_path_for("/nonexistent-lumina-test-dir", ':', &["bash"], &mut found);
    assert!(found.is_empty());

    let a = temp_shell_dir("miss", &["zsh"]);
    scan_path_for(&a.to_string_lossy(), SEP, &["bash"], &mut found);
    assert!(found.is_empty());
}

#[test]
fn custom_separator_is_honored() {
    // The Windows branch feeds ';' — the fn itself is separator-agnostic.
    let a = temp_shell_dir("sep-a", &["bash"]);
    let b = temp_shell_dir("sep-b", &["zsh"]);
    let path_value = format!("{};{}", a.display(), b.display());

    let mut found = Vec::new();
    scan_path_for(&path_value, ';', &["bash", "zsh"], &mut found);
    assert_eq!(found.len(), 2);
}
