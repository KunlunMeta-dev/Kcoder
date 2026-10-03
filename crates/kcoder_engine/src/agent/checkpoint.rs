//! Agent checkpoint; state ownership is retained by the agent facade.

use super::*;

pub(crate) async fn write_transcript_checkpoint(
    path: &std::path::Path,
    messages: &[Message],
) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let bytes = serde_json::to_vec_pretty(messages)?;
    let temporary = path.with_extension("json.tmp");
    tokio::fs::write(&temporary, bytes).await?;
    if let Err(error) = tokio::fs::rename(&temporary, path).await {
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(error.into());
        }
        tokio::fs::remove_file(path).await?;
        tokio::fs::rename(&temporary, path).await?;
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
