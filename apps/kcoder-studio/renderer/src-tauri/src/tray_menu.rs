//! Tray state, menu actions, task groups, setup and visual update commands.

use crate::*;

#[cfg(desktop)]
pub(crate) fn open_settings_from_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Err(error) = ensure_main_window(app, Some(MainWindowOpenAction::Settings)) {
        log::warn!("Failed to open settings from tray: {error}");
    }
}

#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
pub(crate) struct TrayTaskOpenPayload {
    pub(crate) id: String,
}

#[cfg(desktop)]
pub(crate) fn open_task_from_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>, task_id: &str) {
    if let Err(error) =
        ensure_main_window(app, Some(MainWindowOpenAction::Task(task_id.to_string())))
    {
        log::warn!("Failed to open task from tray: {error}");
    }
}

#[cfg(desktop)]
pub(crate) fn quit_from_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    shutdown_local_executor_for_app(app, "tray_quit");
    app.exit(0);
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrayMenuTaskItem {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) project_name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrayMenuStatePayload {
    pub(crate) language: String,
    pub(crate) usage_title: Option<String>,
    pub(crate) usage_tooltip: Option<String>,
    pub(crate) running: Vec<TrayMenuTaskItem>,
    pub(crate) running_more: Vec<TrayMenuTaskItem>,
    pub(crate) unread: Vec<TrayMenuTaskItem>,
    pub(crate) unread_more: Vec<TrayMenuTaskItem>,
    pub(crate) running_count: usize,
    #[serde(default)]
    pub(crate) active_task_ids: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) show_running_status: bool,
    #[serde(default)]
    pub(crate) unread_count: usize,
    pub(crate) pinned: Vec<TrayMenuTaskItem>,
    pub(crate) pinned_more: Vec<TrayMenuTaskItem>,
    pub(crate) recent: Vec<TrayMenuTaskItem>,
    pub(crate) recent_more: Vec<TrayMenuTaskItem>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TrayVisualSignature {
    pub(crate) usage_title: Option<String>,
    pub(crate) running_count: usize,
    pub(crate) show_running_status: bool,
    pub(crate) unread_count: usize,
}

impl TrayVisualSignature {
    pub(crate) fn from_payload(state: &TrayMenuStatePayload) -> Self {
        Self {
            usage_title: state.usage_title.clone(),
            running_count: state.running_count,
            show_running_status: state.show_running_status,
            unread_count: state.unread_count,
        }
    }
}

#[derive(Default)]
pub(crate) struct TrayVisualState {
    pub(crate) signature: std::sync::Mutex<Option<TrayVisualSignature>>,
}

#[cfg(desktop)]
impl TrayMenuStatePayload {
    pub(crate) fn empty(language: &str) -> Self {
        Self {
            language: language.to_string(),
            usage_title: None,
            usage_tooltip: None,
            running: Vec::new(),
            running_more: Vec::new(),
            unread: Vec::new(),
            unread_more: Vec::new(),
            running_count: 0,
            active_task_ids: None,
            show_running_status: false,
            unread_count: 0,
            pinned: Vec::new(),
            pinned_more: Vec::new(),
            recent: Vec::new(),
            recent_more: Vec::new(),
        }
    }
}

#[cfg(desktop)]
#[derive(Clone, Copy)]
pub(crate) enum TrayLanguage {
    ZhCn,
    En,
}

#[cfg(desktop)]
impl TrayLanguage {
    pub(crate) fn from_language(language: &str) -> Self {
        if language.trim().to_lowercase().starts_with("en") {
            Self::En
        } else {
            Self::ZhCn
        }
    }

    pub(crate) fn labels(self) -> TrayMenuLabels {
        match self {
            Self::ZhCn => TrayMenuLabels {
                running: "运行中",
                unread_completed: "未读完成",
                pinned: "置顶",
                tasks: "任务",
                untitled_task: "未命名任务",
                no_pinned_tasks: "暂无置顶任务",
                no_tasks: "暂无任务",
                more: "更多",
                open: "打开应用",
                settings: "设置",
                quit: "退出应用",
            },
            Self::En => TrayMenuLabels {
                running: "Running",
                unread_completed: "Unread Completed",
                pinned: "Pinned",
                tasks: "Tasks",
                untitled_task: "Untitled Task",
                no_pinned_tasks: "No Pinned Tasks",
                no_tasks: "No Tasks",
                more: "More",
                open: "Open App",
                settings: "Settings",
                quit: "Quit App",
            },
        }
    }
}

