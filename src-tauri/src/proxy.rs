//! System-proxy auto injection: detect the OS/desktop proxy state, and publish
//! it as a small env-file (`lumina-shell-integration/proxy.env`) that the
//! shell-integration precmd hooks (bash/zsh/fish, see `shell_integration.rs`)
//! read before every prompt — exporting/unsetting `http_proxy`/`HTTP_PROXY`/…
//! inside ALREADY-RUNNING shells, with no restart and no visible keystrokes.
//!
//! Detection sources (first match wins, chosen per platform/DE):
//!  - Linux, GNOME-family DE → `gsettings list-recursively org.gnome.system.proxy`
//!  - Linux, KDE → `~/.config/kioslaverc` ([Proxy Settings], parsed as INI)
//!  - Linux, other → gsettings if available, else kioslaverc, else Lumina's own
//!    process env
//!  - macOS → `scutil --proxy`
//!  - Windows → registry Internet Settings (via `reg query`)
//!
//! Only "manual" proxies are injected; PAC/autoconfig modes cannot be expressed
//! in env vars and are reported as off. The watcher thread polls every few
//! seconds and rewrites the env-file (atomically) only when the snapshot
//! changes; the hooks diff it against a marker so unchanged prompts cost one
//! small file read.

use std::time::Duration;

/// Detected system proxy state. `None` per class = that proxy is off.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ProxySnapshot {
    /// e.g. `http://127.0.0.1:7890` — proxy for plain HTTP.
    pub http: Option<String>,
    /// e.g. `http://127.0.0.1:7890` — proxy for HTTPS (usually the same).
    pub https: Option<String>,
    /// e.g. `socks5://127.0.0.1:7890` — maps to `all_proxy`/`ALL_PROXY`.
    pub all: Option<String>,
    /// Hosts/CIDRs to bypass, mapped to `no_proxy`/`NO_PROXY` (comma-joined).
    pub no_proxy: Vec<String>,
}

impl ProxySnapshot {
    /// True when no proxy class is active. A snapshot that is off still renders
    /// (as an empty env-file) so the hooks unset what they previously injected.
    pub fn is_off(&self) -> bool {
        self.http.is_none() && self.https.is_none() && self.all.is_none()
    }
}

/// Build `scheme://host:port`; `None` when the host is empty or the port is 0
/// (both are how "unset" appears in every detection source).
fn proxy_url(scheme: &str, host: &str, port: u16) -> Option<String> {
    if host.is_empty() || port == 0 {
        return None;
    }
    Some(format!("{scheme}://{host}:{port}"))
}

/// Strip the surrounding single quotes gsettings puts around string values
/// (`'manual'` → `manual`). Non-quoted input (ints, bools) passes through.
fn gsettings_unquote(v: &str) -> &str {
    let v = v.trim();
    v.strip_prefix('\'')
        .and_then(|s| s.strip_suffix('\''))
        .unwrap_or(v)
}

