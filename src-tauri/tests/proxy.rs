//! Integration tests for the system-proxy detection layer (`src/proxy.rs`):
//! per-source sample-output parsers, env-file rendering, the env fallback, and
//! a read-only end-to-end that chains the REAL machine's gsettings state
//! through detect → render → the real bash hook.

use lumina_terminal_lib::proxy::*;
use lumina_terminal_lib::shell_integration::proxy_hook_bash;

/// Real `gsettings list-recursively org.gnome.system.proxy` output captured
/// on a GNOME machine with a manual proxy at 127.0.0.1:7890.
const GSETTINGS_MANUAL: &str = "\
org.gnome.system.proxy autoconfig-url ''
org.gnome.system.proxy ignore-hosts ['localhost', '127.0.0.1', '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '::1']
org.gnome.system.proxy mode 'manual'
org.gnome.system.proxy use-same-proxy true
org.gnome.system.proxy.ftp host ''
org.gnome.system.proxy.ftp port 0
org.gnome.system.proxy.http authentication-password ''
org.gnome.system.proxy.http authentication-user ''
org.gnome.system.proxy.http enabled false
org.gnome.system.proxy.http host '127.0.0.1'
org.gnome.system.proxy.http port 7890
org.gnome.system.proxy.http use-authentication false
org.gnome.system.proxy.https host '127.0.0.1'
org.gnome.system.proxy.https port 7890
org.gnome.system.proxy.socks host '127.0.0.1'
org.gnome.system.proxy.socks port 7890
";

#[test]
fn gsettings_manual_mode_produces_full_snapshot() {
    let snap = parse_gsettings_dump(GSETTINGS_MANUAL);
    assert_eq!(snap.http.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(snap.https.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(snap.all.as_deref(), Some("socks5://127.0.0.1:7890"));
    assert!(snap.no_proxy.contains(&"192.168.0.0/16".to_string()));
    assert!(!snap.is_off());
}

#[test]
fn gsettings_none_mode_is_off() {
    let text = GSETTINGS_MANUAL.replace("'manual'", "'none'");
    let snap = parse_gsettings_dump(&text);
    assert!(snap.is_off());
}

#[test]
fn gsettings_pac_mode_is_off() {
    let text = GSETTINGS_MANUAL.replace("'manual'", "'auto'");
    let snap = parse_gsettings_dump(&text);
    assert!(snap.is_off());
}

#[test]
fn gsettings_empty_https_host_falls_back_to_http() {
    // https host empty + port 0 → https falls back to the http proxy;
    // socks host empty → all stays off.
    let text = "\
org.gnome.system.proxy mode 'manual'
org.gnome.system.proxy.http host '10.0.0.2'
org.gnome.system.proxy.http port 3128
org.gnome.system.proxy.https host ''
org.gnome.system.proxy.https port 0
org.gnome.system.proxy.socks host ''
org.gnome.system.proxy.socks port 0
";
    let snap = parse_gsettings_dump(text);
    assert_eq!(snap.http.as_deref(), Some("http://10.0.0.2:3128"));
    assert_eq!(snap.https.as_deref(), Some("http://10.0.0.2:3128"));
    assert_eq!(snap.all, None);
}

#[test]
fn kioslaverc_manual_with_schemes_normalizes_socks() {
    let text = "\
[Proxy Settings]
ProxyType=1
httpProxy=http://127.0.0.1:7890
httpsProxy=http://127.0.0.1:7890
socksProxy=socks://127.0.0.1:7891
NoProxyFor=localhost,127.0.0.1,.example.com
";
    let snap = parse_kioslaverc(text);
    assert_eq!(snap.http.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(snap.https.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(snap.all.as_deref(), Some("socks5://127.0.0.1:7891"));
    assert!(snap.no_proxy.contains(&".example.com".to_string()));
}

#[test]
fn kioslaverc_proxy_type_none_is_off() {
    let text = "[Proxy Settings]\nProxyType=0\nhttpProxy=http://127.0.0.1:7890\n";
    let snap = parse_kioslaverc(text);
    assert!(snap.is_off());
}

const SCUTIL_SAMPLE: &str = "\
<dictionary> {
  ExceptionsList : <array> {
    localhost
    127.0.0.1
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
}
";

#[test]
fn scutil_enabled_proxies_produce_snapshot() {
    let snap = parse_scutil_proxy(SCUTIL_SAMPLE);
    assert_eq!(snap.http.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(snap.https.as_deref(), Some("http://127.0.0.1:7890"));
    // SOCKSEnable : 0 → all must stay off despite SOCKSProxy being set.
    assert_eq!(snap.all, None);
    assert!(snap.no_proxy.contains(&"127.0.0.1".to_string()));
}

#[test]
fn scutil_all_disabled_is_off() {
    let text = "\
<dictionary> {
  HTTPEnable : 0
  HTTPProxy : 127.0.0.1
  HTTPPort : 7890
  HTTPSEnable : 0
  SOCKSEnable : 0
}
";
    let snap = parse_scutil_proxy(text);
    assert!(snap.is_off());
}

#[test]
fn registry_single_server_applies_to_http_and_https() {
    let snap = parse_windows_registry("0x1", "127.0.0.1:7890", "localhost;127.0.0.1;<local>");
    assert_eq!(snap.http.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(snap.https.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(snap.all, None);
    // `<local>` is a Windows-only sentinel with no env-var meaning: drop it.
    assert!(!snap.no_proxy.iter().any(|h| h == "<local>"));
    assert!(snap.no_proxy.contains(&"localhost".to_string()));
}

#[test]
fn registry_per_protocol_server_format() {
    let snap = parse_windows_registry(
        "0x1",
        "http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:1080",
        "",
    );
    assert_eq!(snap.http.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(snap.https.as_deref(), Some("http://127.0.0.1:7891"));
    assert_eq!(snap.all.as_deref(), Some("socks5://127.0.0.1:1080"));
}

#[test]
fn registry_disabled_is_off() {
    let snap = parse_windows_registry("0x0", "127.0.0.1:7890", "");
    assert!(snap.is_off());
}

#[test]
fn reg_query_output_is_extracted_and_parsed() {
    let text = "\
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    ProxyOverride    REG_SZ    localhost;127.0.0.1;<local>
";
    let snap = parse_reg_query_output(text);
    assert_eq!(snap.http.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(snap.https.as_deref(), Some("http://127.0.0.1:7890"));
    assert!(snap.no_proxy.contains(&"localhost".to_string()));
    assert!(!snap.no_proxy.iter().any(|h| h == "<local>"));
}

#[test]
fn render_full_snapshot_writes_both_cases_and_baseline_no_proxy() {
    let snap = ProxySnapshot {
        http: Some("http://127.0.0.1:7890".into()),
        https: Some("http://127.0.0.1:7890".into()),
        all: Some("socks5://127.0.0.1:7890".into()),
        no_proxy: vec!["localhost".into()], // baseline must fill 127.0.0.1 + ::1
    };
    let text = render_proxy_env(&snap);
    assert!(text.contains("http_proxy=http://127.0.0.1:7890\n"));
    assert!(text.contains("HTTP_PROXY=http://127.0.0.1:7890\n"));
    assert!(text.contains("https_proxy=http://127.0.0.1:7890\n"));
    assert!(text.contains("HTTPS_PROXY=http://127.0.0.1:7890\n"));
    assert!(text.contains("all_proxy=socks5://127.0.0.1:7890\n"));
    assert!(text.contains("ALL_PROXY=socks5://127.0.0.1:7890\n"));
    let no_proxy_line = text
        .lines()
        .find(|l| l.starts_with("no_proxy="))
        .expect("no_proxy line");
    assert!(no_proxy_line.contains("localhost"));
    assert!(no_proxy_line.contains("127.0.0.1"));
    assert!(no_proxy_line.contains("::1"));
}

#[test]
fn render_http_only_writes_two_proxy_lines_and_no_socks() {
    let snap = ProxySnapshot {
        http: Some("http://10.0.0.2:3128".into()),
        ..Default::default()
    };
    let text = render_proxy_env(&snap);
    assert!(text.contains("http_proxy=http://10.0.0.2:3128\n"));
    assert!(text.contains("HTTP_PROXY=http://10.0.0.2:3128\n"));
    assert!(!text.contains("https_proxy="));
    assert!(!text.contains("all_proxy="));
}

#[test]
fn render_off_snapshot_has_no_variable_lines() {
    let text = render_proxy_env(&ProxySnapshot::default());
    for key in [
        "http_proxy=", "HTTP_PROXY=", "https_proxy=", "HTTPS_PROXY=",
        "all_proxy=", "ALL_PROXY=", "no_proxy=", "NO_PROXY=",
    ] {
        assert!(!text.contains(key), "off render must not contain {key}");
    }
}

#[test]
fn env_pairs_lowercase_wins_and_splits_no_proxy() {
    let snap = proxy_from_env_pairs([
        ("http_proxy".to_string(), "http://127.0.0.1:7890".to_string()),
        ("HTTP_PROXY".to_string(), "http://ignored:1".to_string()),
        ("HTTPS_PROXY".to_string(), "http://127.0.0.1:7890".to_string()),
        ("all_proxy".to_string(), "socks5://127.0.0.1:7890".to_string()),
        ("no_proxy".to_string(), "localhost,.corp.example.com".to_string()),
    ]);
    assert_eq!(snap.http.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(snap.https.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(snap.all.as_deref(), Some("socks5://127.0.0.1:7890"));
    assert!(snap.no_proxy.contains(&".corp.example.com".to_string()));
}

/// Read-only end-to-end on a gsettings-capable host: the REAL system-proxy
/// state → parse → render → env-file → the real bash hook → the exported
/// `http_proxy` must equal the snapshot's. Self-skipping elsewhere so it stays
/// deterministic on any machine. (Runs gsettings itself instead of the
/// watcher's private detect path, so no internals need exposing.)
#[test]
fn gsettings_to_bash_hook_end_to_end() {
    let gsettings = std::process::Command::new("gsettings")
        .args(["list-recursively", "org.gnome.system.proxy"])
        .output();
    let text = match gsettings {
        Ok(out) if out.status.success() => Some(String::from_utf8_lossy(&out.stdout).into_owned()),
        _ => None,
    };
    let Some(text) = text else {
        eprintln!("skipping e2e: gsettings/schema not available");
        return;
    };
    let snap = parse_gsettings_dump(&text);
    let dir = std::env::temp_dir().join(format!("lumina-proxy-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let env_file = dir.join("proxy.env");
    std::fs::write(&env_file, render_proxy_env(&snap)).expect("write env-file");
    let script = format!(
        "{hook}\n__lumina_proxy\nprintf '%s' \"${{http_proxy-}}\"",
        hook = proxy_hook_bash(&env_file.to_string_lossy()),
    );
    let out = std::process::Command::new("bash")
        .args(["-c", &script])
        .env_remove("http_proxy")
        .env_remove("HTTP_PROXY")
        .output()
        .expect("spawn bash");
    assert!(out.status.success(), "bash hook run failed: {out:?}");
    let exported = String::from_utf8_lossy(&out.stdout).into_owned();
    assert_eq!(
        exported,
        snap.http.unwrap_or_default(),
        "hook-applied http_proxy must match the detected snapshot"
    );
}
