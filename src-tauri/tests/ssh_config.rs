//! `~/.ssh/config` content parsing (`src/ssh.rs::parse_ssh_config_content`):
//! alias blocks, wildcard skipping, keyword case-insensitivity, invalid ports,
//! and the entry-boundary reset between blocks.

use lumina_terminal_lib::ssh::parse_ssh_config_content;

#[test]
fn empty_and_comment_only_content_yields_no_entries() {
    assert!(parse_ssh_config_content("").is_empty());
    assert!(parse_ssh_config_content("# nothing here\n\n  \n# more\n").is_empty());
}

#[test]
fn full_block_is_parsed_field_by_field() {
    let content = "\
Host web
    HostName web.example.com
    Port 2222
    User deploy
    IdentityFile ~/.ssh/id_ed25519
";
    let entries = parse_ssh_config_content(content);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].host, "web");
    assert_eq!(entries[0].config.host, "web.example.com");
    assert_eq!(entries[0].config.port, Some(2222));
    assert_eq!(entries[0].config.user.as_deref(), Some("deploy"));
    assert_eq!(entries[0].config.identity_file.as_deref(), Some("~/.ssh/id_ed25519"));
}

#[test]
fn keywords_match_case_insensitively() {
    let content = "\
HOST prod
  HOSTNAME prod.example.com
  PORT 22
";
    let entries = parse_ssh_config_content(content);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].host, "prod");
    assert_eq!(entries[0].config.host, "prod.example.com");
    assert_eq!(entries[0].config.port, Some(22));
}

#[test]
fn wildcard_hosts_are_skipped() {
    let content = "\
Host *
    HostName catch-all.example.com

Host *.example.com
    HostName star.example.com

Host ?.example.com
    HostName question.example.com

Host pre*
    HostName prefix.example.com
";
    assert!(parse_ssh_config_content(content).is_empty());
}

#[test]
fn mixed_alias_line_keeps_non_wildcard_aliases() {
    // `Host web1 *` — the wildcard is dropped, web1 stays connectable.
    let content = "Host web1 *\n    HostName web.example.com\n";
    let entries = parse_ssh_config_content(content);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].host, "web1");
}

#[test]
fn block_without_hostname_is_skipped() {
    // An alias with no HostName has nothing to connect to — drop it rather
    // than emit an entry with an empty address.
    let content = "Host dangling\n    User x\n";
    assert!(parse_ssh_config_content(content).is_empty());
}

#[test]
fn multiple_blocks_parse_independently() {
    let content = "\
Host first
    HostName first.example.com
    Port 1000
    User alice

Host second
    HostName second.example.com
";
    let entries = parse_ssh_config_content(content);
    assert_eq!(entries.len(), 2);

    assert_eq!(entries[0].host, "first");
    assert_eq!(entries[0].config.port, Some(1000));
    assert_eq!(entries[0].config.user.as_deref(), Some("alice"));

    // The second block must NOT inherit the first block's port/user.
    assert_eq!(entries[1].host, "second");
    assert_eq!(entries[1].config.host, "second.example.com");
    assert_eq!(entries[1].config.port, None);
    assert_eq!(entries[1].config.user, None);
}

#[test]
fn invalid_port_is_ignored_but_block_survives() {
    let content = "\
Host weird
    HostName weird.example.com
    Port not-a-number
";
    let entries = parse_ssh_config_content(content);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].config.port, None);
}

#[test]
fn multiple_aliases_on_one_line_use_the_first() {
    let content = "Host alpha beta\n    HostName alpha.example.com\n";
    let entries = parse_ssh_config_content(content);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].host, "alpha");
}

#[test]
fn comments_and_blank_lines_between_blocks_are_tolerated() {
    let content = "\
# work machines
Host work

# (blank above)
    HostName work.example.com

Host home
    HostName home.example.com
";
    let entries = parse_ssh_config_content(content);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].host, "work");
    assert_eq!(entries[1].host, "home");
}