/// Extract the single-quoted strings out of a GVariant array printout
/// (`['localhost', '127.0.0.1']` → both entries).
fn parse_gvariant_array(v: &str) -> Vec<String> {
    let inner = v.trim().trim_start_matches('[').trim_end_matches(']');
    inner
        .split(',')
        .map(gsettings_unquote)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Normalize a KDE proxy value: ensure a scheme, upgrading the legacy
/// `socks://` to `socks5://` (what `all_proxy` consumers expect).
fn normalize_proxy_url(v: &str, default_scheme: &str) -> Option<String> {
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    if let Some(rest) = v.strip_prefix("socks://") {
        return Some(format!("socks5://{rest}"));
    }
    if v.contains("://") {
        return Some(v.to_string());
    }
    Some(format!("{default_scheme}://{v}"))
}

/// Baseline hosts every no_proxy should contain; merged in by the renderer so
/// localhost traffic never goes through the proxy even on bare DE configs.
const NO_PROXY_BASELINE: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// Render the env-file the shell hooks consume. Keys are literal env-var names
/// (both cases per class), so the hook can apply each line with no case
/// conversion. Absent classes produce no lines — absence IS the "unset" signal.
/// `no_proxy` is only emitted when some proxy is active, with the localhost /
/// 127.0.0.1 / ::1 baseline merged in (a proxy without local bypass is almost
/// never what the user wants).
pub fn render_proxy_env(snap: &ProxySnapshot) -> String {
    let mut out = String::from("# lumina proxy v1\n");
    let mut push = |key: &str, value: &str| {
        out.push_str(key);
        out.push('=');
        out.push_str(value);
        out.push('\n');
    };
    if let Some(v) = &snap.http {
        push("http_proxy", v);
        push("HTTP_PROXY", v);
    }
    if let Some(v) = &snap.https {
        push("https_proxy", v);
        push("HTTPS_PROXY", v);
    }
    if let Some(v) = &snap.all {
        push("all_proxy", v);
        push("ALL_PROXY", v);
    }
    if !snap.is_off() {
        let mut hosts: Vec<String> = NO_PROXY_BASELINE.iter().map(|s| s.to_string()).collect();
        for h in &snap.no_proxy {
            if !hosts.contains(h) {
                hosts.push(h.clone());
            }
        }
        let joined = hosts.join(",");
        push("no_proxy", &joined);
        push("NO_PROXY", &joined);
    }
    out
}

/// Parse `gsettings list-recursively org.gnome.system.proxy` output.
pub fn parse_gsettings_dump(text: &str) -> ProxySnapshot {
    let mut mode = String::new();
    let mut http = (String::new(), 0u16);
    let mut https = (String::new(), 0u16);
    let mut socks = (String::new(), 0u16);
    let mut no_proxy = Vec::new();
    for line in text.lines() {
        // Each line is `schema key value`; the value is the remainder
        // (ignore-hosts arrays contain spaces).
        let mut parts = line.splitn(3, char::is_whitespace);
        let (Some(schema), Some(key)) = (parts.next(), parts.next()) else {
            continue;
        };
        let value = parts.next().unwrap_or("").trim();
        match (schema, key) {
            ("org.gnome.system.proxy", "mode") => mode = gsettings_unquote(value).to_string(),
            ("org.gnome.system.proxy", "ignore-hosts") => no_proxy = parse_gvariant_array(value),
            ("org.gnome.system.proxy.http", "host") => http.0 = gsettings_unquote(value).to_string(),
            ("org.gnome.system.proxy.http", "port") => http.1 = value.parse().unwrap_or(0),
            ("org.gnome.system.proxy.https", "host") => https.0 = gsettings_unquote(value).to_string(),
            ("org.gnome.system.proxy.https", "port") => https.1 = value.parse().unwrap_or(0),
            ("org.gnome.system.proxy.socks", "host") => socks.0 = gsettings_unquote(value).to_string(),
            ("org.gnome.system.proxy.socks", "port") => socks.1 = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    // Only "manual" is expressible as env vars: "none" is off, "auto" (PAC)
    // cannot be honored by http_proxy-style consumers.
    if mode != "manual" {
        return ProxySnapshot::default();
    }
    let http_url = proxy_url("http", &http.0, http.1);
    ProxySnapshot {
        http: http_url.clone(),
        // An empty https host falls back to the http proxy (GNOME's
        // use-same-proxy behavior with an unconfigured https child).
        https: proxy_url("http", &https.0, https.1).or(http_url),
        all: proxy_url("socks5", &socks.0, socks.1),
        no_proxy,
    }
}

/// Parse KDE's `kioslaverc` `[Proxy Settings]` section (INI text, read straight
/// from `~/.config` — no kreadconfig subprocess needed).
pub fn parse_kioslaverc(text: &str) -> ProxySnapshot {
    let mut in_section = false;
    let mut manual = false;
    let mut http = None;
    let mut https = None;
    let mut socks = None;
    let mut no_proxy = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_section = line.eq_ignore_ascii_case("[Proxy Settings]");
            continue;
        }
        if !in_section {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            // ProxyType: 0 = none, 1 = manual (2 PAC / 3 WPAD / 4 env — not
            // expressible as fixed env vars, treated as off).
            "ProxyType" => manual = value.trim() == "1",
            "httpProxy" => http = normalize_proxy_url(value, "http"),
            "httpsProxy" => https = normalize_proxy_url(value, "http"),
            "socksProxy" => socks = normalize_proxy_url(value, "socks5"),
            "NoProxyFor" => no_proxy = value
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
            _ => {}
        }
    }
    if !manual {
        return ProxySnapshot::default();
    }
    ProxySnapshot {
        http: http.clone(),
        https: https.or(http),
        all: socks,
        no_proxy,
    }
}

/// Parse macOS `scutil --proxy` output (a `<dictionary> { K : V … }` block).
pub fn parse_scutil_proxy(text: &str) -> ProxySnapshot {
    let mut http = (false, String::new(), 0u16);
    let mut https = (false, String::new(), 0u16);
    let mut socks = (false, String::new(), 0u16);
    let mut no_proxy = Vec::new();
    let mut in_exceptions = false;
    for line in text.lines() {
        let line = line.trim();
        if in_exceptions {
            if line.contains('}') {
                in_exceptions = false;
            } else if !line.is_empty() {
                no_proxy.push(line.to_string());
            }
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        let enabled = value == "1";
        match key {
            "HTTPEnable" => http.0 = enabled,
            "HTTPProxy" => http.1 = value.to_string(),
            "HTTPPort" => http.2 = value.parse().unwrap_or(0),
            "HTTPSEnable" => https.0 = enabled,
            "HTTPSProxy" => https.1 = value.to_string(),
            "HTTPSPort" => https.2 = value.parse().unwrap_or(0),
            "SOCKSEnable" => socks.0 = enabled,
            "SOCKSProxy" => socks.1 = value.to_string(),
            "SOCKSPort" => socks.2 = value.parse().unwrap_or(0),
            "ExceptionsList" if value.contains("<array>") => in_exceptions = true,
            _ => {}
        }
    }
    let http_url = if http.0 { proxy_url("http", &http.1, http.2) } else { None };
    let https_url = if https.0 { proxy_url("http", &https.1, https.2) } else { None };
    let all_url = if socks.0 { proxy_url("socks5", &socks.1, socks.2) } else { None };
    ProxySnapshot {
        http: http_url,
        https: https_url,
        all: all_url,
        no_proxy,
    }
}

/// Parse the Windows per-user proxy registry values: `ProxyEnable` (REG_DWORD
/// as printed by `reg query`, e.g. `0x1`), `ProxyServer` (either `host:port`
/// or `http=host:port;https=…` per-protocol), and `ProxyOverride`
/// (`;`-separated, may contain the `<local>` sentinel which we drop).
pub fn parse_windows_registry(enable: &str, server: &str, override_list: &str) -> ProxySnapshot {
    let enabled = matches!(enable.trim(), "1" | "0x1" | "0x01");
    if !enabled {
        return ProxySnapshot::default();
    }
    let mut snap = ProxySnapshot::default();
    if server.contains('=') {
        // Per-protocol form: `http=host:port;https=host:port;socks=host:port`.
        for entry in server.split(';') {
            let Some((proto, addr)) = entry.split_once('=') else {
                continue;
            };
            match proto.trim() {
                "http" => snap.http = normalize_proxy_url(addr, "http"),
                "https" => snap.https = normalize_proxy_url(addr, "http"),
                "socks" => snap.all = normalize_proxy_url(addr, "socks5"),
                _ => {}
            }
        }
    } else {
        // Single `host:port` applies to http and https alike.
        snap.http = normalize_proxy_url(server, "http");
        snap.https = snap.http.clone();
    }
    snap.no_proxy = override_list
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "<local>")
        .map(str::to_string)
        .collect();
    snap
}

/// Build a snapshot from environment pairs (the last-resort Linux source):
/// Lumina's own `http_proxy`/`HTTPS_PROXY`/etc. Lowercase keys win over
/// uppercase when both are set. `no_proxy`/`NO_PROXY` is comma-split.
pub fn proxy_from_env_pairs<I: IntoIterator<Item = (String, String)>>(pairs: I) -> ProxySnapshot {
    // Collected once (env sets are tiny) so several keys can be looked up.
    let collected: Vec<(String, String)> = pairs.into_iter().collect();
    let lookup = |lower: &str, upper: &str| -> Option<String> {
        collected
            .iter()
            .find(|(k, _)| k == lower || k == upper)
            .map(|(_, v)| v.clone())
    };
    let mut snap = ProxySnapshot {
        http: lookup("http_proxy", "HTTP_PROXY"),
        https: lookup("https_proxy", "HTTPS_PROXY"),
        all: lookup("all_proxy", "ALL_PROXY"),
        no_proxy: Vec::new(),
    };
    if let Some(list) = lookup("no_proxy", "NO_PROXY") {
        snap.no_proxy = list
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
    }
    snap
}

/// Parse the full `reg query <Internet Settings>` output (value name, type,
/// value per line) and feed the extracted trio into `parse_windows_registry`.
pub fn parse_reg_query_output(text: &str) -> ProxySnapshot {
    let mut enable = String::new();
    let mut server = String::new();
    let mut overrides = String::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(name), Some(_type)) = (parts.next(), parts.next()) {
            let value = line
                .split_whitespace()
                .skip(2)
                .collect::<Vec<_>>()
                .join(" ");
            match name {
                "ProxyEnable" => enable = value,
                "ProxyServer" => server = value,
                "ProxyOverride" => overrides = value,
                _ => {}
            }
        }
    }
    parse_windows_registry(&enable, &server, &overrides)
}

