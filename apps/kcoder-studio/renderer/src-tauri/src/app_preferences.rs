//! Preference wire types, defaults, normalization, persistence, and native commands.

use crate::*;

#[cfg(desktop)]
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppPreferences {
    #[serde(default = "default_true")]
    pub(crate) close_to_tray_enabled: bool,
    #[serde(default = "default_true")]
    pub(crate) show_main_window_on_launch: bool,
    #[serde(default = "default_true")]
    pub(crate) system_drag_enabled: bool,
    #[serde(default = "default_true")]
    pub(crate) prevent_sleep_while_tasks_running: bool,
    #[serde(default)]
    pub(crate) close_to_tray_hint_seen: bool,
    #[serde(default = "default_language_preference")]
    pub(crate) language: String,
    #[serde(default = "default_true")]
    pub(crate) terminal_context_injection_enabled: bool,
    #[serde(default)]
    pub(crate) experimental_features_enabled: bool,
    #[serde(default)]
    pub(crate) task_completion_notifications_enabled: bool,
    #[serde(default = "default_true")]
    pub(crate) tray_unread_enabled: bool,
    #[serde(default = "default_true")]
    pub(crate) tray_running_enabled: bool,
    #[serde(default = "default_true")]
    pub(crate) tray_usage_enabled: bool,
    #[serde(default = "default_browser_external_link_target")]
    pub(crate) browser_external_link_target: String,
    #[serde(default = "default_browser_local_link_target")]
    pub(crate) browser_local_link_target: String,
    #[serde(default)]
    pub(crate) browser_download_directory: Option<String>,
    #[serde(default)]
    pub(crate) browser_ask_before_download: bool,
    #[serde(default = "default_true")]
    pub(crate) appshots_play_sound: bool,
    #[serde(default = "default_quick_phrases")]
    pub(crate) quick_phrases: Vec<QuickPhrase>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuickPhrase {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) content: String,
    pub(crate) mode: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) attachment_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) created_at: Option<u64>,
}

pub(crate) fn default_quick_phrases() -> Vec<QuickPhrase> {
    vec![
        QuickPhrase {
            id: "default-summary-progress".into(),
            title: "总结当前进展".into(),
            content: "总结目前完成的工作和下一步建议".into(),
            mode: "normal".into(),
            attachment_paths: Vec::new(),
            created_at: None,
        },
        QuickPhrase {
            id: "default-create-plan".into(),
            title: "制定实施计划".into(),
            content: "分析需求并制定详细的实施计划".into(),
            mode: "plan".into(),
            attachment_paths: Vec::new(),
            created_at: None,
        },
        QuickPhrase {
            id: "default-pursue-goal".into(),
            title: "持续完成这个目标".into(),
            content: "持续推进这个目标，直到真正完成".into(),
            mode: "goal".into(),
            attachment_paths: Vec::new(),
            created_at: None,
        },
    ]
}

#[cfg(desktop)]
pub(crate) fn default_true() -> bool {
    true
}

#[cfg(desktop)]
pub(crate) fn default_language_preference() -> String {
    "zh-CN".to_string()
}

#[cfg(desktop)]
pub(crate) fn default_browser_external_link_target() -> String {
    "system".to_string()
}

#[cfg(desktop)]
pub(crate) fn default_browser_local_link_target() -> String {
    "studio".to_string()
}

#[cfg(desktop)]
impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            close_to_tray_enabled: true,
            show_main_window_on_launch: true,
            system_drag_enabled: true,
            prevent_sleep_while_tasks_running: true,
            close_to_tray_hint_seen: false,
            language: default_language_preference(),
            terminal_context_injection_enabled: true,
            experimental_features_enabled: false,
            task_completion_notifications_enabled: false,
            tray_unread_enabled: true,
            tray_running_enabled: true,
            tray_usage_enabled: true,
            browser_external_link_target: default_browser_external_link_target(),
            browser_local_link_target: default_browser_local_link_target(),
            browser_download_directory: None,
            browser_ask_before_download: false,
            appshots_play_sound: true,
            quick_phrases: default_quick_phrases(),
        }
    }
}

