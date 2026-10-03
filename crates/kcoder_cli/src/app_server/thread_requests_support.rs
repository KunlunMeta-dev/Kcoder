//! Thread requests support: extracted from the app-server connection boundary.

use super::*;

pub(super) fn prompt_from_params(params: &Value) -> Option<String> {
    if let Some(prompt) = params.get("prompt").and_then(Value::as_str) {
        return (!prompt.trim().is_empty()).then(|| prompt.to_string());
    }
    params
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
        .into_non_empty()
}

impl IntoNonEmpty for String {
    fn into_non_empty(self) -> Option<String> {
        (!self.is_empty()).then_some(self)
    }
}

pub(super) fn ensure_active_thread(
    engine: &QueryEngine,
    session_lease: Option<&SessionLease>,
    thread_id: &str,
) -> Result<()> {
    if thread_id != engine.session_id() {
        anyhow::bail!("threadId does not match the active thread")
    }
    if !session_lease.is_some_and(|lease| lease.matches_engine(engine)) {
        anyhow::bail!("thread/start or thread/resume is required")
    }
    Ok(())
}
