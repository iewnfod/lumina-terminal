//! CSS font-family extraction (`src/fonts.rs::first_concrete_family`): the
//! first non-generic family name for the ligature font bridge, with quote
//! stripping and generic-family (case-insensitive) skipping.

use lumina_terminal_lib::fonts::first_concrete_family;

#[test]
fn picks_first_concrete_family() {
    assert_eq!(first_concrete_family("Fira Code, monospace").as_deref(), Some("Fira Code"));
    assert_eq!(first_concrete_family("JetBrains Mono").as_deref(), Some("JetBrains Mono"));
}

#[test]
fn strips_single_and_double_quotes() {
    assert_eq!(
        first_concrete_family("\"JetBrains Mono\", serif").as_deref(),
        Some("JetBrains Mono")
    );
    assert_eq!(
        first_concrete_family("'Cascadia Code', monospace").as_deref(),
        Some("Cascadia Code")
    );
}

#[test]
fn trims_surrounding_whitespace() {
    assert_eq!(first_concrete_family("  Fira Code  , monospace").as_deref(), Some("Fira Code"));
}

#[test]
fn generic_only_families_yield_none() {
    assert_eq!(first_concrete_family("monospace"), None);
    assert_eq!(first_concrete_family("serif, sans-serif"), None);
    assert_eq!(first_concrete_family("system-ui"), None);
    // Generic matching is case-insensitive.
    assert_eq!(first_concrete_family("Monospace"), None);
    assert_eq!(first_concrete_family("SANS-SERIF"), None);
}

#[test]
fn empty_or_separator_only_input_yields_none() {
    assert_eq!(first_concrete_family(""), None);
    assert_eq!(first_concrete_family(" , , "), None);
}
