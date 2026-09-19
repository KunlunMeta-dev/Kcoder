//! Ephemeral child presentation state, independent of durable protocol checkpoints.

use crate::{EngineEvent, Message};
use kcoder_types::ContentBlock;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

const MAX_PENDING_TEXT_BYTES: usize = 256 * 1024;
static NEXT_REVISION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct AgentLiveSnapshot {
    pub revision: u64,
    pub messages: Arc<Vec<Message>>,
    pub pending_text: String,
    pub text_truncated: bool,
    pub phase: String,
}

#[derive(Clone, Default)]
pub(crate) struct AgentLiveViews(Arc<Mutex<HashMap<String, Weak<Mutex<AgentLiveSnapshot>>>>>);

impl AgentLiveViews {
    pub(crate) fn register(&self, id: &str, messages: Vec<Message>) -> AgentLiveWriter {
        let state = Arc::new(Mutex::new(AgentLiveSnapshot {
            revision: NEXT_REVISION.fetch_add(1, Ordering::Relaxed),
            messages: Arc::new(messages),
            pending_text: String::new(),
            text_truncated: false,
            phase: "Waiting for model".into(),
        }));
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.into(), Arc::downgrade(&state));
        AgentLiveWriter {
            id: id.into(),
            registry: self.clone(),
            state,
        }
    }

    pub(crate) fn snapshot(&self, id: &str, previous: Option<u64>) -> Option<AgentLiveSnapshot> {
        let state = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)?
            .upgrade()?;
        let state = state.lock().unwrap_or_else(|e| e.into_inner());
        (Some(state.revision) != previous).then(|| state.clone())
    }

    pub(crate) fn contains(&self, id: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .is_some_and(|state| state.strong_count() > 0)
    }
}

pub(crate) struct AgentLiveWriter {
    id: String,
    registry: AgentLiveViews,
    state: Arc<Mutex<AgentLiveSnapshot>>,
}

