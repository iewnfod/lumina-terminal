//! `strip_ansi` (`src/mcp.rs`): the plain-text projection of terminal output
//! served to the read-only MCP server — CSI/OSC/DCS removal, control-char
//! dropping, `\n`/`\t` preservation, UTF-8 passthrough, torn-escape safety.
//! Plus the token loader's state-folder layout + legacy migration over a
//! real temp dir, and the tool-list schema contract every MCP client
//! validates before accepting the server.

use lumina_terminal_lib::mcp::{LuminaMcpServer, load_or_create_token_in, strip_ansi, STATE_DIR};

/// Unique temp dir per test (process id + label) so parallel tests don't
/// collide, cleaned up best-effort at the end.
fn temp_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("lumina-mcp-token-{}-{label}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

#[test]
fn sgr_colors_are_removed() {
    assert_eq!(strip_ansi("\x1b[31mred\x1b[0m text"), "red text");
    assert_eq!(strip_ansi("\x1b[1;38;2;255;0;0mbold\x1b[m"), "bold");
}

#[test]
fn cursor_moves_and_clears_are_removed() {
    // Includes a private-mode CSI (`?` param byte) — must be consumed too.
    assert_eq!(strip_ansi("\x1b[2J\x1b[H\x1b[?25lhi"), "hi");
    assert_eq!(strip_ansi("\x1b[5Aup\x1b[10Gcol"), "upcol");
}

#[test]
fn osc_sequences_bel_and_st_terminated_are_removed() {
    assert_eq!(strip_ansi("\x1b]0;window title\x07after"), "after");
    assert_eq!(strip_ansi("\x1b]0;t\x1b\\after"), "after");
}

#[test]
fn dcs_sequences_are_removed_up_to_st() {
    assert_eq!(strip_ansi("\x1bP1;2|payload\x1b\\x"), "x");
}

#[test]
fn two_byte_escapes_are_removed() {
    // ESC M (reverse index), ESC 7, ESC = — all in the one-byte dispatch.
    assert_eq!(strip_ansi("\x1bMa\x1b7b\x1b=c"), "abc");
}

#[test]
fn newline_and_tab_survive_but_other_controls_drop() {
    // \r, BEL, backspace, DEL are dropped; \n and \t are kept.
    assert_eq!(strip_ansi("a\rb\n\tc\x07\x08\x7fd"), "ab\n\tcd");
}

#[test]
fn plain_and_multibyte_text_pass_through_untouched() {
    let s = "你好 world ünïcödé 🙂";
    assert_eq!(strip_ansi(s), s);
}

#[test]
fn lone_trailing_escape_does_not_panic() {
    // A torn read can end mid-escape; the scanner must stop, not loop.
    assert_eq!(strip_ansi("abc\x1b"), "abc");
    assert_eq!(strip_ansi("\x1b"), "");
}

#[test]
fn mixed_stream_reduces_to_readable_text() {
    let raw = "\x1b]0;vim\x07\x1b[2;1H\x1b[1merror\x1b[0m: no such file\r\n";
    assert_eq!(strip_ansi(raw), "error: no such file\n");
}

#[test]
fn token_is_created_in_state_dir_and_stable_across_calls() {
    let dir = temp_dir("create");
    let first = load_or_create_token_in(&dir).expect("token");
    assert!(!first.is_empty());
    // Written into the state subfolder, not the data-dir root.
    assert!(dir.join(STATE_DIR).join("mcp-token").is_file());
    assert!(!dir.join("mcp-token").exists());
    // A second load returns the SAME token (stable across restarts).
    assert_eq!(load_or_create_token_in(&dir).unwrap(), first);
}

#[test]
fn legacy_root_token_is_migrated_not_regenerated() {
    let dir = temp_dir("migrate");
    std::fs::write(dir.join("mcp-token"), "lumina-old-token\n").expect("seed legacy token");
    let tok = load_or_create_token_in(&dir).expect("token");
    // The configured client URL keeps working: same value, new location.
    assert_eq!(tok, "lumina-old-token");
    assert_eq!(
        std::fs::read_to_string(dir.join(STATE_DIR).join("mcp-token")).unwrap(),
        "lumina-old-token\n"
    );
    assert!(!dir.join("mcp-token").exists(), "legacy file is gone");
}

#[test]
fn state_dir_token_wins_over_leftover_legacy_file() {
    // Both exist (e.g. an old build ran again after the migration): the
    // current token must survive and the legacy file stays untouched.
    let dir = temp_dir("both");
    std::fs::create_dir_all(dir.join(STATE_DIR)).expect("create state dir");
    std::fs::write(dir.join("mcp-token"), "lumina-old").expect("seed legacy token");
    std::fs::write(dir.join(STATE_DIR).join("mcp-token"), "lumina-new").expect("seed token");
    assert_eq!(load_or_create_token_in(&dir).unwrap(), "lumina-new");
    assert!(dir.join("mcp-token").exists());
}

// ---- tools/list schema contract ----
//
// The MCP spec requires every tool's `outputSchema` — and the matching
// `structuredContent` value — to be a top-level JSON OBJECT. rmcp derives
// both straight from the `Json<T>` return type and (per SEP-2106) does not
// enforce the object root itself, so strict clients (OpenCode among them)
// reject the whole server with "Invalid result for tools/list" unless every
// tool returns a single-field wrapper object. These tests pin that contract.

#[test]
fn every_tool_output_schema_is_a_top_level_object() {
    let tools = LuminaMcpServer::tool_router().list_all();
    assert_eq!(tools.len(), 8, "expected the 8 read-only tools");
    for tool in &tools {
        let schema = tool
            .output_schema
            .as_ref()
            .unwrap_or_else(|| panic!("tool `{}` is missing outputSchema", tool.name));
        assert_eq!(
            schema.get("type").and_then(|t| t.as_str()),
            Some("object"),
            "tool `{}` outputSchema must have top-level type \"object\" (MCP spec), got {:?}",
            tool.name,
            schema.get("type")
        );
    }
}

#[test]
fn wrapper_schemas_expose_the_payload_field() {
    let tools = LuminaMcpServer::tool_router().list_all();
    let schema_of = |name: &str| {
        tools
            .iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| panic!("tool `{name}` not registered"))
            .output_schema
            .as_ref()
            .expect("outputSchema present")
    };
    let field_type = |tool: &str, field: &str| {
        schema_of(tool)
            .get("properties")
            .and_then(|p| p.get(field))
            .unwrap_or_else(|| panic!("tool `{tool}` should expose a `{field}` property"))
            .get("type")
            .and_then(|t| t.as_str())
            .map(str::to_owned)
    };

    assert_eq!(field_type("list_tabs", "tabs").as_deref(), Some("array"));
    assert_eq!(field_type("list_recent_exits", "exits").as_deref(), Some("array"));
    assert_eq!(field_type("list_command_history", "history").as_deref(), Some("array"));
    assert_eq!(field_type("get_recent_output", "output").as_deref(), Some("string"));
    // Nullable singletons: only the wrapper FIELD's existence matters here —
    // the inner anyOf/null composition lives inside the object, which is
    // legal (only the ROOT must be an object).
    for tool in ["get_tab", "get_active_tab", "get_foreground_command", "get_terminal_cwd"] {
        let field = match tool {
            "get_terminal_cwd" => "cwd",
            "get_foreground_command" => "command",
            _ => "tab",
        };
        let schema = schema_of(tool);
        assert!(
            schema.get("properties").and_then(|p| p.get(field)).is_some(),
            "tool `{tool}` should expose a `{field}` property"
        );
    }
}
