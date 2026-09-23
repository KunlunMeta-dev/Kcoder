//! Provider-error continuation from committed context, never from a replayed user prompt.
use anyhow::{Result, ensure};
use kcoder_types::{ContentBlock, Message};
use std::collections::HashSet;

pub(super) fn context_hash(messages: &[Message]) -> Result<String> {
    ensure!(!messages.is_empty(), "No committed context to continue");
    let mut pending = HashSet::new();
    for message in messages {
        let content = match message {
            Message::User { content } | Message::Assistant { content, .. } => content,
        };
        for block in content {
            match block {
                ContentBlock::ToolUse { id, .. } => {
                    ensure!(
                        pending.insert(id.as_str()),
                        "Duplicate unresolved tool call"
                    );
                }
                ContentBlock::ToolResult { tool_use_id, .. } => {
                    // Old compacted histories may retain results without their original call.
                    pending.remove(tool_use_id.as_str());
                }
                _ => {}
            }
        }
    }
    ensure!(
        pending.is_empty(),
        "Tool outcome is unknown; cannot safely continue automatically"
    );
    Ok(super::hex_sha256(&serde_json::to_vec(messages)?))
}

pub(super) fn validate(
    engine: &kcoder_engine::QueryEngine,
    turn_id: &str,
    latest_turn: usize,
) -> Result<()> {
    ensure!(
        turn_id == format!("turn-{latest_turn}"),
        "Only the latest failed turn can be continued"
    );
    let outcomes = super::load_turn_outcomes(engine, &engine.session_id());
    let outcome = outcomes
        .get(turn_id)
        .ok_or_else(|| anyhow::anyhow!("This turn has no pending failure to continue"))?;
    ensure!(
        outcome.status == "failed" && outcome.provider_failure.is_some(),
        "Only a failed model generation can be continued"
    );
    let expected = outcome
        .continuation_context_hash
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("This failure has no safe continuation checkpoint"))?;
    ensure!(
        context_hash(&engine.state.messages())? == expected,
        "Conversation context changed after failure; continuation is no longer safe"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_preserves_completed_tool_results_but_rejects_unknown_outcomes() {
        let mut messages = vec![
            Message::user_text("write once"),
            Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "call-1".into(),
                    name: "Write".into(),
                    input: serde_json::json!({}),
                }],
                usage: None,
            },
        ];
        assert!(context_hash(&messages).is_err());
        messages.push(Message::user_content(vec![ContentBlock::ToolResult {
            tool_use_id: "call-1".into(),
            content: vec![ContentBlock::Text {
                text: "done".into(),
            }],
            is_error: None,
        }]));
        let hash = context_hash(&messages).unwrap();
        assert_eq!(
            hash,
            context_hash(
                &serde_json::from_slice::<Vec<Message>>(&serde_json::to_vec(&messages).unwrap())
                    .unwrap()
            )
            .unwrap()
        );
        messages.push(Message::user_text("new request"));
        assert_ne!(hash, context_hash(&messages).unwrap());
    }
}
