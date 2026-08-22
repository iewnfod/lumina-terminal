//! Package-manager output parsers (`src/install_source.rs`): the pacman/dpkg/
//! rpm stdout shapes captured from real runs, including the miss shapes that
//! must parse to `None`.

use lumina_terminal_lib::install_source::{
    dpkg_owner_package, pacman_owner_package, rpm_owner_package,
};

#[test]
fn pacman_owned_line_yields_package() {
    let stdout = "/usr/bin/lumina-terminal is owned by lumina-terminal-bin 0.1.6-1\n";
    assert_eq!(pacman_owner_package(stdout), Some("lumina-terminal-bin"));
}

#[test]
fn pacman_unowned_error_output_is_none() {
    assert_eq!(pacman_owner_package("error: No package owns /usr/bin/x\n"), None);
    assert_eq!(pacman_owner_package(""), None);
}

#[test]
fn dpkg_owned_line_yields_package() {
    let stdout = "lumina-terminal: /usr/bin/lumina-terminal\n";
    assert_eq!(dpkg_owner_package(stdout), Some("lumina-terminal"));
}

#[test]
fn dpkg_arch_qualified_package_keeps_name_only() {
    // Debian multiarch style: "pkg:amd64: path" — the name is before the
    // first colon.
    let stdout = "liblumina2:amd64: /usr/lib/x86_64-linux-gnu/liblumina.so\n";
    assert_eq!(dpkg_owner_package(stdout), Some("liblumina2"));
}

#[test]
fn dpkg_blank_output_is_none() {
    assert_eq!(dpkg_owner_package(""), None);
    assert_eq!(dpkg_owner_package("   \n"), None);
}

#[test]
fn rpm_owned_output_yields_package() {
    assert_eq!(rpm_owner_package("lumina-terminal"), Some("lumina-terminal"));
    assert_eq!(rpm_owner_package("lumina-terminal\n"), Some("lumina-terminal"));
}

#[test]
fn rpm_miss_shapes_are_none() {
    // rpm normally errors with non-zero status, but guard the message shapes
    // anyway in case a distro customizes exit codes.
    assert_eq!(rpm_owner_package("not installed"), None);
    assert_eq!(rpm_owner_package("not owned by any package"), None);
    assert_eq!(rpm_owner_package(""), None);
    assert_eq!(rpm_owner_package("  \n"), None);
}