impl AgentLiveWriter {
    pub(crate) fn update(&self, event: &EngineEvent, messages: impl FnOnce() -> Vec<Message>) {
        let mut view = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match event {
            EngineEvent::AssistantMessageStarted | EngineEvent::AssistantMessageDone => {
                view.messages = Arc::new(messages());
                view.pending_text.clear();
                view.text_truncated = false;
                view.phase = if matches!(event, EngineEvent::AssistantMessageStarted) {
                    "Receiving model response".to_string()
                } else {
                    let pending = view
                        .messages
                        .last()
                        .into_iter()
                        .flat_map(|m| match m {
                            Message::Assistant { content, .. } | Message::User { content } => {
                                content.iter()
                            }
                        })
                        .filter_map(|block| match block {
                            ContentBlock::ToolUse { name, .. } => Some(name.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>();
                    if pending.is_empty() {
                        "Planning next step".into()
                    } else {
                        format!("Running {}", pending.join(", "))
                    }
                };
            }
            EngineEvent::AssistantTextDelta(delta) => {
                view.pending_text.push_str(delta);
                if view.pending_text.len() > MAX_PENDING_TEXT_BYTES {
                    let mut start = view.pending_text.len() - MAX_PENDING_TEXT_BYTES;
                    while !view.pending_text.is_char_boundary(start) {
                        start += 1;
                    }
                    view.pending_text.drain(..start);
                    view.text_truncated = true;
                }
                view.phase = "Writing response".into();
            }
            EngineEvent::AssistantThinkingDelta(_) => view.phase = "Thinking".into(),
            EngineEvent::ToolInputProgress { name, .. } => view.phase = format!("Preparing {name}"),
            EngineEvent::ToolUseStarted { name, .. } => view.phase = format!("Running {name}"),
            EngineEvent::ToolResult { id, name, output } => {
                // Results arrive before the engine commits the entire tool batch.
                // This presentation-only copy may contain incomplete tool protocol.
                Arc::make_mut(&mut view.messages).push(Message::User {
                    content: vec![ContentBlock::ToolResult {
                        tool_use_id: id.clone(),
                        content: output.content.clone(),
                        is_error: Some(output.is_error),
                    }],
                });
                view.phase = format!("Finished {name}");
            }
            EngineEvent::ToolDenied { name, .. } => view.phase = format!("Denied {name}"),
            EngineEvent::ProviderRetry(_) => view.phase = "Retrying model request".into(),
            EngineEvent::Error(_)
            | EngineEvent::ProviderFailed { .. }
            | EngineEvent::StreamAborted { .. } => view.phase = "Stopping".into(),
            _ => return,
        }
        view.revision = NEXT_REVISION.fetch_add(1, Ordering::Relaxed);
    }
}

impl Drop for AgentLiveWriter {
    fn drop(&mut self) {
        let mut entries = self.registry.0.lock().unwrap_or_else(|e| e.into_inner());
        if entries
            .get(&self.id)
            .is_some_and(|entry| entry.ptr_eq(&Arc::downgrade(&self.state)))
        {
            entries.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_failure_stops_live_agent_view() {
        let views = AgentLiveViews::default();
        let writer = views.register("failure", vec![]);
        writer.update(
            &EngineEvent::ProviderFailed {
                message: "opaque".into(),
                details: crate::retry_policy::provider_failure_details(
                    &kcoder_api::ApiErrorKind::Api {
                        error_type: "authentication_error".into(),
                        message: "opaque".into(),
                    },
                    false,
                ),
            },
            Vec::new,
        );
        assert_eq!(views.snapshot("failure", None).unwrap().phase, "Stopping");
    }

    #[test]
    fn tools_update_before_batch_checkpoint_and_old_writer_cannot_remove_new_run() {
        let views = AgentLiveViews::default();
        let writer = views.register("a", vec![]);
        let calls = Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "tool-a".into(),
                name: "bash".into(),
                input: serde_json::json!({}),
            }],
            usage: None,
        };
        writer.update(&EngineEvent::AssistantMessageDone, || vec![calls.clone()]);
        assert_eq!(views.snapshot("a", None).unwrap().phase, "Running bash");
        writer.update(
            &EngineEvent::ToolResult {
                id: "tool-a".into(),
                name: "bash".into(),
                output: kcoder_tools::ToolOutput::text("tool output"),
            },
            Vec::new,
        );
        let live = views.snapshot("a", None).unwrap();
        assert_eq!(live.messages.len(), 2);
        assert!(live.messages[1].preview(1000).contains("tool output"));
        writer.update(&EngineEvent::AssistantMessageStarted, || {
            (*live.messages).clone()
        });
        assert_eq!(views.snapshot("a", None).unwrap().messages.len(), 2);
        let _continuation = views.register("a", vec![Message::user_text("continuation")]);
        let newer = views.snapshot("a", None).unwrap();
        assert!(newer.revision > live.revision);
        drop(writer);
        assert!(views.contains("a"));
        assert!(
            views.snapshot("a", None).unwrap().messages[0]
                .preview(1000)
                .contains("continuation")
        );
    }

    #[test]
    fn streaming_is_isolated_and_checkpoint_replaces_partial_text() {
        let views = AgentLiveViews::default();
        let writer = views.register("a", vec![Message::user_text("child a")]);
        let _sibling = views.register("b", vec![Message::user_text("child b")]);
        writer.update(
            &EngineEvent::AssistantTextDelta("partial answer".into()),
            Vec::new,
        );
        let partial = views.snapshot("a", None).unwrap();
        assert_eq!(partial.pending_text, "partial answer");
        assert!(views.snapshot("a", Some(partial.revision)).is_none());
        assert!(views.snapshot("b", None).unwrap().pending_text.is_empty());
        writer.update(&EngineEvent::AssistantMessageDone, || {
            vec![Message::assistant_text("partial answer")]
        });
        let done = views.snapshot("a", Some(partial.revision)).unwrap();
        assert!(done.pending_text.is_empty());
        assert_eq!(done.messages.len(), 1);
        drop(writer);
        assert!(!views.contains("a"));
        assert!(views.contains("b"));
    }

    #[test]
    fn live_tail_is_utf8_bounded_and_never_contains_thinking() {
        let views = AgentLiveViews::default();
        let writer = views.register("a", vec![]);
        writer.update(
            &EngineEvent::AssistantThinkingDelta("private reasoning".into()),
            Vec::new,
        );
        assert!(views.snapshot("a", None).unwrap().pending_text.is_empty());
        writer.update(
            &EngineEvent::AssistantTextDelta("界".repeat(MAX_PENDING_TEXT_BYTES)),
            Vec::new,
        );
        let snapshot = views.snapshot("a", None).unwrap();
        assert!(snapshot.pending_text.len() <= MAX_PENDING_TEXT_BYTES);
        assert!(snapshot.text_truncated);
    }
}
