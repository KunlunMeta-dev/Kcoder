//! Thread requests support: extracted from the app-server connection boundary.

use super::*;

#[cfg(test)]
pub(super) use kcoder_turn_lifecycle::admission::prompt_from_params;

pub(super) fn ensure_active_thread(
    engine: &QueryEngine,
    session_lease: Option<&SessionLease>,
    thread_id: &str,
) -> Result<()> {
    if thread_id != engine.session_id() {
        anyhow::bail!("threadId does not match the active thread")
    }
    if !session_lease.is_some_and(|lease| lease.matches_target(&engine.session_lease_target())) {
        anyhow::bail!("thread/start or thread/resume is required")
    }
    Ok(())
}
