//! Profile launcher generation (`src/launchers.rs`) exercised over real
//! temp dirs: the pure content builders (Exec escaping, plist, exec script,
//! icns/ico wrapping, PowerShell script) plus the dir-parameterized
//! generate/prune flows the `#[tauri::command]`s delegate to. All three
//! formats are file-shaped, so every platform's CI can drive them; only
//! the real PowerShell execution is Windows-only.

use lumina_terminal_lib::launchers::{
    bundle_id, desktop_entry_content, escape_desktop_exec_arg, icns_from_png, ico_from_png,
    launcher_cli_args, launcher_script_content, launcher_stem, plist_content, png_width,
    sanitize_file_name, shortcut_ps1, sync_launchers, AppIconResources, BUNDLE_ID_PREFIX,
    LauncherDirs, LauncherFormat, LauncherIcon, LauncherSpec,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// A PNG-shaped byte buffer: valid signature + IHDR carrying the given
/// width (all the launchers code parses), arbitrary tail. The generators
/// wrap PNG bytes verbatim, so no real encoder is needed.
fn fake_png(width: u32) -> Vec<u8> {
    let mut png = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
    png.extend_from_slice(&13u32.to_be_bytes());
    png.extend_from_slice(b"IHDR");
    png.extend_from_slice(&width.to_be_bytes());
    png.extend_from_slice(&width.to_be_bytes());
    png.extend_from_slice(&[8, 6, 0, 0, 0]);
    png.extend_from_slice(b"IDAT-tail");
    png
}

fn spec(profile: &str, title: &str) -> LauncherSpec {
    LauncherSpec {
        profile: profile.to_string(),
        title: title.to_string(),
        working_directory: None,
        sidebar: Some("hide".to_string()),
        icon: None,
    }
}

fn resources() -> AppIconResources {
    AppIconResources {
        png: Some(fake_png(256)),
        icns: Some(fake_png(512)),
    }
}

/// A full LauncherDirs rooted at a fresh temp dir with all five subdirs.
fn temp_dirs(label: &str) -> LauncherDirs {
    let root = std::env::temp_dir().join(format!(
        "lumina-launchers-{}-{label}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    for sub in [
        "applications",
        "applications-mac",
        "programs",
        "launcher-icons",
        "command-icons",
    ] {
        std::fs::create_dir_all(root.join(sub)).expect("create temp subdir");
    }
    LauncherDirs {
        applications: root.join("applications"),
        applications_mac: root.join("applications-mac"),
        programs: root.join("programs"),
        launcher_icons: root.join("launcher-icons"),
        command_icons: root.join("command-icons"),
    }
}

fn cleanup(dirs: &LauncherDirs) {
    if let Some(root) = dirs.launcher_icons.parent() {
        let _ = std::fs::remove_dir_all(root);
    }
}

fn file_names(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("read dir")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    names
}

// ---------------------------------------------------------------------------
// Pure content builders
// ---------------------------------------------------------------------------

#[test]
fn desktop_exec_arg_escapes_reserved_characters() {
    assert_eq!(escape_desktop_exec_arg("nvim"), "nvim");
    assert_eq!(escape_desktop_exec_arg("My Dir"), "\"My Dir\"");
    // % is the field-code escape everywhere, quoted or not.
    assert_eq!(escape_desktop_exec_arg("50%"), "50%%");
    assert_eq!(escape_desktop_exec_arg("a % b"), "\"a %% b\"");
    // Inside quotes: " ` $ \ gain a backslash.
    assert_eq!(escape_desktop_exec_arg("he\"llo"), "\"he\\\"llo\"");
    assert_eq!(escape_desktop_exec_arg("a$b`c"), "\"a\\$b\\`c\"");
    assert_eq!(escape_desktop_exec_arg("C:\\path"), "\"C:\\\\path\"");
}

#[test]
fn cli_args_assemble_the_full_flag_set() {
    let full = LauncherSpec {
        working_directory: Some("~/Documents/Git Hub".to_string()),
        ..spec("Neovim", "Nvim")
    };
    assert_eq!(
        launcher_cli_args(&full),
        vec![
            "--profile",
            "Neovim",
            "-T",
            "Nvim",
            "--working-directory",
            "~/Documents/Git Hub",
            "--sidebar",
            "hide",
        ]
    );

    // Empty title falls back to the profile name.
    let untitled = spec("Neovim", "  ");
    assert_eq!(launcher_cli_args(&untitled)[3], "Neovim");

    // Whitespace-only working directory and unknown sidebar values drop out.
    let trimmed = LauncherSpec {
        working_directory: Some("   ".to_string()),
        sidebar: Some("sometimes".to_string()),
        ..spec("Neovim", "Nvim")
    };
    assert_eq!(launcher_cli_args(&trimmed).len(), 4);
}

#[test]
fn desktop_entry_has_required_keys_and_quoted_exec() {
    let content = desktop_entry_content(
        "/opt/Lumina Terminal/lumina-terminal",
        &["--profile".to_string(), "Neovim".to_string()],
        "Nvim",
        Some("/home/u/.cache/icon.png"),
    );
    assert!(content.contains("[Desktop Entry]\n"));
    assert!(content.contains("Name=Nvim\n"));
    assert!(content.contains("Exec=\"/opt/Lumina Terminal/lumina-terminal\" --profile Neovim\n"));
    assert!(content.contains("Icon=/home/u/.cache/icon.png\n"));
    assert!(content.contains("Terminal=false\n"));

    let iconless = desktop_entry_content("lumina-terminal", &[], "Nvim", None);
    assert!(!iconless.contains("Icon="));
}

#[test]
fn shell_script_quotes_only_unsafe_tokens() {
    assert_eq!(launcher_script_content("/usr/bin/lumina", &["--profile".into(), "My Profile".into()]),
        "#!/bin/sh\nexec /usr/bin/lumina --profile 'My Profile'\n");
    // A single quote inside a value survives via the '\'' dance.
    assert!(launcher_script_content("/usr/bin/lumina", &["it's".into()])
        .contains("'it'\\''s'"));
}

#[test]
fn plist_carries_bundle_identity_and_escapes_values() {
    let plist = plist_content("lumina-neovim", &bundle_id("lumina-neovim"), "Nvim & <Friends>", Some("lumina-neovim.icns"));
    assert!(plist.contains("<string>com.iewnfod.lumina-terminal.launcher.lumina-neovim</string>"));
    assert!(plist.contains("<string>Nvim &amp; &lt;Friends&gt;</string>"));
    assert!(plist.contains("<string>lumina-neovim.icns</string>"));

    let iconless = plist_content("x", "id", "Name", None);
    assert!(!iconless.contains("CFBundleIconFile"));
}

#[test]
fn png_width_reads_ihdr_and_rejects_garbage() {
    assert_eq!(png_width(&fake_png(300)), Some(300));
    assert_eq!(png_width(b"not a png"), None);
    assert_eq!(png_width(&fake_png(300)[..12]), None);
}

#[test]
fn icns_wraps_png_with_big_endian_lengths() {
    let png = fake_png(256);
    let icns = icns_from_png(&png);
    assert_eq!(&icns[..4], b"icns");
    // Total file length (BE) then chunk header: ic08 for a 256px image.
    assert_eq!(u32::from_be_bytes(icns[4..8].try_into().unwrap()) as usize, icns.len());
    assert_eq!(&icns[8..12], b"ic08");
    assert_eq!(
        u32::from_be_bytes(icns[12..16].try_into().unwrap()) as usize,
        png.len() + 8
    );
    // The PNG itself is embedded verbatim after the 16-byte header.
    assert_eq!(&icns[16..], &png[..]);

    assert_eq!(&icns_from_png(&fake_png(128))[8..12], b"ic07");
    assert_eq!(&icns_from_png(&fake_png(512))[8..12], b"ic09");
    assert_eq!(&icns_from_png(&fake_png(1024))[8..12], b"ic10");
}

#[test]
fn ico_wraps_png_with_little_endian_header() {
    let png = fake_png(256);
    let ico = ico_from_png(&png);
    // ICONDIR: reserved 0, type 1 (icon), count 1.
    assert_eq!(&ico[..6], &[0, 0, 1, 0, 1, 0]);
    // 256px encodes as 0 in the width byte.
    assert_eq!(ico[6], 0);
    assert_eq!(
        u32::from_le_bytes(ico[14..18].try_into().unwrap()) as usize,
        png.len()
    );
    assert_eq!(u32::from_le_bytes(ico[18..22].try_into().unwrap()), 22);
    assert_eq!(&ico[22..], &png[..]);

    assert_eq!(ico_from_png(&fake_png(64))[6], 64);
}

#[test]
fn powershell_script_quotes_paths_and_joins_args() {
    let script = shortcut_ps1(
        r"C:\Menu\Nvim's.lnk",
        r"C:\Program Files\Lumina\lumina.exe",
        &["--profile".to_string(), "Neovim".to_string()],
        Some(r"C:\Users\u\Docs"),
        Some(r"C:\icons\a.ico,0"),
    );
    assert!(script.starts_with("$ErrorActionPreference='Stop';"));
    // Single quotes inside values double.
    assert!(script.contains("'C:\\Menu\\Nvim''s.lnk'"));
    assert!(script.contains("'--profile Neovim'"));
    assert!(script.contains("$s.WorkingDirectory='C:\\Users\\u\\Docs'"));
    assert!(script.contains("$s.IconLocation='C:\\icons\\a.ico,0'"));
    assert!(script.ends_with("$s.Save()"));

    let minimal = shortcut_ps1("/tmp/a.lnk", "lumina", &[], None, None);
    assert!(!minimal.contains("WorkingDirectory"));
    assert!(!minimal.contains("IconLocation"));
}

#[test]
fn stems_and_file_names_are_safe() {
    assert_eq!(launcher_stem("Neovim"), "lumina-neovim");
    // CJK collapses to the sanitizer's fallback stem.
    assert_eq!(launcher_stem("终端"), "lumina-icon");
    assert_eq!(bundle_id("lumina-neovim"), "com.iewnfod.lumina-terminal.launcher.lumina-neovim");

    assert_eq!(sanitize_file_name("My App"), "My App");
    assert_eq!(sanitize_file_name("a/b\\c:d*e?f\"g<h>i|j"), "a-b-c-d-e-f-g-h-i-j");
    assert_eq!(sanitize_file_name("..."), "launcher");
    assert_eq!(sanitize_file_name("  终端  "), "终端");
}

// ---------------------------------------------------------------------------
// Sync flows over temp dirs
// ---------------------------------------------------------------------------

#[test]
fn desktop_sync_writes_entry_and_icon_then_prunes() {
    let dirs = temp_dirs("desktop");
    let specs = vec![LauncherSpec {
        icon: Some(LauncherIcon {
            svg: Some("<svg>nvim</svg>".to_string()),
            ..Default::default()
        }),
        ..spec("Neovim", "Nvim")
    }];

    let report = sync_launchers(&dirs, &specs, &resources(), "/usr/bin/lumina-terminal", LauncherFormat::DesktopEntry)
        .expect("first sync ok");
    let entry = dirs.applications.join("lumina-neovim.desktop");
    assert!(entry.is_file(), "entry written");
    let content = std::fs::read_to_string(&entry).unwrap();
    assert!(content.contains("Name=Nvim"));
    assert!(content.contains("--profile Neovim"));
    // The SVG landed in the icon cache and is referenced by absolute path.
    let icons = file_names(&dirs.launcher_icons);
    assert_eq!(icons.len(), 1, "one cached icon: {icons:?}");
    assert!(icons[0].starts_with("icon-") && icons[0].ends_with(".svg"));
    assert!(content.contains(&format!("Icon={}", dirs.launcher_icons.join(&icons[0]).display())));

    assert_eq!(report.created.len(), 1);

    // A foreign entry (no lumina- prefix) must never be pruned.
    std::fs::write(dirs.applications.join("other-app.desktop"), b"[Desktop Entry]\n").unwrap();

    // Re-sync with the spec gone: our entry + icon are pruned, foreign kept.
    let report = sync_launchers(&dirs, &[], &resources(), "/usr/bin/lumina-terminal", LauncherFormat::DesktopEntry)
        .expect("second sync ok");
    assert!(!entry.exists(), "orphan entry pruned");
    assert!(file_names(&dirs.launcher_icons).is_empty(), "cached icon pruned");
    assert!(dirs.applications.join("other-app.desktop").exists(), "foreign entry kept");
    assert_eq!(report.created.len(), 0);
    assert!(report.removed.iter().any(|r| r.contains("lumina-neovim.desktop")));

    cleanup(&dirs);
}

#[test]
fn desktop_sync_defaults_to_bundled_icon_and_is_idempotent() {
    let dirs = temp_dirs("default-icon");
    let specs = vec![spec("Neovim", "")];

    for _ in 0..2 {
        sync_launchers(&dirs, &specs, &resources(), "/usr/bin/lumina-terminal", LauncherFormat::DesktopEntry)
            .expect("sync ok");
    }
    let content = std::fs::read_to_string(dirs.applications.join("lumina-neovim.desktop")).unwrap();
    // No explicit icon → the bundled app png is cached and referenced.
    assert!(content.contains("Name=Neovim"), "empty title falls back to the profile name");
    let icons = file_names(&dirs.launcher_icons);
    assert_eq!(icons.len(), 1);
    assert!(icons[0].ends_with(".png"));
    assert!(content.contains("Icon="));

    // No bundled resource either → still a valid entry, just iconless.
    let dirs2 = temp_dirs("no-resources");
    sync_launchers(&dirs2, &specs, &AppIconResources { png: None, icns: None }, "lumina-terminal", LauncherFormat::DesktopEntry)
        .expect("iconless sync ok");
    let bare = std::fs::read_to_string(dirs2.applications.join("lumina-neovim.desktop")).unwrap();
    assert!(!bare.contains("Icon="));
    cleanup(&dirs2);
    cleanup(&dirs);
}

#[test]
fn command_icon_file_resolves_and_traversal_is_rejected() {
    let dirs = temp_dirs("custom-icon");
    // A user-imported png inside the command-icons dir.
    let stored = dirs.command_icons.join("my-tool-0000000000000000.png");
    std::fs::write(&stored, fake_png(128)).unwrap();

    let specs = vec![LauncherSpec {
        icon: Some(LauncherIcon {
            command_icon_file: Some("my-tool-0000000000000000.png".to_string()),
            ..Default::default()
        }),
        ..spec("Local", "Local")
    }];
    sync_launchers(&dirs, &specs, &resources(), "lumina-terminal", LauncherFormat::DesktopEntry)
        .expect("sync ok");
    let content = std::fs::read_to_string(dirs.applications.join("lumina-local.desktop")).unwrap();
    assert!(content.contains("Icon="));

    // A traversal-shaped name is rejected (warn + app-icon fallback), and
    // nothing is ever read outside the command-icons dir.
    let evil = vec![LauncherSpec {
        icon: Some(LauncherIcon {
            command_icon_file: Some("../../etc/passwd.png".to_string()),
            ..Default::default()
        }),
        ..spec("Evil", "Evil")
    }];
    let report = sync_launchers(&dirs, &evil, &resources(), "lumina-terminal", LauncherFormat::DesktopEntry)
        .expect("sync still succeeds with the fallback icon");
    assert_eq!(report.created.len(), 1);
    assert!(dirs.applications.join("lumina-evil.desktop").is_file());

    // Two payloads at once is a contract error → same graceful fallback.
    let both = vec![LauncherSpec {
        icon: Some(LauncherIcon {
            svg: Some("<svg/>".to_string()),
            png_base64: Some("aGVsbG8=".to_string()),
            ..Default::default()
        }),
        ..spec("Both", "Both")
    }];
    sync_launchers(&dirs, &both, &resources(), "lumina-terminal", LauncherFormat::DesktopEntry)
        .expect("dual payload falls back to the app icon");
    assert!(dirs.applications.join("lumina-both.desktop").is_file());

    cleanup(&dirs);
}

#[test]
fn app_bundle_sync_builds_bundle_and_prunes_only_ours() {
    let dirs = temp_dirs("bundle");
    let specs = vec![LauncherSpec {
        icon: Some(LauncherIcon {
            png_base64: Some({
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode(fake_png(256))
            }),
            ..Default::default()
        }),
        ..spec("Neovim", "Nvim")
    }];

    sync_launchers(&dirs, &specs, &resources(), "/Applications/Lumina Terminal.app/Contents/MacOS/lumina-terminal", LauncherFormat::AppBundle)
        .expect("bundle sync ok");

    let bundle = dirs.applications_mac.join("Nvim.app");
    let plist = std::fs::read_to_string(bundle.join("Contents").join("Info.plist")).unwrap();
    assert!(plist.contains(BUNDLE_ID_PREFIX));
    assert!(plist.contains("<string>lumina-neovim</string>"));
    let script = std::fs::read_to_string(bundle.join("Contents").join("MacOS").join("lumina-neovim")).unwrap();
    assert!(script.contains("exec '/Applications/Lumina Terminal.app/Contents/MacOS/lumina-terminal' --profile Neovim -T Nvim --sidebar hide"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(bundle.join("Contents").join("MacOS").join("lumina-neovim"))
            .unwrap()
            .permissions()
            .mode();
        assert!(mode & 0o111 != 0, "script is executable (mode {mode:o})");
    }
    // The PNG icon was wrapped into an icns inside Resources.
    let icns = std::fs::read(bundle.join("Contents").join("Resources").join("lumina-neovim.icns")).unwrap();
    assert_eq!(&icns[..4], b"icns");

    // A foreign app bundle (no Info.plist marker) must survive a prune pass;
    // ours (specs now empty) must go.
    let foreign = dirs.applications_mac.join("Real App.app");
    std::fs::create_dir_all(foreign.join("Contents")).unwrap();
    std::fs::write(foreign.join("Contents").join("Info.plist"), "<plist/>").unwrap();
    let report = sync_launchers(&dirs, &[], &resources(), "/Applications/x", LauncherFormat::AppBundle)
        .expect("prune sync ok");
    assert!(!bundle.exists(), "our bundle pruned");
    assert!(foreign.exists(), "foreign bundle kept");
    assert_eq!(report.removed.len(), 1);
    cleanup(&dirs);
}

#[test]
fn shortcut_sync_writes_shortcut_and_ico_then_prunes() {
    let dirs = temp_dirs("shortcut");
    let specs = vec![LauncherSpec {
        icon: Some(LauncherIcon {
            png_base64: Some({
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode(fake_png(64))
            }),
            ..Default::default()
        }),
        ..spec("Neovim", "Nvim")
    }];

    let report = sync_launchers(&dirs, &specs, &resources(), r"C:\Program Files\Lumina\lumina.exe", LauncherFormat::Shortcut)
        .expect("shortcut sync ok");
    // On Windows this ran through PowerShell for real; elsewhere the script
    // text lands in the file (see write_shortcut_file). Either way the
    // footprint — .lnk + cached .ico — is identical.
    let lnk = dirs.programs.join("Nvim.lnk");
    assert!(lnk.is_file(), "shortcut written: {report:?}");
    assert!(lnk.metadata().unwrap().len() > 0);
    let icos = file_names(&dirs.programs);
    assert_eq!(icos.len(), 2, "shortcut + ico: {icos:?}");
    assert!(icos.iter().any(|n| n.ends_with(".ico")));
    // The ico header is well-formed regardless of host platform.
    let ico_path = dirs.programs.join(icos.iter().find(|n| n.ends_with(".ico")).unwrap());
    assert_eq!(&std::fs::read(ico_path).unwrap()[..4], &[0, 0, 1, 0]);

    // Stray shortcut/ico files are pruned; a foreign file is kept.
    std::fs::write(dirs.programs.join("stray.lnk"), b"x").unwrap();
    std::fs::write(dirs.programs.join("readme.txt"), b"keep me").unwrap();
    sync_launchers(&dirs, &[], &resources(), r"C:\Program Files\Lumina\lumina.exe", LauncherFormat::Shortcut)
        .expect("prune sync ok");
    assert!(!lnk.exists(), "shortcut pruned");
    assert!(dirs.programs.join("readme.txt").exists(), "foreign file kept");
    assert!(file_names(&dirs.programs) == vec!["readme.txt"]);
    cleanup(&dirs);
}

#[test]
fn sync_skips_empty_profile_specs() {
    let dirs = temp_dirs("empty-spec");
    let specs = vec![spec("", "Nope")];
    let report = sync_launchers(&dirs, &specs, &resources(), "lumina-terminal", LauncherFormat::DesktopEntry)
        .expect("sync ok");
    assert!(report.created.is_empty());
    assert!(file_names(&dirs.applications).is_empty());
    cleanup(&dirs);
}
