//! Settle rejected tool input before the provider retry loop regenerates it.
use crate::EngineEvent;
use kcoder_state::AppState;
use kcoder_tools::ToolOutput;
use kcoder_types::{ContentBlock, Message, MessageOrigin, Usage};
use serde_json::Value;
use std::collections::HashSet;

const NOT_EXECUTED: &str =
    "Tool was not executed: this response's tool arguments were rejected before dispatch.";
const AMBIGUOUS: &str = "Tool request identity is ambiguous. This response was rejected before dispatch; prior results must be reconciled, and no operation is replayed.";
fn regenerate_prompt() -> String {
    format!(
        "<system-reminder>The preceding model response had invalid, incomplete, or oversized tool argument JSON. No tools in that response were executed. Continue from the recorded results of earlier responses; do not repeat operations that already have results. Regenerate only still-needed calls with valid, complete JSON matching the attached schemas and keep oversized calls smaller. Preserve the user's required paths and task constraints. The write tool's content replaces the entire file and accepts at most {write_limit} UTF-8 bytes. Do not send consecutive write calls as if they append chunks, and do not invent an append parameter. Create a small complete scaffold if appropriate, then use the target's actually attached edit/apply_patch capability for small additions or modifications, following that capability's real schema. Do not bypass limits with another tool or guess an earlier operation's outcome.</system-reminder>",
        write_limit = kcoder_tools::write::MAX_WRITE_CONTENT_BYTES
    )
}

pub(super) struct ToolArgumentFailure {
    pub error: kcoder_api::ApiErrorKind,
    pub message: String,
    pub can_regenerate: bool,
    pub preserve_candidate: bool,
}

impl ToolArgumentFailure {
    pub(super) fn protocol(message: String, can_regenerate: bool) -> Self {
        Self {
            error: kcoder_api::ApiErrorKind::Api {
                error_type: "protocol_error".into(),
                message: message.clone(),
            },
            message,
            can_regenerate,
            preserve_candidate: true,
        }
    }
}
pub(super) struct RejectionPolicy {
    pub retry_allowed: bool,
    pub response_committed: bool,
    pub preserve_candidate: bool,
}
pub(super) struct RejectedResponse {
    pub events: Vec<EngineEvent>,
    pub regenerate: bool,
}
fn calls<'a>(
    blocks: &'a [ContentBlock],
    complete: &'a [(String, String, Value)],
) -> Vec<(&'a str, &'a str)> {
    let mut seen = HashSet::new();
    let mut calls = Vec::new();
    for block in blocks {
        if let ContentBlock::ToolUse { id, name, .. } = block
            && seen.insert(id.as_str())
        {
            calls.push((id.as_str(), name.as_str()));
        }
    }
    for (id, name, _) in complete {
        if seen.insert(id.as_str()) {
            calls.push((id.as_str(), name.as_str()));
        }
    }
    calls
}
/// Called before this response's tool batch is dispatched.
pub(super) fn settle_before_dispatch(
    blocks: &[ContentBlock],
    complete: &[(String, String, Value)],
) -> Vec<EngineEvent> {
    calls(blocks, complete)
        .into_iter()
        .map(|(id, name)| EngineEvent::ToolDenied {
            id: id.into(),
            name: name.into(),
            reason: NOT_EXECUTED.into(),
        })
        .collect()
}
/// Settle the failed response and clear its passive input previews.
pub(super) fn prepare(
    state: &AppState,
    blocks: &[ContentBlock],
    usage: &Option<Usage>,
    complete: &[(String, String, Value)],
    policy: RejectionPolicy,
) -> RejectedResponse {
    let mut ids = HashSet::new();
    let mut unambiguous = true;
    for block in blocks {
        if let ContentBlock::ToolUse { id, .. } = block {
            unambiguous &= !id.is_empty() && ids.insert(id.as_str());
        }
    }
    let mut complete_ids = HashSet::new();
    for (id, _, _) in complete {
        unambiguous &= !id.is_empty() && complete_ids.insert(id.as_str());
    }
    let regenerate = policy.retry_allowed && unambiguous;
    let mut events = vec![EngineEvent::ToolInputReset];
    // Complete JSON siblings retain truthful protocol pairs. Incomplete
    // inputs are never replaced with executable empty objects or persisted.
    let preserved = if unambiguous && (policy.preserve_candidate || policy.response_committed) {
        complete
    } else {
        &[]
    };
    if !policy.response_committed && policy.preserve_candidate {
        let mut content = Vec::new();
        for block in blocks {
            match block {
                ContentBlock::ToolUse { id, name, .. } => {
                    if let Some((_, _, input)) =
                        preserved.iter().find(|(candidate, candidate_name, _)| {
                            candidate == id && candidate_name == name
                        })
                    {
                        content.push(ContentBlock::ToolUse {
                            id: id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                        });
                        events.push(EngineEvent::ToolUseStarted {
                            id: id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                        });
                    }
                }
                ContentBlock::Text { text } if !text.is_empty() => content.push(block.clone()),
                ContentBlock::Thinking { .. } | ContentBlock::RedactedThinking { .. } => {
                    content.push(block.clone())
                }
                _ => {}
            }
        }
        if !content.is_empty() {
            state.add_message(Message::Assistant {
                content,
                usage: usage.clone(),
            });
        }
    }
    for (id, name) in calls(blocks, complete) {
        if !preserved.iter().any(|(candidate, _, _)| candidate == id) {
            events.push(EngineEvent::ToolDenied {
                id: id.into(),
                name: name.into(),
                reason: if unambiguous { NOT_EXECUTED } else { AMBIGUOUS }.into(),
            });
        }
    }
    if policy.preserve_candidate && !policy.response_committed {
        events.push(EngineEvent::AssistantMessageDone);
    }
    if !preserved.is_empty() {
        state.add_message(
            Message::user_content(
                preserved
                    .iter()
                    .map(|(id, _, _)| ContentBlock::ToolResult {
                        tool_use_id: id.clone(),
                        content: vec![ContentBlock::Text {
                            text: NOT_EXECUTED.into(),
                        }],
                        is_error: Some(true),
                    })
                    .collect(),
            )
            .with_origin(MessageOrigin::Runtime),
        );
        for (id, name, _) in preserved {
            events.push(EngineEvent::ToolResult {
                id: id.clone(),
                name: name.clone(),
                output: ToolOutput::error(NOT_EXECUTED),
            });
        }
    }
    let feedback = if regenerate {
        regenerate_prompt()
    } else if !unambiguous {
        AMBIGUOUS.into()
    } else {
        NOT_EXECUTED.into()
    };
    state.add_message(Message::runtime_text(feedback));
    RejectedResponse { events, regenerate }
}

#[cfg(test)]
mod tests;
