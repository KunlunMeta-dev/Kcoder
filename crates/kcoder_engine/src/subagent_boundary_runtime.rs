//! Subagent boundary runtime within the shared engine ownership boundary.

use super::*;

pub(crate) const PUBLIC_TRANSCRIPT_HEADER: &[u8] = b"<!-- kcoder-public-transcript:v2 -->\n";

/// Public transcript projection. Thinking, signatures, images and synthesized
/// runtime/compaction text never enter this artifact; tool results remain public. The private recovery
/// checkpoint remains authoritative and is never returned as a fallback.
pub(crate) fn public_subagent_transcript(messages: &[Message]) -> anyhow::Result<Vec<u8>> {
    use std::io::Write;
    let mut public = PUBLIC_TRANSCRIPT_HEADER.to_vec();
    for message in messages {
        let (role, content) = match message {
            Message::User { content, .. } => ("user", content),
            Message::Assistant { content, .. } => ("assistant", content),
        };
        for block in content {
            match block {
                ContentBlock::Text { text } => {
                    if role == "user"
                        && matches!(
                            message.origin(),
                            kcoder_types::MessageOrigin::Runtime
                                | kcoder_types::MessageOrigin::Compaction
                        )
                    {
                        continue;
                    }
                    if role == "user" && message.origin() == kcoder_types::MessageOrigin::Unknown {
                        // Legacy text does not establish provenance. Preserve
                        // the private original while omitting an ambiguous body
                        // instead of guessing whether a prefix is a user input.
                        writeln!(
                            public,
                            "[legacy user body omitted: provenance unavailable]\n"
                        )?;
                    } else {
                        writeln!(public, "[{role}]\n{text}\n")?;
                    }
                }
                ContentBlock::ToolUse { id, name, input } => {
                    writeln!(public, "[tool/start {id}] {name}")?;
                    serde_json::to_writer(&mut public, input)?;
                    public.extend_from_slice(b"\n\n");
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => {
                    writeln!(
                        public,
                        "[tool/result {tool_use_id}] {}",
                        if *is_error == Some(true) {
                            "error"
                        } else {
                            "completed"
                        }
                    )?;
                    // Nested non-text blocks are not public output. In particular,
                    // never serialize the full block to accidentally disclose thinking.
                    for output in content {
                        if let ContentBlock::Text { text } = output {
                            writeln!(public, "{text}")?;
                        }
                    }
                    public.push(b'\n');
                }
                _ => {}
            }
        }
    }
    Ok(public)
}

/// Shared checkpoint code calls this after writing the private checkpoint.
/// Handle-relative replacement preserves private permissions and atomicity on
/// Unix and Windows; failure leaves the previous public artifact intact.
pub(crate) fn write_public_subagent_transcript(
    path: &Path,
    messages: &[Message],
) -> anyhow::Result<()> {
    crate::subagent_projection::publish(path, &public_subagent_transcript(messages)?)
}

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
    /// Upgrade obsolete public projections without returning the private checkpoint.
    pub fn ensure_public_subagent_transcript(&self, agent_id: &str) -> anyhow::Result<()> {
        let task = self.state.task(agent_id).context("agent does not exist")?;
        anyhow::ensure!(
            task.kind == kcoder_state::TaskKind::Subagent
                && task.parent_session_id.as_deref() == Some(self.session_id().as_str()),
            "agent does not belong to this thread"
        );
        // An untracked legacy projection can contain newer safe-boundary
        // progress than the checkpoint. Only an explicit terminal state makes
        // rebuilding such an unknown baseline safe.
        let preserve_unknown = !matches!(
            task.status,
            kcoder_state::TaskStatus::Completed
                | kcoder_state::TaskStatus::Failed
                | kcoder_state::TaskStatus::Cancelled
                | kcoder_state::TaskStatus::Halted
        );
        crate::subagent_projection::ensure(
            &self.state.subagent_transcript_path(agent_id),
            preserve_unknown,
            task.status == kcoder_state::TaskStatus::Running,
        )
    }

    pub fn can_stop_subagent_run(&self, expected: &kcoder_types::BackgroundRunKey) -> bool {
        expected.parent_session_id == self.session_id()
            && self.state.task(&expected.agent_id).is_some_and(|task| {
                task.kind == kcoder_state::TaskKind::Subagent
                    && task.parent_session_id.as_deref()
                        == Some(expected.parent_session_id.as_str())
                    && task.delivery == kcoder_state::TaskDelivery::Background
                    && task.background_run.as_ref() == Some(expected)
            })
            && self
                .background_jobs
                .has_live_run(&expected.agent_id, expected)
    }

    /// Stop exactly the viewed background worker through its existing bounded
    /// cancellation/cleanup implementation. No sibling or newly resumed run is targeted.
    pub async fn stop_subagent_run(
        &self,
        expected: &kcoder_types::BackgroundRunKey,
    ) -> anyhow::Result<bool> {
        self.background_jobs
            .abort_and_wait_for_run(&expected.agent_id, expected)
            .await
    }

    /// Migrate a legacy private checkpoint to a public presentation artifact.
    /// Conversion has a strict input budget and never exposes raw checkpoint bytes.
    pub fn materialize_public_subagent_transcript(&self, agent_id: &str) -> anyhow::Result<()> {
        let task = self.state.task(agent_id).context("agent does not exist")?;
        anyhow::ensure!(
            task.kind == kcoder_state::TaskKind::Subagent
                && task.parent_session_id.as_deref() == Some(self.session_id().as_str()),
            "agent does not belong to this thread"
        );
        crate::subagent_projection::materialize(&self.state.subagent_transcript_path(agent_id))
    }

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
        // Publish completed public messages/tools at every safe boundary, even
        // when no new steering command was pending. Streaming activity itself
        // is projected by the host; this snapshot is its reconnect baseline.
        if let Err(error) =
            write_public_subagent_transcript(&control.transcript_path, &self.state.messages())
        {
            warn!("failed to project subagent boundary activity: {error}");
        }
        Ok(None)
    }
}