// ---------------------------------------------------------------------------
// Detection sources
// ---------------------------------------------------------------------------

/// Run a command and capture its stdout as lossy UTF-8; `None` when the binary
/// is missing or the command fails (the caller treats that as "source
/// unavailable" and falls through to the next one).
fn capture_stdout(cmd: &mut std::process::Command) -> Option<String> {
    match cmd.output() {
        Ok(out) if out.status.success() => Some(String::from_utf8_lossy(&out.stdout).into_owned()),
        _ => None,
    }
}

/// Which system-proxy source to poll, picked ONCE per watcher run (probing
/// shells out, so it must not happen every poll). The desktop environment
/// decides the priority; neither the DE nor the installed tooling changes
/// while the app runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProxySource {
    /// `gsettings list-recursively org.gnome.system.proxy` (GNOME-family).
    Gsettings,
    /// `~/.config/kioslaverc` (KDE), read directly.
    Kioslaverc,
    /// macOS `scutil --proxy`.
    #[cfg(target_os = "macos")]
    Scutil,
    /// Windows registry via `reg query`.
    #[cfg(target_os = "windows")]
    Registry,
    /// Lumina's own process environment.
    Env,
}

/// Path of KDE's proxy config, per the XDG base dir (default ~/.config).
fn kioslaverc_path() -> Option<std::path::PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))
        .map(|base| base.join("kioslaverc"))
}

