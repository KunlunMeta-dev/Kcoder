//! Startup notices and bounded debug welcome messages.

use super::*;

pub(super) fn seed_startup_messages(app: &mut ReplApp, startup_notice: Option<String>) {
    app.render_welcome_component();
    if let Some(notice) = startup_notice {
        app.push_message(MessageRole::System, notice);
    }
    if let Some(message) = debug_startup_a_lines_message_from_env() {
        app.push_message(MessageRole::System, message);
    }
}

pub(super) fn debug_startup_a_lines_message_from_env() -> Option<String> {
    let raw = std::env::var(DEBUG_STARTUP_A_LINES_ENV).ok()?;
    debug_startup_a_lines_message(&raw)
}

pub(super) fn debug_startup_a_lines_message(raw: &str) -> Option<String> {
    let count = raw.trim().parse::<usize>().ok()?;
    if count == 0 {
        return None;
    }
    Some(vec!["a"; count.min(DEBUG_STARTUP_A_LINES_MAX)].join("\n"))
}