#[cfg(desktop)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppPreferencesPatch {
    pub(crate) close_to_tray_enabled: Option<bool>,
    pub(crate) show_main_window_on_launch: Option<bool>,
    pub(crate) system_drag_enabled: Option<bool>,
    pub(crate) prevent_sleep_while_tasks_running: Option<bool>,
    pub(crate) close_to_tray_hint_seen: Option<bool>,
    pub(crate) language: Option<String>,
    pub(crate) terminal_context_injection_enabled: Option<bool>,
    pub(crate) experimental_features_enabled: Option<bool>,
    pub(crate) task_completion_notifications_enabled: Option<bool>,
    pub(crate) tray_unread_enabled: Option<bool>,
    pub(crate) tray_running_enabled: Option<bool>,
    pub(crate) tray_usage_enabled: Option<bool>,
    pub(crate) browser_external_link_target: Option<String>,
    pub(crate) browser_local_link_target: Option<String>,
    pub(crate) browser_download_directory: Option<String>,
    pub(crate) browser_ask_before_download: Option<bool>,
    pub(crate) appshots_play_sound: Option<bool>,
    pub(crate) quick_phrases: Option<Vec<QuickPhrase>>,
}

#[cfg(desktop)]
pub(crate) fn app_preferences_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<std::path::PathBuf, String> {
    if let Some(directory) = std::env::var("KCODER_STUDIO_APP_CONFIG_DIR")
        .ok()
        .and_then(normalized_non_empty)
    {
        return Ok(std::path::PathBuf::from(directory).join(APP_PREFERENCES_FILE_NAME));
    }
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Failed to locate app config directory: {error}"))?
        .join(APP_PREFERENCES_FILE_NAME))
}

#[cfg(desktop)]
pub(crate) fn read_app_preferences_impl<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> AppPreferences {
    let Ok(path) = app_preferences_path(app) else {
        return AppPreferences::default();
    };
    let Ok(content) = std::fs::read_to_string(path) else {
        return AppPreferences::default();
    };
    let Ok(preferences) = serde_json::from_str::<AppPreferences>(&content) else {
        return AppPreferences::default();
    };
    let stored_phrase_count = preferences.quick_phrases.len();
    let preferences = normalize_app_preferences(preferences);
    if preferences.quick_phrases.len() < stored_phrase_count {
        if let Err(error) = write_app_preferences_impl(app, &preferences) {
            log::warn!("Failed to persist expired quick phrase stash cleanup: {error}");
        }
    }
    preferences
}

#[cfg(desktop)]
pub(crate) fn normalize_app_preferences(mut preferences: AppPreferences) -> AppPreferences {
    preferences.browser_external_link_target = normalized_browser_link_target(
        preferences.browser_external_link_target,
        &default_browser_external_link_target(),
    );
    preferences.browser_local_link_target = normalized_browser_link_target(
        preferences.browser_local_link_target,
        &default_browser_local_link_target(),
    );
    preferences.browser_download_directory = preferences
        .browser_download_directory
        .and_then(normalized_non_empty);
    preferences
        .quick_phrases
        .retain(|phrase| !is_expired_quick_phrase_stash(phrase));
    preferences
}

#[cfg(desktop)]
pub(crate) fn is_expired_quick_phrase_stash(phrase: &QuickPhrase) -> bool {
    const STASH_MAX_AGE_MILLIS: u64 = 7 * 24 * 60 * 60 * 1_000;

    if !phrase.id.starts_with("stash-") {
        return false;
    }
    let created_at = phrase.created_at.or_else(|| {
        phrase
            .id
            .strip_prefix("stash-")?
            .split('-')
            .next()?
            .parse::<u64>()
            .ok()
    });
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    created_at.is_some_and(|timestamp| now.saturating_sub(timestamp) >= STASH_MAX_AGE_MILLIS)
}

