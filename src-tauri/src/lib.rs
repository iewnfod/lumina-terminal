// Modules are `pub` so the integration tests in tests/ can exercise them (the
// app crate is not consumed as a library by anything else). Per AGENTS.md §3.7,
// logic a test needs is extracted into a named `pub fn` with explicit inputs
// (see `proxy`'s parsers, `ssh::parse_ssh_config_content`,
// `terminal::flush_utf8_pass`, …) while the `#[tauri::command]` wrappers stay
// thin. `system` stays private: it is pure environment probing with no test
// surface.
pub mod cli;
pub mod command_icons;
pub mod command_tracker;
pub mod file_manager;
pub mod fonts;
pub mod install_source;
pub mod mcp;
pub mod proxy;
pub mod shell_integration;
pub mod shells;
pub mod ssh;
pub mod state;
pub mod terminal;
pub mod utils;
mod system;

use crate::cli::*;
use crate::command_icons::*;
use crate::file_manager::*;
use crate::fonts::*;
use crate::install_source::*;
use crate::mcp::*;
use crate::proxy::*;
use crate::shells::*;
use crate::ssh::*;
use crate::state::TerminalState;
use crate::system::*;
use crate::terminal::*;
use crate::utils::*;
#[cfg(target_os = "macos")]
use tauri::Emitter;

#[cfg(target_os = "macos")]
const OPEN_ABOUT_EVENT: &str = "lumina-open-about";

#[cfg(target_os = "macos")]
fn configure_about_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{
        Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
    };

    let app_name = app.package_info().name.clone();
    let about_item = MenuItem::with_id(
        app,
        OPEN_ABOUT_EVENT,
        format!("About {app_name}"),
        true,
        None::<&str>,
    )?;
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let help_menu = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;

    let menu = Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                app_name,
                true,
                &[
                    &about_item,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[&PredefinedMenuItem::close_window(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )?;

    app.set_menu(menu)?;

    app.on_menu_event(move |app, event| {
        if event.id() == OPEN_ABOUT_EVENT {
            if let Err(e) = app.emit(OPEN_ABOUT_EVENT, ()) {
                log::error!("Failed to emit About menu event: {e}");
            }
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Parse CLI flags first: --help / --version print and exit here, before any
    // window or logging is set up. macOS LaunchServices `-psn_*` args are
    // filtered inside parse_cli.
    let cli = parse_cli();
    let cli_state = CliState::new(cli);

    #[cfg(target_os = "linux")]
    {
        use std::env;
        env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
        log::info!("Set __NV_DISABLE_EXPLICIT_SYNC to 1 for Linux");
    }

    log::info!("Lumina Terminal starting up");

    let state = TerminalState::default();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("lumina_terminal_lib", log::LevelFilter::Debug)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("lumina-terminal".to_string()),
                    },
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Webview,
                ))
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .max_file_size(1_000_000)
                .build(),
        )
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state)
        .manage(cli_state)
        .manage(McpServerHandle::default())
        .manage(ProxySyncHandle::default())
        .setup(|app| {
            // `app` is only used on macOS to build the native menu bar; on other
            // platforms it's intentionally unused, so allow it.
            #[cfg(target_os = "macos")]
            configure_about_menu(app)?;
            #[cfg(not(target_os = "macos"))]
            let _ = app;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_terminal,
            reattach_terminal,
            kill_terminal,
            write_to_terminal,
            resize_terminal,
            set_output_mode,
            set_throttle,
            get_terminal_cwd,
            set_active_tab,
            report_command_finished,
            start_mcp_server,
            stop_mcp_server,
            start_proxy_sync,
            stop_proxy_sync,
            import_command_icon,
            prune_command_icons,
            list_command_icons,
            find_shells,
            path_exist,
            read_file,
            is_debug,
            is_wayland,
            install_source,
            get_log_dir,
            get_commit_hash,
            parse_ssh_config,
            open_in_file_manager,
            find_font,
            get_cli_args,
            #[cfg(debug_assertions)]
            open_devtools,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            log::error!("Failed to startup Lumina Terminal: {}", e);
            panic!("Failed to startup Lumina Terminal: {}", e);
        });
}