fn probe_gsettings() -> bool {
    capture_stdout(std::process::Command::new("gsettings").args([
        "list-recursively",
        "org.gnome.system.proxy",
    ]))
    .is_some()
}

fn read_kioslaverc() -> Option<String> {
    std::fs::read_to_string(kioslaverc_path()?).ok()
}

/// Pick the detection source for this platform/session. Probing failures are
/// logged at debug (a "missing gsettings" on a KDE box is normal, not a warn).
fn pick_proxy_source() -> ProxySource {
    #[cfg(target_os = "macos")]
    {
        ProxySource::Scutil
    }
    #[cfg(target_os = "windows")]
    {
        ProxySource::Registry
    }
    #[cfg(target_os = "linux")]
    {
        let desktop = std::env::var("XDG_CURRENT_DESKTOP")
            .unwrap_or_default()
            .to_lowercase();
        let gnome_like = ["gnome", "cinnamon", "mate", "budgie"]
            .iter()
            .any(|d| desktop.contains(d));
        let kde = desktop.contains("kde");
        let gsettings_ok = probe_gsettings();
        let kioslaverc_ok = kioslaverc_path()
            .map(|p| p.exists())
            .unwrap_or(false);
        let source = if kde {
            // KDE active: trust kioslaverc first; a present-but-idle gsettings
            // schema (pulled in by GTK deps) would otherwise shadow it.
            if kioslaverc_ok {
                ProxySource::Kioslaverc
            } else if gsettings_ok {
                ProxySource::Gsettings
            } else {
                ProxySource::Env
            }
        } else if gnome_like || gsettings_ok {
            ProxySource::Gsettings
        } else if kioslaverc_ok {
            ProxySource::Kioslaverc
        } else {
            ProxySource::Env
        };
        log::debug!(
            "Proxy detection source: {:?} (desktop={:?} gsettings={} kioslaverc={})",
            source,
            desktop,
            gsettings_ok,
            kioslaverc_ok
        );
        source
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        ProxySource::Env
    }
}