#[cfg(desktop)]
pub(crate) fn write_app_preferences_impl<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    preferences: &AppPreferences,
) -> Result<(), String> {
    let path = app_preferences_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create app config directory: {error}"))?;
    }
    let content = serde_json::to_string_pretty(preferences)
        .map_err(|error| format!("Failed to serialize app preferences: {error}"))?;
    std::fs::write(path, content)
        .map_err(|error| format!("Failed to write app preferences: {error}"))
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn get_app_preferences(app: tauri::AppHandle) -> Result<AppPreferences, String> {
    Ok(read_app_preferences_impl(&app))
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn update_app_preferences(
    app: tauri::AppHandle,
    patch: AppPreferencesPatch,
) -> Result<AppPreferences, String> {
    let mut preferences = read_app_preferences_impl(&app);
    if let Some(value) = patch.close_to_tray_enabled {
        preferences.close_to_tray_enabled = value;
    }
    if let Some(value) = patch.show_main_window_on_launch {
        preferences.show_main_window_on_launch = value;
    }
    if let Some(value) = patch.system_drag_enabled {
        preferences.system_drag_enabled = value;
    }
    if let Some(value) = patch.prevent_sleep_while_tasks_running {
        preferences.prevent_sleep_while_tasks_running = value;
    }
    if let Some(value) = patch.close_to_tray_hint_seen {
        preferences.close_to_tray_hint_seen = value;
    }
    if let Some(value) = patch.language {
        preferences.language = value;
    }
    if let Some(value) = patch.terminal_context_injection_enabled {
        preferences.terminal_context_injection_enabled = value;
    }
    if let Some(value) = patch.experimental_features_enabled {
        preferences.experimental_features_enabled = value;
    }
    if let Some(value) = patch.task_completion_notifications_enabled {
        preferences.task_completion_notifications_enabled = value;
    }
    if let Some(value) = patch.tray_unread_enabled {
        preferences.tray_unread_enabled = value;
    }
    if let Some(value) = patch.tray_running_enabled {
        preferences.tray_running_enabled = value;
    }
    if let Some(value) = patch.tray_usage_enabled {
        preferences.tray_usage_enabled = value;
    }
    if let Some(value) = patch.browser_external_link_target {
        preferences.browser_external_link_target = value;
    }
    if let Some(value) = patch.browser_local_link_target {
        preferences.browser_local_link_target = value;
    }
    if let Some(value) = patch.browser_download_directory {
        preferences.browser_download_directory = normalized_non_empty(value);
    }
    if let Some(value) = patch.browser_ask_before_download {
        preferences.browser_ask_before_download = value;
    }
    preferences = normalize_app_preferences(preferences);
    if let Some(value) = patch.appshots_play_sound {
        preferences.appshots_play_sound = value;
    }
    if let Some(value) = patch.quick_phrases {
        preferences.quick_phrases = value;
    }
    write_app_preferences_impl(&app, &preferences)?;
    app.state::<system_sleep::SystemSleepState>()
        .set_enabled(preferences.prevent_sleep_while_tasks_running);
    Ok(preferences)
}

#[cfg(not(desktop))]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppPreferences {
    pub(crate) close_to_tray_enabled: bool,
    pub(crate) show_main_window_on_launch: bool,
    pub(crate) system_drag_enabled: bool,
    pub(crate) prevent_sleep_while_tasks_running: bool,
    pub(crate) close_to_tray_hint_seen: bool,
    pub(crate) language: String,
    pub(crate) terminal_context_injection_enabled: bool,
    pub(crate) experimental_features_enabled: bool,
    pub(crate) task_completion_notifications_enabled: bool,
    pub(crate) tray_unread_enabled: bool,
    pub(crate) tray_running_enabled: bool,
    pub(crate) tray_usage_enabled: bool,
    pub(crate) browser_external_link_target: String,
    pub(crate) browser_local_link_target: String,
    pub(crate) browser_download_directory: Option<String>,
    pub(crate) browser_ask_before_download: bool,
    pub(crate) appshots_play_sound: bool,
    pub(crate) quick_phrases: Vec<QuickPhrase>,
}