#[cfg(desktop)]
pub(crate) struct TrayMenuLabels {
    pub(crate) running: &'static str,
    pub(crate) unread_completed: &'static str,
    pub(crate) pinned: &'static str,
    pub(crate) tasks: &'static str,
    pub(crate) untitled_task: &'static str,
    pub(crate) no_pinned_tasks: &'static str,
    pub(crate) no_tasks: &'static str,
    pub(crate) more: &'static str,
    pub(crate) open: &'static str,
    pub(crate) settings: &'static str,
    pub(crate) quit: &'static str,
}

#[cfg(desktop)]
pub(crate) struct TrayTaskSection<'a> {
    pub(crate) title: &'a str,
    pub(crate) empty_text: &'a str,
    pub(crate) items: &'a [TrayMenuTaskItem],
    pub(crate) more_items: &'a [TrayMenuTaskItem],
    pub(crate) always_visible: bool,
}

#[cfg(desktop)]
pub(crate) fn build_system_tray_menu<M: Manager<tauri::Wry>>(
    manager: &M,
    state: &TrayMenuStatePayload,
) -> tauri::Result<Menu<tauri::Wry>> {
    let labels = TrayLanguage::from_language(&state.language).labels();
    let mut builder = MenuBuilder::new(manager);

    builder = append_tray_task_section(
        builder,
        manager,
        labels.untitled_task,
        labels.more,
        TrayTaskSection {
            title: labels.unread_completed,
            empty_text: "",
            items: &state.unread,
            more_items: &state.unread_more,
            always_visible: false,
        },
    )?;
    builder = append_tray_task_section(
        builder,
        manager,
        labels.untitled_task,
        labels.more,
        TrayTaskSection {
            title: labels.running,
            empty_text: "",
            items: &state.running,
            more_items: &state.running_more,
            always_visible: false,
        },
    )?;
    builder = append_tray_task_section(
        builder,
        manager,
        labels.untitled_task,
        labels.more,
        TrayTaskSection {
            title: labels.pinned,
            empty_text: labels.no_pinned_tasks,
            items: &state.pinned,
            more_items: &state.pinned_more,
            always_visible: true,
        },
    )?;
    builder = append_tray_task_section(
        builder,
        manager,
        labels.untitled_task,
        labels.more,
        TrayTaskSection {
            title: labels.tasks,
            empty_text: labels.no_tasks,
            items: &state.recent,
            more_items: &state.recent_more,
            always_visible: true,
        },
    )?;

    builder
        .text(TRAY_MENU_OPEN_ID, labels.open)
        .separator()
        .text(TRAY_MENU_SETTINGS_ID, labels.settings)
        .separator()
        .text(TRAY_MENU_QUIT_ID, labels.quit)
        .build()
}

#[cfg(desktop)]
pub(crate) fn append_tray_task_section<'m, M: Manager<tauri::Wry>>(
    mut builder: MenuBuilder<'m, tauri::Wry, M>,
    manager: &M,
    untitled_task: &str,
    more: &str,
    section: TrayTaskSection<'_>,
) -> tauri::Result<MenuBuilder<'m, tauri::Wry, M>> {
    if section.items.is_empty() && section.more_items.is_empty() && !section.always_visible {
        return Ok(builder);
    }

    let heading = MenuItem::new(manager, section.title, false, None::<&str>)?;
    builder = builder.item(&heading);

    if section.items.is_empty() && section.more_items.is_empty() {
        let empty_item = MenuItem::new(manager, section.empty_text, false, None::<&str>)?;
        builder = builder.item(&empty_item);
    } else {
        for item in section.items {
            let title = normalized_menu_task_title(item, untitled_task);
            builder = builder.text(format!("{TRAY_MENU_TASK_PREFIX}{}", item.id), title);
        }
        if !section.more_items.is_empty() {
            let mut submenu = SubmenuBuilder::new(manager, more);
            for item in section.more_items {
                let title = normalized_menu_task_title(item, untitled_task);
                submenu = submenu.text(format!("{TRAY_MENU_TASK_PREFIX}{}", item.id), title);
            }
            let submenu = submenu.build()?;
            builder = builder.item(&submenu);
        }
    }

    Ok(builder.separator())
}

#[cfg(desktop)]
pub(crate) fn normalized_menu_task_title(item: &TrayMenuTaskItem, fallback: &str) -> String {
    let title = item.title.trim();
    let project_name = item.project_name.trim();
    if title.is_empty() {
        return fallback.to_string();
    }
    if project_name.is_empty() {
        title.to_string()
    } else {
        format!("{title} - {project_name}")
    }
}