/// Poll the picked source once. Never fails: an unreadable source reports "off"
/// (the hooks then unset only what they injected).
fn detect_snapshot(source: ProxySource) -> ProxySnapshot {
    match source {
        ProxySource::Gsettings => capture_stdout(std::process::Command::new("gsettings").args([
            "list-recursively",
            "org.gnome.system.proxy",
        ]))
        .map(|text| parse_gsettings_dump(&text))
        .unwrap_or_default(),
        ProxySource::Kioslaverc => read_kioslaverc()
            .map(|text| parse_kioslaverc(&text))
            .unwrap_or_default(),
        #[cfg(target_os = "macos")]
        ProxySource::Scutil => capture_stdout(std::process::Command::new("scutil").args(["--proxy"]))
            .map(|text| parse_scutil_proxy(&text))
            .unwrap_or_default(),
        #[cfg(target_os = "windows")]
        ProxySource::Registry => capture_stdout(std::process::Command::new("reg").args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        ]))
        .map(|text| parse_reg_query_output(&text))
        .unwrap_or_default(),
        ProxySource::Env => proxy_from_env_pairs(std::env::vars()),
    }
}

// ---------------------------------------------------------------------------
// Watcher thread + Tauri commands
// ---------------------------------------------------------------------------

/// Poll interval for the system proxy, in 100ms slices (sliced so `stop` joins
/// the thread quickly instead of blocking a full interval).
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const POLL_SLICE: Duration = Duration::from_millis(100);

/// Managed state holding the single watcher thread. Start is idempotent; stop
/// joins the thread and deletes the env-file (whose absence tells the hooks to
/// unset what they injected).
#[derive(Default)]
pub struct ProxySyncHandle {
    watcher: std::sync::Mutex<Option<WatcherThread>>,
}

struct WatcherThread {
    running: std::sync::Arc<std::sync::atomic::AtomicBool>,
    handle: std::thread::JoinHandle<()>,
}

/// The env-file path, shared by the writer (watcher) and the hooks (whose init
/// scripts bake this same path in at shell spawn time).
fn proxy_env_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::shell_integration::integration_dir(app)?.join("proxy.env"))
}

/// Write via tmp+rename so a hook never reads a half-written file. POSIX
/// rename overwrites atomically; Windows' does not, so drop the target first
/// (the window between remove and rename is harmless — hooks treat a missing
/// file as "keep current state until next prompt").
fn write_atomic(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("env.tmp");
    std::fs::write(&tmp, content)?;
    #[cfg(windows)]
    let _ = std::fs::remove_file(path);
    std::fs::rename(&tmp, path)
}

