//! Subagent boundary runtime within the shared engine ownership boundary.

use super::*;

#[async_trait::async_trait]
impl SubagentCheckpointWriter for FilesystemSubagentCheckpointWriter {
    async fn write(&self, path: &Path, messages: &[Message]) -> anyhow::Result<()> {
        crate::agent::write_transcript_checkpoint(path, messages).await
    }
}

pub(super) fn record_structured_memory_session(
    memory_manager: &MemoryManager,
    state: &AppState,
    cwd: &Path,
) {
    if let Err(error) = memory_manager.save_structured_session(MemorySessionInput {
        session_id: state.session_id(),
        project_key: String::new(),
        cwd: cwd.display().to_string(),
        started_at_epoch: current_time_millis(),
    }) {
        warn!("failed to record structured memory session: {error}");
    }
}

impl QueryEngine {
    pub(crate) async fn acquire_subagent_permit(&self) -> Result<OwnedSemaphorePermit, String> {
        self.subagent_semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "sub-agent concurrency limiter closed".to_string())
    }

    /// Apply control state, circuit breaking, and steering at forked-child provider/tool boundaries.
    pub(super) fn prepare_subagent_safe_boundary(&self) -> anyhow::Result<Option<&'static str>> {
        let Some(control) = self.subagent_runtime_control.as_ref() else {
            return Ok(None);
        };
        match control
            .parent_state
            .apply_pending_agent_control_at_safe_boundary(&control.agent_id)?
        {
            kcoder_state::AgentControlBoundaryOutcome::Paused => return Ok(Some("paused")),
            kcoder_state::AgentControlBoundaryOutcome::Halted => return Ok(Some("halted")),
            kcoder_state::AgentControlBoundaryOutcome::Continue => {}
        }
        let settings = recover_read_lock(&self.settings, "settings")
            .orchestrate
            .breaker
            .clone();
        let _ = control
            .parent_state
            .evaluate_agent_breaker(&control.agent_id, &settings)?;
        match control
            .parent_state
            .apply_pending_agent_control_at_safe_boundary(&control.agent_id)?
        {
            kcoder_state::AgentControlBoundaryOutcome::Paused => return Ok(Some("paused")),
            kcoder_state::AgentControlBoundaryOutcome::Halted => return Ok(Some("halted")),
            kcoder_state::AgentControlBoundaryOutcome::Continue => {}
        }
        if let Some(steer) = control.parent_state.pending_agent_steer(&control.agent_id) {
            let marker = format!("[system][breaker_steer id=\"{}\"]", steer.steer_id);
            let exists = self.state.messages().iter().any(|message| match message {
                Message::User { content, .. } => content.iter().any(
                    |block| matches!(block, ContentBlock::Text { text } if text.starts_with(&marker)),
                ),
                Message::Assistant { .. } => false,
            });
            if !exists {
                self.state.add_message(Message::runtime_text(format!(
                    "{marker} Runtime control data: {}",
                    serde_json::to_string(&steer.message)
                        .context("failed to serialize breaker steer")?
                )));
            }
        }
        Ok(None)
    }
}
