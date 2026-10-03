mod ai_verify;
mod appshots;
mod desktop_capture;
mod embedded_browser;
#[cfg(desktop)]
mod feedback;
mod local_executor;
mod local_terminal;
mod process_diagnostics;
mod process_environment;
mod system_drag;
mod system_sleep;
mod todo_store;
mod workbench_background;

use std::collections::HashSet;
#[cfg(desktop)]
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::Manager;

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuBuilder, MenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, WebviewWindowBuilder,
};

#[cfg(desktop)]
use tauri::webview::PageLoadEvent;

mod commands;
use commands::clipboard::*;
use commands::workspace_paths::*;
mod app_constants;
use app_constants::*;
use commands::logs::*;
mod app_preferences;
use app_preferences::*;
mod app_lifecycle;
use app_lifecycle::*;
use commands::attachments::*;
use commands::cli_install::*;
use commands::executor_discovery::*;
use commands::window::*;
use commands::workspace_files::*;
use commands::workspace_open::*;
mod tray_menu;
use tray_menu::*;
mod tray_icons;
// Windows keeps these helpers for platform-parity tests.
#[allow(unused_imports)]
use tray_icons::*;

#[cfg(test)]
#[path = "native_tests.rs"]
mod tests;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let verification = ai_verify::GatewayVerification::from_environment()
        .expect("invalid explicit Gateway verification configuration");
    let builder = tauri::Builder::default()
        .manage(verification)
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init());

    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

                if event.state == ShortcutState::Pressed
                    && shortcut.matches(Modifiers::SUPER | Modifiers::SHIFT, Code::Digit2)
                {
                    appshots::handle_shortcut(app);
                }
            })
            .build(),
    );

    #[cfg(all(desktop, not(debug_assertions)))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        let action = if let Some(request) = parse_local_workspace_open_request(&argv) {
            queue_local_workspace_open_request(app, request);
            Some(MainWindowOpenAction::LocalWorkspace)
        } else {
            None
        };
        if let Err(error) = ensure_main_window(app, action) {
            log::warn!("Failed to open main window from single-instance activation: {error}");
        }
    }));

    let app = builder
        .manage(appshots::AppshotState::default())
        .manage(embedded_browser::EmbeddedBrowserState::default())
        .manage(MainWindowLifecycleState::default())
        .manage(LocalWorkspaceOpenState::default())
        .manage(TrayVisualState::default())
        .manage(local_executor::LocalExecutorState::default())
        .manage(local_terminal::LocalTerminalState::default())
        .manage(system_drag::SystemDragState::default())
        .manage(system_sleep::SystemSleepState::default())
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            {
                if let tauri::WindowEvent::Focused(focused) = event {
                    handle_main_window_focus_for_frontend_recovery(window, *focused);
                }
                if hide_main_window_on_close(window, event) {
                    return;
                }
            }
        })
        .setup(|app| {
            #[cfg(desktop)]
            if app.state::<ai_verify::GatewayVerification>().0.is_some() {
                // Verification never installs a CLI link, shortcuts, tray, or local executor.
                create_main_window(app.handle(), None, None).map_err(std::io::Error::other)?;
                install_shutdown_signal_handler(app.handle().clone())
                    .map_err(std::io::Error::other)?;
                return Ok(());
            }
            #[cfg(desktop)]
            if app
                .config()
                .plugins
                .0
                .get("updater")
                .is_some_and(|config| config.is_object())
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }

            #[cfg(desktop)]
            app.handle()
                .plugin(create_log_plugin(app.handle()).map_err(std::io::Error::other)?)?;

            #[cfg(desktop)]
            println!(
                "Wework app PID={} log dir={}",
                std::process::id(),
                get_app_log_directory(app.handle().clone()).unwrap_or_else(|error| error)
            );

            log::info!(
                "Wework app PID={} logs are written to {}",
                std::process::id(),
                get_app_log_directory(app.handle().clone()).unwrap_or_else(|error| error)
            );

            #[cfg(desktop)]
            setup_system_tray(app)?;
            #[cfg(desktop)]
            app.state::<system_sleep::SystemSleepState>().set_enabled(
                read_app_preferences_impl(app.handle()).prevent_sleep_while_tasks_running,
            );
            #[cfg(desktop)]
            system_drag::setup(app.handle().clone());
            #[cfg(desktop)]
            appshots::setup(app.handle());
            #[cfg(desktop)]
            match install_studio_cli_link(app.handle()) {
                Ok(path) => log::info!("Installed Wework CLI launcher: {}", path.display()),
                Err(error) => log::warn!("{error}"),
            }
            #[cfg(desktop)]
            if let Some(request) =
                parse_local_workspace_open_request(&std::env::args().collect::<Vec<_>>())
            {
                queue_local_workspace_open_request(app.handle(), request);
                if let Err(error) =
                    ensure_main_window(app.handle(), Some(MainWindowOpenAction::LocalWorkspace))
                {
                    log::warn!("Failed to open main window for local workspace request: {error}");
                }
            } else {
                maybe_show_main_window_on_launch(app.handle());
            }
            #[cfg(desktop)]
            install_shutdown_signal_handler(app.handle().clone()).map_err(std::io::Error::other)?;
            #[cfg(desktop)]
            if let Err(error) =
                embedded_browser::start_embedded_browser_bridge(app.handle().clone())
            {
                log::warn!("Failed to start embedded browser bridge: {error}");
            }
            #[cfg(desktop)]
            if env_flag_enabled(WEBVIEW_DEVTOOLS_ENV) {
                if let Err(error) = open_main_webview_devtools_impl(app.handle()) {
                    log::warn!("Failed to open Web Inspector from {WEBVIEW_DEVTOOLS_ENV}: {error}");
                }
            }
            Ok(())
        })
        .invoke_handler({
            let handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
                Box::new(tauri::generate_handler![
                    appshots::acknowledge_appshot,
                    appshots::get_appshots_status,
                    appshots::open_appshots_permission_settings,
                    appshots::take_pending_appshots,
                    desktop_capture::capture_main_webview,
                    acknowledge_frontend_resume_probe,
                    register_frontend_recovery_bridge,
                    #[cfg(desktop)]
                    feedback::export_feedback_bundle,
                    embedded_browser::embedded_browser_close,
                    embedded_browser::embedded_browser_clear_data,
                    embedded_browser::embedded_browser_delete_download,
                    embedded_browser::embedded_browser_eval,
                    embedded_browser::embedded_browser_eval_json,
                    embedded_browser::embedded_browser_go_back,
                    embedded_browser::embedded_browser_go_forward,
                    embedded_browser::embedded_browser_navigate,
                    embedded_browser::embedded_browser_open,
                    embedded_browser::embedded_browser_pause_download,
                    embedded_browser::embedded_browser_page_state,
                    embedded_browser::embedded_browser_reload,
                    embedded_browser::embedded_browser_relabel,
                    embedded_browser::embedded_browser_resume_download,
                    embedded_browser::embedded_browser_set_bounds,
                    local_terminal::close_local_terminal,
                    workbench_background::import_workbench_background,
                    workbench_background::remove_workbench_background,
                    pick_workspace_paths,
                    read_clipboard_workspace_paths,
                    read_dropped_workspace_paths,
                    inspect_workspace_paths,
                    get_local_executor_device_id,
                    local_executor::local_executor_connect_backend,
                    local_executor::local_executor_copy_debug_info,
                    local_executor::local_executor_codex_home_migration_status,
                    local_executor::local_executor_disconnect_backend,
                    local_executor::local_executor_ensure_started,
                    local_executor::local_executor_initialize_codex_home,
                    local_executor::local_executor_import_external_content,
                    local_executor::local_executor_migrate_native_codex_home,
                    local_executor::local_executor_read_codex_local_config,
                    local_executor::local_executor_read_log,
                    local_executor::local_executor_request,
                    local_executor::local_executor_status,
                    local_executor::local_executor_update_codex_local_config,
                    get_app_log_directory,
                    get_app_preferences,
                    close_main_window_to_tray,
                    open_app_log_directory,
                    process_diagnostics::get_wework_process_snapshot,
                    open_main_webview_devtools,
                    install_studio_cli,
                    take_pending_local_workspace_open_requests,
                    set_tray_menu_state,
                    update_app_preferences,
                    download_local_file_to_downloads,
                    save_text_file_to_downloads,
                    local_path_exists,
                    get_local_path_kind,
                    open_local_file,
                    reveal_local_file,
                    list_local_file_openers,
                    open_local_file_with_application,
                    get_local_file_opener_icon,
                    open_local_workspace,
                    read_dropped_files,
                    save_local_attachment_file,
                    todo_store::ensure_todo_work_directory,
                    todo_store::ensure_todo_workspace,
                    todo_store::get_todo_workspace_path,
                    todo_store::list_todo_workspace,
                    todo_store::load_todo_store,
                    todo_store::save_todo_store,
                    todo_store::delete_todo_workspace_entry,
                    todo_store::rename_todo_workspace_entry,
                    todo_store::write_todo_workspace_file,
                    system_drag::complete_system_drag_drop,
                    system_drag::dismiss_system_drag_panel,
                    system_drag::log_system_drag_debug,
                    system_drag::take_pending_system_drag_drops,
                    local_terminal::resize_local_terminal,
                    local_terminal::start_local_terminal,
                    local_terminal::write_local_terminal
                ]);
            move |invoke| {
                if invoke
                    .message
                    .webview()
                    .state::<ai_verify::GatewayVerification>()
                    .0
                    .is_some()
                {
                    invoke
                        .resolver
                        .reject("Native commands are disabled in Gateway verification");
                    return true;
                }
                handler(invoke)
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(desktop)]
        match event {
            tauri::RunEvent::Resumed => {
                if app_handle
                    .get_webview_window(MAIN_WINDOW_LABEL)
                    .and_then(|window| window.is_focused().ok())
                    .unwrap_or(false)
                {
                    schedule_frontend_resume_probe(app_handle);
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                if let Err(error) = ensure_main_window(app_handle, None) {
                    log::warn!("Failed to reopen main window from macOS activation: {error}");
                }
            }
            tauri::RunEvent::ExitRequested { api, .. } => {
                let lifecycle = app_handle.state::<MainWindowLifecycleState>();
                if lifecycle.destroy_to_tray_in_progress.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    lifecycle
                        .destroy_to_tray_in_progress
                        .store(false, Ordering::SeqCst);
                    return;
                }
                shutdown_local_executor_for_app(app_handle, "run_event_exit_requested");
            }
            tauri::RunEvent::Exit => {
                shutdown_local_executor_for_app(app_handle, "run_event_exit");
            }
            _ => {}
        }
    });
}
