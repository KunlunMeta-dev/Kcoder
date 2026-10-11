//! Main-window ownership, focus recovery, tray close/reopen, and application shutdown.

use crate::*;

#[cfg(desktop)]
#[derive(Clone)]
pub(crate) enum MainWindowOpenAction {
    Settings,
    Task(String),
    LocalWorkspace,
}

#[cfg(desktop)]
pub(crate) struct MainWindowLifecycleState {
    pub(crate) dock_icon_visible: AtomicBool,
    pub(crate) destroy_to_tray_in_progress: AtomicBool,
    pub(crate) pending_open_action: Mutex<Option<MainWindowOpenAction>>,
    pub(crate) frontend_recovery_ready: AtomicBool,
    pub(crate) frontend_probe_in_flight: AtomicBool,
    pub(crate) next_frontend_probe_id: AtomicU64,
    pub(crate) acknowledged_frontend_probe_id: AtomicU64,
    pub(crate) last_main_window_unfocused_at: Mutex<Option<std::time::Instant>>,
}

#[cfg(desktop)]
impl Default for MainWindowLifecycleState {
    fn default() -> Self {
        Self {
            dock_icon_visible: AtomicBool::new(true),
            destroy_to_tray_in_progress: AtomicBool::new(false),
            pending_open_action: Mutex::new(None),
            frontend_recovery_ready: AtomicBool::new(false),
            frontend_probe_in_flight: AtomicBool::new(false),
            next_frontend_probe_id: AtomicU64::new(0),
            acknowledged_frontend_probe_id: AtomicU64::new(0),
            last_main_window_unfocused_at: Mutex::new(None),
        }
    }
}

#[cfg(desktop)]
#[derive(Clone, Copy)]
pub(crate) struct MainWindowPlacement {
    pub(crate) position: Option<(i32, i32)>,
    pub(crate) size: Option<(u32, u32)>,
    pub(crate) maximized: bool,
    pub(crate) fullscreen: bool,
}

#[cfg(desktop)]
pub(crate) fn set_dock_icon_visible<R: tauri::Runtime>(app: &tauri::AppHandle<R>, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        let state = app.state::<MainWindowLifecycleState>();
        if state.dock_icon_visible.swap(visible, Ordering::SeqCst) == visible {
            return;
        }
        if let Err(error) = app.set_dock_visibility(visible) {
            state.dock_icon_visible.store(!visible, Ordering::SeqCst);
            log::warn!("Failed to update macOS Dock visibility: {error}");
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
}

#[cfg(desktop)]
pub(crate) fn emit_main_window_open_action<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action: MainWindowOpenAction,
) {
    match action {
        MainWindowOpenAction::Settings => {
            if let Err(error) = app.emit(TRAY_OPEN_SETTINGS_EVENT, ()) {
                log::warn!("Failed to emit tray settings navigation event: {error}");
            }
        }
        MainWindowOpenAction::Task(id) => {
            if let Err(error) = app.emit(TRAY_OPEN_TASK_EVENT, TrayTaskOpenPayload { id }) {
                log::warn!("Failed to emit tray task navigation event: {error}");
            }
        }
        MainWindowOpenAction::LocalWorkspace => {
            if let Err(error) = app.emit(LOCAL_WORKSPACE_OPEN_REQUESTED_EVENT, ()) {
                log::warn!("Failed to emit local workspace open event: {error}");
            }
        }
    }
}

#[cfg(desktop)]
pub(crate) fn emit_pending_main_window_open_action<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<MainWindowLifecycleState>();
    let Ok(mut pending_action) = state.pending_open_action.lock() else {
        return;
    };
    if let Some(action) = pending_action.take() {
        emit_main_window_open_action(app, action);
    }
}

#[cfg(desktop)]
pub(crate) fn main_window_config<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::utils::config::WindowConfig, String> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW_LABEL)
        .cloned()
        .ok_or_else(|| format!("Window config '{MAIN_WINDOW_LABEL}' was not found"))
}

