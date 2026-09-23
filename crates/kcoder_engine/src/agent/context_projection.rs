use crate::QueryEngine;
use kcoder_tools::{AgentError, SubagentContextMode};
use kcoder_types::{ContentBlock, Message};

/// Stable parent state captured at a completed request boundary for later
/// sub-agent forks.
///
/// A child rebuilds its system prompt, tools, permissions, model settings, and
/// runtime context from the live parent when it starts. The provider/model
/// identity below is retained only as a compatibility guard for `full`
/// inheritance, whose reasoning signatures and wire-protocol blocks cannot be
/// safely replayed after a provider or model switch.
#[derive(Debug, Clone)]
pub struct CacheSafeParams {
    pub fork_context_messages: kcoder_types::SharedMessages,
    pub active_skills: Vec<String>,
    pub snapshot_provider: String,
    pub snapshot_model: String,
    /// False when the snapshot belongs to a mixed-runtime turn (currently
    /// MoA), where no single provider/model identity can safely own every
    /// reasoning and tool-protocol block required by `full` inheritance.
    pub full_context_compatible: bool,
}

pub(super) fn initial_agent_messages(
    cache_safe: &CacheSafeParams,
    prompt: String,
    context_mode: SubagentContextMode,
    context_turns: usize,
) -> Vec<Message> {
    let mut messages = project_parent_messages(
        &cache_safe.fork_context_messages,
        context_mode,
        context_turns,
    );
    messages.push(Message::user_text(prompt));
    messages
}

pub(super) fn validate_full_context_compatibility(
    parent: &QueryEngine,
    cache_safe: &CacheSafeParams,
    context_mode: SubagentContextMode,
) -> Result<(), AgentError> {
    if context_mode != SubagentContextMode::Full {
        return Ok(());
    }
    if !cache_safe.full_context_compatible {
        return Err(AgentError::Execution(
            "context_mode=full is unavailable for a snapshot captured during an active MoA aggregator turn because it may contain mixed-runtime reasoning or tool-protocol blocks; use context_mode=semantic or recent, or complete a normal parent turn to capture a compatible snapshot"
                .to_string(),
        ));
    }
    let current_provider = parent.provider_name();
    let current_model = parent.model_name();
    if cache_safe.snapshot_provider == current_provider
        && cache_safe.snapshot_model == current_model
    {
        return Ok(());
    }
    Err(AgentError::Execution(format!(
        "context_mode=full cannot replay a snapshot captured with provider/model `{}/{}` after the live parent switched to `{}/{}`; use context_mode=semantic or recent, or run a new parent turn to capture a compatible snapshot",
        cache_safe.snapshot_provider, cache_safe.snapshot_model, current_provider, current_model
    )))
}

pub(super) fn project_parent_messages<'a>(
    messages: impl IntoIterator<
        Item = &'a Message,
        IntoIter: Clone + ExactSizeIterator + DoubleEndedIterator,
    >,
    context_mode: SubagentContextMode,
    context_turns: usize,
) -> Vec<Message> {
    let messages = messages.into_iter();
    match context_mode {
        SubagentContextMode::Auto | SubagentContextMode::Semantic => {
            semantic_parent_messages(messages)
        }
        SubagentContextMode::None => Vec::new(),
        SubagentContextMode::Recent => {
            let Some(start) = recent_parent_start(messages.clone(), context_turns) else {
                return Vec::new();
            };
            semantic_parent_messages(messages.skip(start))
        }
        SubagentContextMode::Full => messages.cloned().collect(),
    }
}

pub(crate) fn recent_parent_start<'a>(
    messages: impl IntoIterator<Item = &'a Message, IntoIter: ExactSizeIterator + DoubleEndedIterator>,
    context_turns: usize,
) -> Option<usize> {
    let mut remaining = context_turns.max(1);
    let mut start = None;
    for (index, message) in messages.into_iter().enumerate().rev() {
        if is_real_user_message(message) {
            start = Some(index);
            remaining -= 1;
            if remaining == 0 {
                break;
            }
        }
    }
    start
}

pub use kcoder_types::is_real_user_message;
pub(crate) use kcoder_types::is_synthetic_parent_text;

fn is_compact_summary_text(text: &str) -> bool {
    let text = text.trim_start();
    text.starts_with(
        "This session is being continued from a previous conversation that ran out of context.",
    ) || text.starts_with("Earlier conversation summary:")
}

fn semantic_parent_messages<'a>(messages: impl IntoIterator<Item = &'a Message>) -> Vec<Message> {
    messages
        .into_iter()
        .filter_map(|message| match message {
            Message::User { content } => {
                if content
                    .iter()
                    .any(|block| matches!(block, ContentBlock::ToolResult { .. }))
                {
                    return None;
                }
                let content = content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text }
                            if !text.trim().is_empty()
                                && (!is_synthetic_parent_text(text)
                                    || is_compact_summary_text(text)) =>
                        {
                            Some(ContentBlock::Text { text: text.clone() })
                        }
                        ContentBlock::Image { source } => Some(ContentBlock::Image {
                            source: source.clone(),
                        }),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                (!content.is_empty()).then_some(Message::User { content })
            }
            Message::Assistant { content, .. } => {
                if content
                    .iter()
                    .any(|block| matches!(block, ContentBlock::ToolUse { .. }))
                {
                    return None;
                }
                let content = content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } if !text.trim().is_empty() => {
                            Some(ContentBlock::Text { text: text.clone() })
                        }
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                (!content.is_empty()).then_some(Message::Assistant {
                    content,
                    usage: None,
                })
            }
        })
        .collect()
}