#[cfg(desktop)]
pub(crate) fn setup_system_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = build_system_tray_menu(app, &TrayMenuStatePayload::empty("zh-CN"))?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("WeWork")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                if let Err(error) = ensure_main_window(tray.app_handle(), None) {
                    log::warn!("Failed to open main window from tray click: {error}");
                }
            }
            _ => {}
        })
        .on_menu_event(|app, event| {
            let event_id = event.id().as_ref();
            match event_id {
                TRAY_MENU_OPEN_ID => {
                    if let Err(error) = ensure_main_window(app, None) {
                        log::warn!("Failed to open main window from tray menu: {error}");
                    }
                }
                TRAY_MENU_SETTINGS_ID => open_settings_from_tray(app),
                TRAY_MENU_QUIT_ID => quit_from_tray(app),
                _ => {
                    if let Some(task_id) = event_id.strip_prefix(TRAY_MENU_TASK_PREFIX) {
                        open_task_from_tray(app, task_id);
                    }
                }
            }
        });

    #[cfg(target_os = "macos")]
    {
        tray = tray.icon_as_template(true);
        if let Some(icon) = tray_status_icon(app.default_window_icon(), 0, false, 0) {
            tray = tray.icon(icon);
        }
    }
    #[cfg(target_os = "windows")]
    {
        let icon = match tauri::image::Image::from_bytes(WINDOWS_TRAY_ICON_BYTES) {
            Ok(icon) => Some(icon),
            Err(error) => {
                log::warn!("Failed to load embedded Windows tray icon: {error}");
                app.default_window_icon().map(|icon| icon.to_owned())
            }
        };
        if let Some(icon) = icon {
            tray = tray.icon(icon);
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(icon) = tray_status_icon(app.default_window_icon(), 0, false, 0) {
            tray = tray.icon(icon);
        }
    }

    tray.build(app)?;
    Ok(())
}

#[cfg(desktop)]
pub(crate) fn update_tray_visual<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    tray: &tauri::tray::TrayIcon<R>,
    state: &TrayMenuStatePayload,
) -> Result<(), String> {
    let signature = TrayVisualSignature::from_payload(state);
    let visual_state = app.state::<TrayVisualState>();
    let mut cached_signature = visual_state
        .signature
        .lock()
        .map_err(|error| format!("Failed to read tray visual state: {error}"))?;
    if cached_signature.as_ref() == Some(&signature) {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    let icon = state
        .usage_title
        .as_deref()
        .and_then(|title| {
            tray_usage_icon(
                title,
                app.default_window_icon(),
                state.running_count,
                state.show_running_status,
                state.unread_count,
            )
        })
        .or_else(|| {
            tray_status_icon(
                app.default_window_icon(),
                state.running_count,
                state.show_running_status,
                state.unread_count,
            )
        });
    #[cfg(target_os = "windows")]
    let icon = match tauri::image::Image::from_bytes(WINDOWS_TRAY_ICON_BYTES) {
        Ok(icon) => Some(icon),
        Err(error) => {
            log::warn!("Failed to load embedded Windows tray icon: {error}");
            app.default_window_icon().map(|icon| icon.to_owned())
        }
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let icon = tray_status_icon(
        app.default_window_icon(),
        state.running_count,
        state.show_running_status,
        state.unread_count,
    );
    if let Some(icon) = icon {
        tray.set_icon_with_as_template(Some(icon), cfg!(target_os = "macos"))
            .map_err(|error| format!("Failed to update tray icon: {error}"))?;
    }
    tray.set_title(None::<&str>)
        .map_err(|error| format!("Failed to clear tray title: {error}"))?;
    *cached_signature = Some(signature);
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn set_tray_menu_state(
    app: tauri::AppHandle,
    state: TrayMenuStatePayload,
) -> Result<(), String> {
    if let Some(active_task_ids) = &state.active_task_ids {
        app.state::<system_sleep::SystemSleepState>()
            .set_running_tasks(active_task_ids.clone());
    }
    let menu = build_system_tray_menu(&app, &state)
        .map_err(|error| format!("Failed to build tray menu: {error}"))?;
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    tray.set_menu(Some(menu))
        .map_err(|error| format!("Failed to update tray menu: {error}"))?;
    update_tray_visual(&app, &tray, &state)?;
    if let Err(error) = tray.set_tooltip(state.usage_tooltip.as_deref().or(Some("WeWork"))) {
        log::warn!("Failed to update tray tooltip: {error}");
    }
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
pub(crate) fn set_tray_menu_state(_state: TrayMenuStatePayload) -> Result<(), String> {
    Ok(())
}
