//! System-tray ("close to tray") support. The tray's lifecycle is owned by
//! the frontend: the config (and its language, which localizes the menu
//! labels) lives there, so `set_tray_enabled` is a stateless, idempotent
//! rebuild-or-remove the frontend calls on config load / hot-reload. With the
//! tray on, closing the main window merely hides it (hooks/
//! useSessionPersistence.ts intercepts the close), so every PTY in
//! TerminalState — and the commands running in them — stays alive until the
//! user quits from the tray.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

/// Tray-id PREFIX (ids are `lumina-main-<generation>` — see `TRAY_STATE` for
/// why each build mints a fresh id instead of reusing one).
pub const TRAY_ID: &str = "lumina-main";

/// Broadcast to every webview when the user picks "Quit" in the tray menu.
/// Each window's close handler (hooks/useSessionPersistence.ts) reacts by
/// force-closing through its normal session-save flow; once the last window
/// is destroyed the app exits (ExitRequested is never prevented).
pub const TRAY_QUIT_EVENT: &str = "lumina-tray-quit";

/// Menu-item ids for the handlers in `enable_tray` below.
const MENU_SHOW: &str = "lumina-tray-show";
const MENU_QUIT: &str = "lumina-tray-quit";

/// Localized menu labels, sent from the frontend (translations live there).
#[derive(serde::Deserialize, Clone, PartialEq)]
pub struct TrayLabels {
    pub show: String,
    pub quit: String,
}

/// Current tray generation + its labels. The Linux backend (libappindicator)
/// derives its DBus object path from the tray id and NEVER unregisters the
/// object on drop — so rebuilding with the same id collides ("object already
/// exported"). Each (re)build therefore mints a FRESH id ("lumina-main-<n>")
/// and this state remembers which generation is live so remove/disable can
/// target it. The labels are kept so a same-labels re-enable is a no-op
/// (repeated effect runs, webview reloads) instead of an icon flicker.
static TRAY_STATE: Mutex<Option<(u32, TrayLabels)>> = Mutex::new(None);
static TRAY_SEQ: AtomicU32 = AtomicU32::new(1);

/// Tray id for a generation counter.
fn tray_id_str(gen: u32) -> String {
    format!("{TRAY_ID}-{gen}")
}

/// Normalize a frontend-supplied menu label: trim it, and fall back when it
/// is empty so a missing translation never renders a blank menu row. Pure —
/// tested in tests/tray.rs.
pub fn sanitize_label(label: &str, fallback: &str) -> String {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Show + focus the main window. Shared by the tray menu/click handlers and
/// the macOS Dock reopen event (lib.rs). Logs failures so a silent no-op
/// never hides a real problem.
pub fn show_main(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(w) => {
            if let Err(e) = w.show() {
                log::warn!("Tray: failed to show main window: {}", e);
            }
            // Restore a minimized window too — show() alone leaves it in the
            // taskbar/dock and set_focus then has nothing visible to focus.
            if let Err(e) = w.unminimize() {
                log::warn!("Tray: failed to unminimize main window: {}", e);
            }
            if let Err(e) = w.set_focus() {
                log::warn!("Tray: failed to focus main window: {}", e);
            }
        }
        None => log::warn!("Tray: main window not found, cannot show"),
    }
}

/// Show the main window only when it is hidden — used when the tray is
/// disabled while the window sits in the tray, so the app never strands an
/// invisible window with no tray icon left to recover it.
fn show_main_if_hidden(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(w) => match w.is_visible() {
            Ok(true) => {}
            Ok(false) => show_main(app),
            Err(e) => log::warn!("Tray: failed to read main window visibility: {}", e),
        },
        None => log::warn!("Tray: main window not found, cannot unhide"),
    }
}

