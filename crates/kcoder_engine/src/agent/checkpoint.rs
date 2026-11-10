//! Agent checkpoint; state ownership is retained by the agent facade.

use super::*;
use anyhow::Context;
use kcoder_state::context_archive::ContextHistoryCheckpoint;

const CONTEXT_HISTORY_FIELD: &str = "kcoderContextHistory";
const MAX_CHECKPOINT_BYTES: u64 = 16 * 1024 * 1024;

pub(super) fn read_checkpoint_context(
    path: &Path,
) -> anyhow::Result<Option<(Vec<Message>, ContextHistoryCheckpoint)>> {
    let parent = path.parent().context("checkpoint has no directory")?;
    if !parent.try_exists()? {
        return Ok(None);
    }
    let directory = kcoder_config::PrivateDirectory::open_existing(parent)?;
    let file = match directory
        .open_single_link_regular_file(path.file_name().context("checkpoint has no name")?)
    {
        Ok(file) => file,
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    anyhow::ensure!(
        file.metadata()?.len() <= MAX_CHECKPOINT_BYTES,
        "private checkpoint exceeds its byte budget"
    );
    let mut bytes = Vec::new();
    file.take(MAX_CHECKPOINT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_CHECKPOINT_BYTES,
        "private checkpoint exceeds its byte budget"
    );
    let value: serde_json::Value = serde_json::from_slice(&bytes)?;
    let Some(reference) = value
        .get(0)
        .and_then(|message| message.get(CONTEXT_HISTORY_FIELD))
    else {
        return Ok(None);
    };
    let reference: ContextHistoryCheckpoint = serde_json::from_value(reference.clone())?;
    let messages: Vec<Message> = serde_json::from_value(value)?;
    reference.validate_messages(&messages)?;
    Ok(Some((messages, reference)))
}

pub(crate) async fn write_transcript_checkpoint(
    path: &std::path::Path,
    messages: &[Message],
) -> anyhow::Result<()> {
    write_checkpoint_projection(path, messages, true, None).await
}

pub(super) async fn write_private_transcript_checkpoint(
    path: &std::path::Path,
    messages: &[Message],
) -> anyhow::Result<()> {
    write_checkpoint_projection(path, messages, false, None).await
}

pub(crate) async fn write_checkpoint_with_context(
    path: &Path,
    messages: &[Message],
    publish: bool,
    reference: Option<&ContextHistoryCheckpoint>,
) -> anyhow::Result<()> {
    write_checkpoint_projection(path, messages, publish, Some(reference.cloned())).await
}

async fn write_checkpoint_projection(
    path: &std::path::Path,
    messages: &[Message],
    publish: bool,
    context: Option<Option<ContextHistoryCheckpoint>>,
) -> anyhow::Result<()> {
    let bytes = if let Some(Some(reference)) = &context {
        reference.validate_messages(messages)?;
        let mut value = serde_json::to_value(messages)?;
        value[0][CONTEXT_HISTORY_FIELD] = serde_json::to_value(reference)?;
        serde_json::to_vec_pretty(&value)?
    } else {
        serde_json::to_vec_pretty(messages)?
    };
    let _publication = if context.is_some() {
        crate::managed_artifacts::write(path, bytes).await?
    } else {
        crate::managed_artifacts::write_with(path, bytes, move |path, bytes| {
            crate::subagent_projection::with_segment(path, || {
                let directory = kcoder_config::PrivateDirectory::open_or_create(
                    path.parent().context("checkpoint has no directory")?,
                )?;
                let encoded = if let Some((_, reference)) = read_checkpoint_context(path)? {
                    let messages: Vec<Message> = serde_json::from_slice(bytes)?;
                    if messages.first().is_some_and(|message| {
                        message.origin() == kcoder_types::MessageOrigin::Compaction
                    }) {
                        let reference = reference.with_messages(&messages)?;
                        let mut value = serde_json::to_value(&messages)?;
                        value[0][CONTEXT_HISTORY_FIELD] = serde_json::to_value(reference)?;
                        serde_json::to_vec_pretty(&value)?
                    } else {
                        bytes.to_vec()
                    }
                } else {
                    bytes.to_vec()
                };
                directory.atomic_replace(
                    path.file_name().context("checkpoint has no name")?,
                    &encoded,
                )
            })
        })
        .await?
    };
    if !publish {
        return Ok(());
    }
    // A failed/cancelled dependent projection remains recoverable through its
    // private receipt baseline. Keep the async gate until this attempt ends.
    if let Err(error) =
        crate::subagent_boundary_runtime::write_public_subagent_transcript(path, messages)
    {
        tracing::warn!("failed to project public subagent transcript: {error}");
    }
    Ok(())
}

pub(super) fn transcript_messages_sha256(messages: &[Message]) -> Result<String, AgentError> {
    let bytes = serde_json::to_vec(messages).map_err(|error| {
        AgentError::Execution(format!("failed to hash sub-agent transcript: {error}"))
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(super) fn is_exact_delivery_message(message: &Message, body: &str) -> bool {
    matches!(
        message,
        Message::User { content, .. }
            if matches!(content.as_slice(), [ContentBlock::Text { text }] if text == body)
    )
}

pub(super) fn completed_delivery_output(
    messages: &[Message],
    delivery_index: usize,
) -> Option<String> {
    if !unmatched_tool_use_ids(messages).is_empty() {
        return None;
    }
    let Message::Assistant { content, .. } = messages.last()? else {
        return None;
    };
    if messages.len() <= delivery_index.saturating_add(1)
        || content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolUse { .. }))
    {
        return None;
    }
    Some(
        content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(""),
    )
}

pub(super) fn latest_assistant_response_text(messages: &[Message]) -> Option<String> {
    messages.iter().rev().find_map(|message| {
        let Message::Assistant { content, .. } = message else {
            return None;
        };
        let text = content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        (!text.trim().is_empty()).then_some(text)
    })
}

pub(crate) fn unmatched_tool_use_ids(messages: &[Message]) -> Vec<String> {
    let mut unmatched = Vec::new();

    for (index, message) in messages.iter().enumerate() {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        let tool_use_ids = content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolUse { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        if tool_use_ids.is_empty() {
            continue;
        }

        let following_tool_results = messages
            .get(index + 1)
            .and_then(|message| match message {
                Message::User { content, .. } => Some(
                    content
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::ToolResult { tool_use_id, .. } => {
                                Some(tool_use_id.as_str())
                            }
                            _ => None,
                        })
                        .collect::<HashSet<_>>(),
                ),
                _ => None,
            })
            .unwrap_or_default();

        unmatched.extend(
            tool_use_ids
                .into_iter()
                .filter(|id| !following_tool_results.contains(id))
                .map(ToOwned::to_owned),
        );
    }

    unmatched
}

struct PrivateNativeSubagentCheckpointWriter;
#[async_trait::async_trait]
impl crate::SubagentCheckpointWriter for PrivateNativeSubagentCheckpointWriter {
    async fn write(&self, path: &Path, messages: &[Message]) -> anyhow::Result<()> {
        write_private_transcript_checkpoint(path, messages).await
    }
    async fn write_with_context(
        &self,
        path: &Path,
        messages: &[Message],
        context: Option<&ContextHistoryCheckpoint>,
    ) -> anyhow::Result<()> {
        write_checkpoint_with_context(path, messages, false, context).await
    }
}
impl QueryEngine {
    pub(super) async fn checkpoint_context_reference(
        &self,
        path: &Path,
        messages: &[Message],
    ) -> anyhow::Result<Option<ContextHistoryCheckpoint>> {
        if !messages
            .first()
            .is_some_and(|message| message.origin() == kcoder_types::MessageOrigin::Compaction)
        {
            return Ok(None);
        }
        let snapshot = self.state.shared_messages_with_revision().0;
        anyhow::ensure!(
            snapshot.len() == messages.len() && snapshot.iter().eq(messages.iter()),
            "context changed before checkpoint capture"
        );
        self.state.flush_history().await?;
        let state = self.state.clone();
        let path = path.to_path_buf();
        let messages = snapshot;
        tokio::task::spawn_blocking(move || state.context_history_checkpoint(&path, &messages))
            .await
            .context("context checkpoint capture worker stopped")?
    }

    pub(super) async fn write_context_checkpoint(
        &self,
        path: &Path,
        messages: &[Message],
        publish: bool,
    ) -> anyhow::Result<()> {
        let reference = self.checkpoint_context_reference(path, messages).await?;
        write_checkpoint_with_context(path, messages, publish, reference.as_ref()).await
    }

    pub(crate) fn with_private_native_child_checkpoints(mut self) -> Self {
        if let Some(mut control) = self.subagent_runtime_control.as_ref().clone() {
            control.checkpoint_writer = Arc::new(PrivateNativeSubagentCheckpointWriter);
            self.subagent_runtime_control = Arc::new(Some(control));
        }
        self
    }
}