fn watcher_loop(
    running: std::sync::Arc<std::sync::atomic::AtomicBool>,
    env_path: std::path::PathBuf,
) {
    use std::sync::atomic::Ordering;
    let source = pick_proxy_source();
    // Last snapshot written. `None` forces an initial write so a stale file
    // from a crashed run is replaced with the current truth at startup.
    let mut last: Option<ProxySnapshot> = None;
    log::debug!("Proxy watcher polling {:?} every {:?}", source, POLL_INTERVAL);
    while running.load(Ordering::Relaxed) {
        let snap = detect_snapshot(source);
        if last.as_ref() != Some(&snap) {
            last = Some(snap.clone());
            if let Err(e) = write_atomic(&env_path, &render_proxy_env(&snap)) {
                log::warn!(
                    "Proxy watcher failed to write {}: {} (will retry on next change)",
                    env_path.display(),
                    e
                );
            } else if snap.is_off() {
                log::info!("System proxy: off");
            } else {
                log::info!(
                    "System proxy changed: http={:?} https={:?} all={:?} no_proxy={}",
                    snap.http,
                    snap.https,
                    snap.all,
                    snap.no_proxy.join(",")
                );
            }
        }
        // Sliced sleep: stop() flips the flag and joins within one slice.
        let mut slept = Duration::ZERO;
        while slept < POLL_INTERVAL && running.load(Ordering::Relaxed) {
            std::thread::sleep(POLL_SLICE);
            slept += POLL_SLICE;
        }
    }
    log::debug!("Proxy watcher thread exiting");
}

/// Start watching the system proxy and publishing it to the hooks' env-file.
/// Idempotent — a second call (tear-off window, settings remount) is a no-op.
#[tauri::command]
pub fn start_proxy_sync(
    app: tauri::AppHandle,
    state: tauri::State<ProxySyncHandle>,
) -> Result<(), String> {
    let mut guard = state.watcher.try_lock().unwrap_or_else(|e| {
        log::error!("Failed to lock proxy watcher state for start: {}", e);
        panic!("Failed to lock proxy watcher state: {}", e);
    });
    if guard.is_some() {
        log::debug!("start_proxy_sync: watcher already running");
        return Ok(());
    }
    let env_path = proxy_env_path(&app)?;
    let running = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let flag = running.clone();
    let handle = std::thread::spawn(move || watcher_loop(flag, env_path));
    *guard = Some(WatcherThread { running, handle });
    log::info!("Proxy sync watcher started");
    Ok(())
}

/// Stop the watcher and delete the env-file. The file's disappearance is the
/// hooks' signal to unset everything THEY injected (manual exports stay).
/// Also runs at startup when the feature is disabled, cleaning up any stale
/// file left by a previous crashed run.
#[tauri::command]
pub fn stop_proxy_sync(
    app: tauri::AppHandle,
    state: tauri::State<ProxySyncHandle>,
) -> Result<(), String> {
    {
        let mut guard = state.watcher.try_lock().unwrap_or_else(|e| {
            log::error!("Failed to lock proxy watcher state for stop: {}", e);
            panic!("Failed to lock proxy watcher state: {}", e);
        });
        if let Some(w) = guard.take() {
            use std::sync::atomic::Ordering;
            w.running.store(false, Ordering::Relaxed);
            if let Err(e) = w.handle.join() {
                log::error!("Proxy watcher thread panicked on join: {:?}", e);
            }
            log::info!("Proxy sync watcher stopped");
        }
    }
    match proxy_env_path(&app) {
        Ok(path) => {
            if let Err(e) = std::fs::remove_file(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("Failed to remove proxy env-file {}: {}", path.display(), e);
                }
            }
        }
        Err(e) => log::warn!("stop_proxy_sync: {}", e),
    }
    Ok(())
}