#[cfg(test)]
mod public_transcript_tests {
    use super::*;

    #[test]
    fn public_projection_includes_tools_and_user_commands_without_private_blocks() {
        let messages = vec![
            Message::runtime_text("secret system reminder"),
            Message::compaction_text("secret recovery data"),
            Message::user_text("adjust the goal"),
            Message::user_text("[system] literal user content"),
            Message::User {
                origin: kcoder_types::MessageOrigin::Unknown,
                content: vec![ContentBlock::Text {
                    text: "private unclassified legacy body".into(),
                }],
            },
            Message::Assistant {
                usage: None,
                content: vec![
                    ContentBlock::Thinking {
                        thinking: "hidden thought".into(),
                        signature: "private signature".into(),
                    },
                    ContentBlock::RedactedThinking {
                        data: "private redaction".into(),
                    },
                    ContentBlock::Text {
                        text: "public progress".into(),
                    },
                    ContentBlock::ToolUse {
                        id: "tool-1".into(),
                        name: "Read".into(),
                        input: serde_json::json!({"path":"src/main.rs"}),
                    },
                ],
            },
            Message::user_content(vec![ContentBlock::ToolResult {
                tool_use_id: "tool-1".into(),
                is_error: None,
                content: vec![
                    ContentBlock::Text {
                        text: "public result".into(),
                    },
                    ContentBlock::Thinking {
                        thinking: "nested hidden".into(),
                        signature: String::new(),
                    },
                ],
            }])
            .with_origin(kcoder_types::MessageOrigin::Runtime),
        ];
        let output = String::from_utf8(public_subagent_transcript(&messages).unwrap()).unwrap();
        for expected in [
            "adjust the goal",
            "[system] literal user content",
            "public progress",
            "Read",
            "src/main.rs",
            "public result",
        ] {
            assert!(output.contains(expected));
        }
        for hidden in ["secret", "hidden", "private"] {
            assert!(!output.contains(hidden));
        }
    }
}
