use std::path::PathBuf;
use serde::{Deserialize, Serialize};

/// Connection parameters for a remote (SSH) terminal profile. Serialized over
/// the IPC boundary as part of `start_terminal`'s `ssh_config` argument, and
/// also produced by `parse_ssh_config` when reading `~/.ssh/config`.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
}

/// One parsed `Host` block from `~/.ssh/config`, keyed by its alias.
#[derive(Debug, Serialize)]
pub struct SshHostEntry {
    pub host: String,
    pub config: SshConfig,
}

/// Parse the CONTENT of an `~/.ssh/config` into concrete (non-wildcard) host
/// entries. Pure — split from [`parse_ssh_config`] so tests can drive it with
/// fixture config text (same extraction pattern as the proxy parsers).
///
/// Wildcard hosts (`*`, `?.example.com`) are skipped since they are patterns,
/// not connectable aliases. A `Host` block without a `HostName` is skipped.
/// Keywords are matched case-insensitively; an unparseable `Port` is ignored
/// (logged).
pub fn parse_ssh_config_content(content: &str) -> Vec<SshHostEntry> {
    let mut entries: Vec<SshHostEntry> = vec![];
    let mut current_hosts: Vec<String> = vec![];
    let mut current_hostname: Option<String> = None;
    let mut current_port: Option<u16> = None;
    let mut current_user: Option<String> = None;
    let mut current_identity_file: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        // Skip empty lines and comments
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let keyword = parts.next().unwrap_or("");
        let rest: Vec<&str> = parts.collect();
        let value = rest.join(" ");

        match keyword.to_lowercase().as_str() {
            "host" => {
                // Save previous entry
                if !current_hosts.is_empty() && current_hostname.is_some() {
                    let host = current_hosts[0].clone();
                    let config = SshConfig {
                        host: current_hostname.unwrap_or_default(),
                        port: current_port,
                        user: current_user.clone(),
                        identity_file: current_identity_file.clone(),
                    };
                    entries.push(SshHostEntry { host, config });
                }
                // Start new entry (skip wildcards like *)
                let hosts: Vec<String> = value
                    .split_whitespace()
                    .filter(|h| *h != "*" && !h.contains('*') && !h.contains('?'))
                    .map(|h| h.to_string())
                    .collect();
                current_hosts = hosts;
                current_hostname = None;
                current_port = None;
                current_user = None;
                current_identity_file = None;
            }
            "hostname" => {
                current_hostname = Some(value);
            }
            "port" => {
                match value.parse() {
                    Ok(p) => current_port = Some(p),
                    Err(_) => log::warn!("Invalid port in SSH config: {}", value),
                }
            }
            "user" => {
                current_user = Some(value);
            }
            "identityfile" => {
                current_identity_file = Some(value);
            }
            _ => {}
        }
    }
    // Save last entry
    if !current_hosts.is_empty() && current_hostname.is_some() {
        let host = current_hosts[0].clone();
        let config = SshConfig {
            host: current_hostname.unwrap_or_default(),
            port: current_port,
            user: current_user.clone(),
            identity_file: current_identity_file.clone(),
        };
        entries.push(SshHostEntry { host, config });
    }

    entries
}

/// Parse `~/.ssh/config` into a list of concrete (non-wildcard) host entries.
///
/// Returns an empty list when the file is missing or unreadable — a common
/// state on fresh installs — so the SSH profile picker simply shows nothing
/// rather than erroring.
#[tauri::command]
pub fn parse_ssh_config() -> Vec<SshHostEntry> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let config_path = PathBuf::from(&home).join(".ssh").join("config");
    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(e) => {
            // Missing/unreadable ~/.ssh/config is common; log at debug so it's
            // diagnosable without being noisy on every fresh install.
            log::debug!("No SSH config at {}: {}", config_path.display(), e);
            return vec![];
        }
    };
    parse_ssh_config_content(&content)
}