#[cfg(desktop)]
pub(crate) fn create_main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action: Option<MainWindowOpenAction>,
    placement: Option<MainWindowPlacement>,
) -> Result<(), String> {
    {
        let state = app.state::<MainWindowLifecycleState>();
        let mut pending_action = state
            .pending_open_action
            .lock()
            .map_err(|_| "Failed to lock pending main window action".to_string())?;
        *pending_action = action;
    }

    let mut config = main_window_config(app)?;
    let verification = app.state::<ai_verify::GatewayVerification>().0.clone();
    if let Some(session) = &verification {
        config.url = tauri::WebviewUrl::External(session.origin.clone());
    }
    let app_handle = app.clone();
    let mut builder = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|error| format!("Failed to prepare main window: {error}"))?;
    if let Some(session) = verification {
        builder = builder
            .initialization_script(session.initialization_script())
            .on_navigation(move |url| session.allows_navigation(url))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    }
    let window = builder
        .on_page_load(move |_window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                emit_pending_main_window_open_action(&app_handle);
            }
        })
        .build()
        .map_err(|error| format!("Failed to create main window: {error}"))?;
    if let Some(placement) = placement {
        if let Some((x, y)) = placement.position {
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
        if let Some((width, height)) = placement.size {
            let _ = window.set_size(tauri::PhysicalSize::new(width, height));
        }
        if placement.maximized {
            let _ = window.maximize();
        }
        if placement.fullscreen {
            let _ = window.set_fullscreen(true);
        }
    }
    let _ = window.show();
    set_dock_icon_visible(app, true);
    let _ = window.set_focus();
    Ok(())
}

#[cfg(desktop)]
pub(crate) fn ensure_main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action: Option<MainWindowOpenAction>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        set_dock_icon_visible(app, true);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(action) = action {
            emit_main_window_open_action(app, action);
        }
        return Ok(());
    }

    create_main_window(app, action, None)
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn register_frontend_recovery_bridge(app: tauri::AppHandle) {
    app.state::<MainWindowLifecycleState>()
        .frontend_recovery_ready
        .store(true, Ordering::SeqCst);
}

#[cfg(not(desktop))]
#[tauri::command]
pub(crate) fn register_frontend_recovery_bridge() {}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn acknowledge_frontend_resume_probe(app: tauri::AppHandle, probe_id: u64) {
    let state = app.state::<MainWindowLifecycleState>();
    state
        .acknowledged_frontend_probe_id
        .fetch_max(probe_id, Ordering::SeqCst);
}

#[cfg(not(desktop))]
#[tauri::command]
pub(crate) fn acknowledge_frontend_resume_probe(_probe_id: u64) {}

#[cfg(desktop)]
pub(crate) fn should_probe_frontend_after_focus(unfocused_duration: std::time::Duration) -> bool {
    unfocused_duration >= FRONTEND_RESUME_MIN_UNFOCUSED_DURATION
}

#[cfg(desktop)]
pub(crate) fn main_window_placement<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> MainWindowPlacement {
    MainWindowPlacement {
        position: window
            .outer_position()
            .ok()
            .map(|position| (position.x, position.y)),
        size: window
            .outer_size()
            .ok()
            .map(|size| (size.width, size.height)),
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
    }
}

#[cfg(desktop)]
pub(crate) fn recreate_unresponsive_main_window<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let placement = main_window_placement(&window);
    let state = app.state::<MainWindowLifecycleState>();
    state.frontend_recovery_ready.store(false, Ordering::SeqCst);
    state
        .destroy_to_tray_in_progress
        .store(true, Ordering::SeqCst);

    log::warn!("Recreating unresponsive main WebView after resume probe timed out");
    if let Err(error) = window.destroy() {
        state
            .destroy_to_tray_in_progress
            .store(false, Ordering::SeqCst);
        state
            .frontend_probe_in_flight
            .store(false, Ordering::SeqCst);
        state.frontend_recovery_ready.store(true, Ordering::SeqCst);
        log::warn!("Failed to destroy unresponsive main WebView: {error}");
        return;
    }

    std::thread::spawn(move || {
        std::thread::sleep(MAIN_WINDOW_RECREATE_DELAY);
        let app_for_create = app.clone();
        let _ = app.run_on_main_thread(move || {
            let state = app_for_create.state::<MainWindowLifecycleState>();
            if let Err(error) = create_main_window(&app_for_create, None, Some(placement)) {
                log::warn!("Failed to recreate unresponsive main WebView: {error}");
                set_dock_icon_visible(&app_for_create, true);
            }
            state
                .frontend_probe_in_flight
                .store(false, Ordering::SeqCst);
        });
    });
}