/// Config-driven tray lifecycle (thin command wrapper; the build half lives
/// in `enable_tray` per §3.7). `enabled=true` (re)builds the tray;
/// `enabled=false` removes it and, if a tray actually existed and the main
/// window is currently hidden in it, shows the window again.
///
/// Everything runs ON THE MAIN THREAD: the Linux tray backend
/// (libappindicator/GTK) is not thread-safe from arbitrary invoke-handler
/// threads — off the main thread the DBus export gets queued on a
/// thread-local GMainContext that the app loop never iterates, so the icon
/// silently never registers with the StatusNotifierWatcher.
#[tauri::command]
pub fn set_tray_enabled(app: AppHandle, enabled: bool, labels: TrayLabels) -> Result<(), String> {
    app.clone().run_on_main_thread(move || {
        let outcome = apply_tray_state(&app, enabled, &labels);
        match outcome {
            Ok(()) => {
                if enabled {
                    log::info!("Tray enabled");
                }
            }
            Err(e) => log::error!("Tray {} failed: {}", if enabled { "enable" } else { "disable" }, e),
        }
    })
    .map_err(|e| format!("dispatch to main thread: {e}"))
}

/// The actual tray state transition — MUST be called on the main thread (see
/// `set_tray_enabled`). Errors are returned for the caller to log.
fn apply_tray_state(app: &AppHandle, enabled: bool, labels: &TrayLabels) -> Result<(), String> {
    let mut state = TRAY_STATE
        .lock()
        .map_err(|_| "tray state lock poisoned".to_string())?;

    if !enabled {
        // Only act when a tray exists: at startup the frontend calls this
        // with false, and unconditionally showing the window there would
        // race the startup show gate (windows spawn hidden until sized).
        if let Some((gen, _)) = state.take() {
            app.remove_tray_by_id(&tray_id_str(gen));
            log::info!("Tray removed");
            show_main_if_hidden(app);
        }
        return Ok(());
    }

    // Same labels as the live generation → nothing to do. Rebuilding would
    // flicker the icon and mint a fresh DBus registration for no reason.
    if let Some((_, last)) = state.as_ref() {
        if *last == *labels {
            return Ok(());
        }
    }

    // Drop the previous instance, then build with a FRESH id (a stale DBus
    // registration stays behind on Linux — see TRAY_STATE — so reusing the
    // id would collide).
    if let Some((gen, _)) = state.take() {
        app.remove_tray_by_id(&tray_id_str(gen));
    }
    let gen = TRAY_SEQ.fetch_add(1, Ordering::Relaxed);
    enable_tray(app, labels, gen)?;
    *state = Some((gen, labels.clone()));
    Ok(())
}

/// Build the tray icon (id `lumina-main-<gen>`) + its menu. Errors surface
/// as `Err(String)` for the frontend's invoke logging; menu handlers act via
/// `show_main` / the quit broadcast. Removing any previous instance is the
/// caller's job (see `apply_tray_state`).
fn enable_tray(app: &AppHandle, labels: &TrayLabels, gen: u32) -> Result<(), String> {
    let show_item = MenuItem::with_id(
        app,
        MENU_SHOW,
        sanitize_label(&labels.show, "Show Lumina"),
        true,
        None::<&str>,
    )
    .map_err(|e| format!("show menu item: {e}"))?;
    let quit_item = MenuItem::with_id(
        app,
        MENU_QUIT,
        sanitize_label(&labels.quit, "Quit"),
        true,
        None::<&str>,
    )
    .map_err(|e| format!("quit menu item: {e}"))?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])
        .map_err(|e| format!("menu build: {e}"))?;

    let mut builder = TrayIconBuilder::with_id(tray_id_str(gen))
        .menu(&menu)
        // Left-click shows the window on Windows/Linux; the menu opens on
        // right-click (and on left-click on macOS, the platform convention).
        .show_menu_on_left_click(false)
        .tooltip("Lumina Terminal")
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_SHOW => show_main(app),
            MENU_QUIT => {
                if let Err(e) = app.emit(TRAY_QUIT_EVENT, ()) {
                    log::error!("Tray: failed to emit quit event: {}", e);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    // The bundle icon is embedded at compile time, so no runtime PNG
    // decoding (and no extra image-* feature) is needed for it.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    } else {
        log::warn!("Tray: no embedded window icon; the OS default is used");
    }

    builder.build(app).map(|_| ()).map_err(|e| format!("tray build: {e}"))
}