#[cfg(not(desktop))]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppPreferencesPatch {
    pub(crate) close_to_tray_enabled: Option<bool>,
    pub(crate) show_main_window_on_launch: Option<bool>,
    pub(crate) system_drag_enabled: Option<bool>,
    pub(crate) prevent_sleep_while_tasks_running: Option<bool>,
    pub(crate) close_to_tray_hint_seen: Option<bool>,
    pub(crate) language: Option<String>,
    pub(crate) terminal_context_injection_enabled: Option<bool>,
    pub(crate) experimental_features_enabled: Option<bool>,
    pub(crate) task_completion_notifications_enabled: Option<bool>,
    pub(crate) tray_unread_enabled: Option<bool>,
    pub(crate) tray_running_enabled: Option<bool>,
    pub(crate) tray_usage_enabled: Option<bool>,
    pub(crate) browser_external_link_target: Option<String>,
    pub(crate) browser_local_link_target: Option<String>,
    pub(crate) browser_download_directory: Option<String>,
    pub(crate) browser_ask_before_download: Option<bool>,
    pub(crate) appshots_play_sound: Option<bool>,
    pub(crate) quick_phrases: Option<Vec<QuickPhrase>>,
}

#[cfg(not(desktop))]
#[tauri::command]
pub(crate) fn get_app_preferences(_app: tauri::AppHandle) -> Result<AppPreferences, String> {
    Ok(AppPreferences {
        close_to_tray_enabled: true,
        show_main_window_on_launch: true,
        system_drag_enabled: true,
        prevent_sleep_while_tasks_running: true,
        close_to_tray_hint_seen: false,
        language: "zh-CN".to_string(),
        terminal_context_injection_enabled: true,
        experimental_features_enabled: false,
        task_completion_notifications_enabled: false,
        tray_unread_enabled: true,
        tray_running_enabled: true,
        tray_usage_enabled: true,
        browser_external_link_target: "system".to_string(),
        browser_local_link_target: "studio".to_string(),
        browser_download_directory: None,
        browser_ask_before_download: false,
        appshots_play_sound: true,
        quick_phrases: default_quick_phrases(),
    })
}

#[cfg(not(desktop))]
#[tauri::command]
pub(crate) fn update_app_preferences(
    _app: tauri::AppHandle,
    patch: AppPreferencesPatch,
) -> Result<AppPreferences, String> {
    Ok(AppPreferences {
        close_to_tray_enabled: patch.close_to_tray_enabled.unwrap_or(true),
        show_main_window_on_launch: patch.show_main_window_on_launch.unwrap_or(true),
        system_drag_enabled: patch.system_drag_enabled.unwrap_or(true),
        prevent_sleep_while_tasks_running: patch.prevent_sleep_while_tasks_running.unwrap_or(true),
        close_to_tray_hint_seen: patch.close_to_tray_hint_seen.unwrap_or(false),
        language: patch.language.unwrap_or_else(|| "zh-CN".to_string()),
        terminal_context_injection_enabled: patch
            .terminal_context_injection_enabled
            .unwrap_or(true),
        experimental_features_enabled: patch.experimental_features_enabled.unwrap_or(false),
        task_completion_notifications_enabled: patch
            .task_completion_notifications_enabled
            .unwrap_or(false),
        tray_unread_enabled: patch.tray_unread_enabled.unwrap_or(true),
        tray_running_enabled: patch.tray_running_enabled.unwrap_or(true),
        tray_usage_enabled: patch.tray_usage_enabled.unwrap_or(true),
        browser_external_link_target: patch
            .browser_external_link_target
            .map(|value| normalized_browser_link_target(value, "system"))
            .unwrap_or_else(|| "system".to_string()),
        browser_local_link_target: patch
            .browser_local_link_target
            .map(|value| normalized_browser_link_target(value, "studio"))
            .unwrap_or_else(|| "studio".to_string()),
        browser_download_directory: patch
            .browser_download_directory
            .and_then(normalized_non_empty),
        browser_ask_before_download: patch.browser_ask_before_download.unwrap_or(false),
        appshots_play_sound: patch.appshots_play_sound.unwrap_or(true),
        quick_phrases: patch.quick_phrases.unwrap_or_else(default_quick_phrases),
    })
}

pub(crate) fn normalized_non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) fn normalized_browser_link_target(value: String, fallback: &str) -> String {
    match value.trim() {
        "system" => "system".to_string(),
        "studio" => "studio".to_string(),
        _ => fallback.to_string(),
    }
}