#[cfg(desktop)]
pub(crate) fn schedule_frontend_resume_probe<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<MainWindowLifecycleState>();
    if !state.frontend_recovery_ready.load(Ordering::SeqCst)
        || state.frontend_probe_in_flight.swap(true, Ordering::SeqCst)
    {
        return;
    }

    let probe_id = state.next_frontend_probe_id.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        state
            .frontend_probe_in_flight
            .store(false, Ordering::SeqCst);
        return;
    };
    let script = format!("window.{FRONTEND_RESUME_PROBE_FUNCTION}?.({probe_id})");
    if let Err(error) = window.eval(&script) {
        state
            .frontend_probe_in_flight
            .store(false, Ordering::SeqCst);
        log::warn!("Failed to evaluate frontend resume probe: {error}");
        return;
    }
    log::info!("Checking main WebView responsiveness after resume: probe_id={probe_id}");

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FRONTEND_RESUME_PROBE_TIMEOUT);
        let app_for_check = app.clone();
        let _ = app.run_on_main_thread(move || {
            let state = app_for_check.state::<MainWindowLifecycleState>();
            if state.acknowledged_frontend_probe_id.load(Ordering::SeqCst) >= probe_id {
                state
                    .frontend_probe_in_flight
                    .store(false, Ordering::SeqCst);
                log::info!("Main WebView resumed successfully: probe_id={probe_id}");
                return;
            }
            recreate_unresponsive_main_window(app_for_check.clone());
        });
    });
}

#[cfg(desktop)]
pub(crate) fn handle_main_window_focus_for_frontend_recovery<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    focused: bool,
) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }

    let state = window.app_handle().state::<MainWindowLifecycleState>();
    if !focused {
        if let Ok(mut unfocused_at) = state.last_main_window_unfocused_at.lock() {
            *unfocused_at = Some(std::time::Instant::now());
        }
        return;
    }

    let unfocused_duration = state
        .last_main_window_unfocused_at
        .lock()
        .ok()
        .and_then(|mut unfocused_at| unfocused_at.take())
        .map(|unfocused_at| unfocused_at.elapsed());
    if unfocused_duration.is_some_and(should_probe_frontend_after_focus) {
        schedule_frontend_resume_probe(window.app_handle());
    }
}

#[cfg(desktop)]
pub(crate) fn maybe_show_main_window_on_launch(app: &tauri::AppHandle) {
    if read_app_preferences_impl(app).show_main_window_on_launch {
        if let Err(error) = ensure_main_window(app, None) {
            log::warn!("Failed to show main window on launch: {error}");
        }
    } else {
        set_dock_icon_visible(app, false);
    }
}

#[cfg(desktop)]
pub(crate) fn destroy_main_window_to_tray<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let app = window.app_handle();
    let state = app.state::<MainWindowLifecycleState>();
    state
        .destroy_to_tray_in_progress
        .store(true, Ordering::SeqCst);
    if let Err(error) = window.destroy() {
        state
            .destroy_to_tray_in_progress
            .store(false, Ordering::SeqCst);
        set_dock_icon_visible(app, true);
        log::warn!("Failed to destroy main window for tray background mode: {error}");
        return;
    }
    set_dock_icon_visible(app, false);
}

#[cfg(desktop)]
pub(crate) fn hide_main_window_on_close<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    event: &tauri::WindowEvent,
) -> bool {
    if window.label() != MAIN_WINDOW_LABEL {
        return false;
    }

    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let preferences = read_app_preferences_impl(window.app_handle());
        if !preferences.close_to_tray_enabled {
            api.prevent_close();
            shutdown_local_executor_for_app(window.app_handle(), "main_window_close_without_tray");
            window.app_handle().exit(0);
            return true;
        }

        api.prevent_close();
        if !preferences.close_to_tray_hint_seen {
            if let Err(error) = window
                .app_handle()
                .emit(CLOSE_TO_TRAY_HINT_REQUESTED_EVENT, ())
            {
                log::warn!("Failed to emit close-to-tray hint event: {error}");
            }
            return true;
        }
        destroy_main_window_to_tray(window);
        return true;
    }

    false
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn close_main_window_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| format!("WebView window '{MAIN_WINDOW_LABEL}' was not found"))?;
    let state = app.state::<MainWindowLifecycleState>();
    state
        .destroy_to_tray_in_progress
        .store(true, Ordering::SeqCst);
    if let Err(error) = window.destroy() {
        state
            .destroy_to_tray_in_progress
            .store(false, Ordering::SeqCst);
        set_dock_icon_visible(&app, true);
        return Err(format!(
            "Failed to destroy main window for tray background mode: {error}"
        ));
    }
    set_dock_icon_visible(&app, false);
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
pub(crate) fn close_main_window_to_tray(_app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(desktop)]
pub(crate) fn shutdown_local_executor_for_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    reason: &str,
) {
    let state = app.state::<local_executor::LocalExecutorState>();
    local_executor::shutdown_local_executor(&state, reason);
}

#[cfg(desktop)]
pub(crate) fn install_shutdown_signal_handler(app: tauri::AppHandle) -> Result<(), String> {
    ctrlc::set_handler(move || {
        shutdown_local_executor_for_app(&app, "app_shutdown_signal");
        app.exit(130);
    })
    .map_err(|error| format!("Failed to install shutdown signal handler: {error}"))
}
