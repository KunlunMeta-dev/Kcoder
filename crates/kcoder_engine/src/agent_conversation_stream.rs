//! Event-driven child conversations. Observers never drive execution.
use crate::{EngineEvent, Message};
use kcoder_types::{ContentBlock, public_conversation_message};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

const MAX_RETAINED_FINISHED: usize = 32;
const MAX_SNAPSHOT_BYTES: usize = 1536 * 1024;
const MAX_CONTENT_BYTES: usize = 64 * 1024;
const STREAM_CAPACITY: usize = 256;

#[derive(Clone, Debug)]
pub struct AgentConversationEntry {
    pub web_sources: Vec<kcoder_types::web_sources::WebSourcesV1>,
    pub thinking: Vec<AgentConversationThinking>,
    pub id: String,
    pub client_message_id: Option<String>,
    pub timestamp_ms: u64,
    pub message: Message,
}

/// An owned conversation can show the provider's display reasoning at this position.
/// The public live tail and artifacts continue to use only `message`.
#[derive(Clone, Debug)]
pub struct AgentConversationThinking {
    pub id: String,
    pub before_block: usize,
    pub started_at_ms: u64,
    pub completed_at_ms: Option<u64>,
    pub text: AgentConversationReasoningText,
}

#[derive(Clone, Default)]
pub struct AgentConversationReasoningText(Arc<String>);

impl AgentConversationReasoningText {
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl From<String> for AgentConversationReasoningText {
    fn from(value: String) -> Self {
        Self(Arc::new(value))
    }
}

impl std::fmt::Debug for AgentConversationReasoningText {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentConversationReasoningText")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub struct AgentConversationSnapshot {
    pub run_id: String,
    pub sequence: u64,
    pub public_revision: u64,
    pub active: bool,
    pub status: String,
    pub entries: Vec<AgentConversationEntry>,
    pub thinking_active: bool,
    pub provider_retry: Option<(crate::ProviderRetryDetails, std::time::Instant)>,
    pub failure: Option<AgentConversationFailure>,
    pub truncated: bool,
    pub active_assistant_item_id: Option<String>,
    pub next_assistant_item: u64,
    pub pending_events: Vec<EngineEvent>,
    pub tool_started_at_ms: HashMap<String, u64>,
    pub tool_inputs: HashMap<String, (String, serde_json::Value)>,
}

#[derive(Clone, Debug)]
pub struct AgentConversationFailure {
    pub item_id: String,
    pub message: String,
    pub details: Option<kcoder_types::ProviderFailureDetails>,
    pub timestamp_ms: u64,
}

/// Native registered-run public tail; never reconstructed from a legacy checkpoint.
pub struct AgentExactLiveRead {
    pub active: bool,
    pub revision: u64,
    pub status: String,
    pub content: String,
    pub truncated: bool,
    pub unchanged: bool,
}

#[derive(Clone, Debug)]
pub enum AgentConversationDelta {
    Event(EngineEvent),
    ThinkingStarted,
    ThinkingDelta {
        item_id: String,
        block_id: String,
        text: AgentConversationReasoningText,
    },
    ThinkingCompleted {
        item_id: String,
        block_id: String,
    },
    UserMessage(AgentConversationEntry),
    Finished {
        status: String,
    },
    Reset,
}

#[derive(Clone, Debug)]
pub struct AgentConversationFrame {
    pub sequence: u64,
    pub occurred_at_ms: u64,
    pub delta: AgentConversationDelta,
}

struct Conversation {
    snapshot: AgentConversationSnapshot,
    registered_run: bool,
    sender: broadcast::Sender<AgentConversationFrame>,
    source_messages_seen: usize,
    /// Source position plus its preceding checkpoint identifies a generic user
    /// record without comparing message bodies or reusing a compacted index.
    source_users: HashMap<usize, (String, String)>,
}

pub struct AgentConversationSubscription {
    state: Arc<Mutex<Conversation>>,
    pub snapshot: AgentConversationSnapshot,
    pub receiver: broadcast::Receiver<AgentConversationFrame>,
}

impl AgentConversationSubscription {
    /// Snapshot and fresh receiver share a lock: no event can fall in between.
    pub fn resynchronize(&mut self) -> AgentConversationSnapshot {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.receiver = state.sender.subscribe();
        self.snapshot = state.snapshot.clone();
        self.snapshot.clone()
    }
}

#[derive(Default)]
struct Registry {
    entries: HashMap<String, Arc<Mutex<Conversation>>>,
    finished: VecDeque<(String, String)>,
}

#[derive(Clone, Default)]
pub(crate) struct AgentConversationStreams(Arc<Mutex<Registry>>);

impl AgentConversationStreams {
    pub(crate) fn register(
        &self,
        id: &str,
        run_id: String,
        messages: &[Message],
    ) -> AgentConversationWriter {
        let (sender, _) = broadcast::channel(STREAM_CAPACITY);
        // Legacy Message[] checkpoints do not carry historical event times.
        let timestamp_ms = 0;
        let mut snapshot = AgentConversationSnapshot {
            run_id: run_id.clone(),
            sequence: 0,
            public_revision: 0,
            active: true,
            status: "running".into(),
            thinking_active: false,
            provider_retry: None,
            failure: None,
            entries: messages
                .iter()
                .enumerate()
                .filter_map(|(index, message)| {
                    checkpoint_entry(&run_id, index, message, timestamp_ms)
                })
                .collect(),
            truncated: false,
            active_assistant_item_id: None,
            next_assistant_item: 1,
            pending_events: Vec::new(),
            tool_started_at_ms: HashMap::new(),
            tool_inputs: tool_inputs(messages),
        };
        bound_snapshot(&mut snapshot);
        let state = Arc::new(Mutex::new(Conversation {
            snapshot,
            registered_run: true,
            sender,
            source_messages_seen: messages.len(),
            source_users: HashMap::new(),
        }));
        let mut registry = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let state = if let Some(existing) = registry.entries.get(id) {
            let mut old = existing.lock().unwrap_or_else(|e| e.into_inner());
            if old.snapshot.run_id == run_id && old.snapshot.active {
                let fresh = state.lock().unwrap_or_else(|e| e.into_inner());
                let sequence = old.snapshot.sequence;
                let public_revision = old.snapshot.public_revision;
                old.snapshot = fresh.snapshot.clone();
                old.registered_run = true;
                old.snapshot.sequence = sequence;
                old.snapshot.public_revision = public_revision;
                old.source_messages_seen = messages.len();
                old.source_users.clear();
                emit(&mut old, AgentConversationDelta::Reset);
                existing.clone()
            } else {
                if old.snapshot.active {
                    old.snapshot.active = false;
                    old.snapshot.status = "superseded".into();
                    emit(
                        &mut old,
                        AgentConversationDelta::Finished {
                            status: "superseded".into(),
                        },
                    );
                }
                state
            }
        } else {
            state
        };
        registry.entries.insert(id.into(), state.clone());
        AgentConversationWriter {
            id: id.into(),
            registry: self.clone(),
            state,
            finalize_on_drop: true,
        }
    }

    pub(crate) fn subscribe(&self, id: &str) -> Option<AgentConversationSubscription> {
        let state = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .get(id)?
            .clone();
        let locked = state.lock().unwrap_or_else(|e| e.into_inner());
        let snapshot = locked.snapshot.clone();
        let receiver = locked.sender.subscribe();
        drop(locked);
        Some(AgentConversationSubscription {
            state,
            snapshot,
            receiver,
        })
    }

    pub(crate) fn subscribe_run(
        &self,
        id: &str,
        run_id: &str,
    ) -> Option<AgentConversationSubscription> {
        self.subscribe(id)
            .filter(|subscription| subscription.snapshot.run_id == run_id)
    }

    pub(crate) fn subscribe_registered_run(
        &self,
        id: &str,
        run_id: &str,
    ) -> Option<AgentConversationSubscription> {
        let state = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .get(id)?
            .clone();
        let locked = state.lock().unwrap_or_else(|e| e.into_inner());
        if !locked.registered_run || locked.snapshot.run_id != run_id {
            return None;
        }
        let snapshot = locked.snapshot.clone();
        let receiver = locked.sender.subscribe();
        drop(locked);
        Some(AgentConversationSubscription {
            state,
            snapshot,
            receiver,
        })
    }

    pub(crate) fn finish_run(&self, id: &str, run_id: &str, status: &str) {
        let state = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .get(id)
            .cloned();
        if let Some(state) = state
            && state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .snapshot
                .run_id
                == run_id
        {
            AgentConversationWriter {
                id: id.into(),
                registry: self.clone(),
                state,
                finalize_on_drop: false,
            }
            .finish(status);
        }
    }

    pub(crate) fn observe_checkpoint(
        &self,
        id: &str,
        run_id: String,
        messages: &[Message],
        active: bool,
        status: &str,
    ) -> AgentConversationSubscription {
        let mut registry = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let existing = registry.entries.get(id).cloned();
        let state = if let Some(existing) = existing.filter(|existing| {
            existing
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .snapshot
                .run_id
                == run_id
        }) {
            existing
        } else {
            let mut snapshot = AgentConversationSnapshot {
                run_id: run_id.clone(),
                sequence: 0,
                public_revision: 0,
                active,
                status: status.into(),
                entries: messages
                    .iter()
                    .enumerate()
                    .filter_map(|(index, message)| checkpoint_entry(&run_id, index, message, 0))
                    .collect(),
                truncated: false,
                active_assistant_item_id: None,
                next_assistant_item: 1,
                thinking_active: false,
                provider_retry: None,
                failure: None,
                pending_events: Vec::new(),
                tool_started_at_ms: HashMap::new(),
                tool_inputs: tool_inputs(messages),
            };
            bound_snapshot(&mut snapshot);
            let (sender, _) = broadcast::channel(STREAM_CAPACITY);
            let state = Arc::new(Mutex::new(Conversation {
                snapshot,
                registered_run: false,
                sender,
                source_messages_seen: messages.len(),
                source_users: HashMap::new(),
            }));
            if active {
                registry.entries.insert(id.into(), state.clone());
            }
            state
        };
        let locked = state.lock().unwrap_or_else(|e| e.into_inner());
        let snapshot = locked.snapshot.clone();
        let receiver = locked.sender.subscribe();
        drop(locked);
        AgentConversationSubscription {
            state,
            snapshot,
            receiver,
        }
    }
}

pub(crate) struct AgentConversationWriter {
    id: String,
    registry: AgentConversationStreams,
    state: Arc<Mutex<Conversation>>,
    finalize_on_drop: bool,
}

impl AgentConversationWriter {
    pub(crate) fn defer_terminal_to_manager(&mut self) {
        self.finalize_on_drop = false;
    }
    pub(crate) fn bind_source_message(
        &self,
        index: usize,
        message_id: &str,
        client_message_id: Option<String>,
    ) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let old_id = format!("{}-history-{index}", state.snapshot.run_id);
        if let Some(entry) = state
            .snapshot
            .entries
            .iter_mut()
            .find(|entry| entry.id == old_id)
        {
            entry.id = message_id.into();
            entry.client_message_id = client_message_id;
            emit(&mut state, AgentConversationDelta::Reset);
        }
    }
    pub(crate) fn update(&self, event: &EngineEvent, source: Option<&[Message]>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.snapshot.active {
            return;
        }
        if let EngineEvent::AssistantThinkingDelta(thinking) = event {
            if !thinking.is_empty() {
                if !state.snapshot.thinking_active {
                    start_thinking(&mut state);
                }
                append_thinking(&mut state, thinking);
            }
            return;
        }
        if matches!(
            event,
            EngineEvent::AssistantMessageStarted
                | EngineEvent::AssistantMessageDone
                | EngineEvent::ToolInputProgress { .. }
                | EngineEvent::ToolUseStarted { .. }
                | EngineEvent::ToolInputReset
                | EngineEvent::ProviderRetry(_)
                | EngineEvent::ProviderFailed { .. }
                | EngineEvent::Error(_)
                | EngineEvent::StreamAborted { .. }
                | EngineEvent::MaxTurnsReached { .. }
        ) || matches!(event, EngineEvent::AssistantTextDelta(text) if !text.is_empty())
        {
            complete_thinking(&mut state);
        }
        if matches!(
            event,
            EngineEvent::ToolInputProgress { .. }
                | EngineEvent::ToolUseStarted { .. }
                | EngineEvent::ToolExecutionStarted { .. }
                | EngineEvent::ToolResult { .. }
                | EngineEvent::ProviderFailed { .. }
                | EngineEvent::Error(_)
                | EngineEvent::StreamAborted { .. }
                | EngineEvent::MaxTurnsReached { .. }
        ) || matches!(event, EngineEvent::AssistantTextDelta(text) if !text.is_empty())
        {
            state.snapshot.provider_retry = None;
        }
        let delivery_index = match event {
            EngineEvent::SubagentUserMessageAdded {
                agent_id,
                message_index,
                ..
            } if agent_id == &self.id => Some(*message_index),
            _ => None,
        };
        if let Some(messages) = source {
            // A delivery batch is already committed to source before its exact
            // user events are yielded. Leave the current and future batch rows
            // for those events instead of publishing anonymous duplicates.
            let end = delivery_index.unwrap_or(messages.len()).min(messages.len());
            let seen = state.source_messages_seen.min(end);
            for (index, message) in messages.iter().enumerate().take(end).skip(seen) {
                if !kcoder_types::is_real_user_message(message) {
                    continue;
                }
                let Some(message) = public_conversation_message(message) else {
                    continue;
                };
                let fingerprint = source_prefix_fingerprint(messages, index);
                let id = format!(
                    "{}-user-{index}-{}",
                    state.snapshot.run_id,
                    state.snapshot.sequence + 1
                );
                if let Some(fingerprint) = fingerprint {
                    state.source_users.insert(index, (id.clone(), fingerprint));
                }
                let entry = AgentConversationEntry {
                    web_sources: Vec::new(),
                    thinking: Vec::new(),
                    id,
                    client_message_id: None,
                    timestamp_ms: now_ms(),
                    message,
                };
                state.snapshot.entries.push(entry.clone());
                emit(&mut state, AgentConversationDelta::UserMessage(entry));
            }
            state.source_messages_seen = if delivery_index.is_some() {
                state.source_messages_seen.max(end)
            } else {
                messages.len()
            };
        }
        let public = match event {
            EngineEvent::SubagentUserMessageAdded {
                agent_id,
                message_id,
                client_message_id,
                message_index,
                text,
            } if agent_id == &self.id => {
                let mut entry = AgentConversationEntry {
                    web_sources: Vec::new(),
                    thinking: Vec::new(),
                    id: message_id.clone(),
                    client_message_id: client_message_id.clone(),
                    timestamp_ms: now_ms(),
                    message: Message::user_text(text.clone()),
                };
                let generic =
                    state
                        .source_users
                        .remove(message_index)
                        .filter(|(_, fingerprint)| {
                            source
                                .and_then(|messages| {
                                    source_prefix_fingerprint(messages, *message_index)
                                })
                                .as_ref()
                                == Some(fingerprint)
                        });
                let existing = state
                    .snapshot
                    .entries
                    .iter()
                    .position(|existing| existing.id == *message_id)
                    .or_else(|| {
                        generic.as_ref().and_then(|(id, _)| {
                            state
                                .snapshot
                                .entries
                                .iter()
                                .position(|existing| &existing.id == id)
                        })
                    });
                if let Some(index) = existing {
                    // A generic source notification may have preceded the
                    // exact receipt. Upgrade that precise row and reset the
                    // observer so its former anonymous id cannot survive.
                    let changed = state.snapshot.entries[index].id != entry.id
                        || state.snapshot.entries[index].client_message_id
                            != entry.client_message_id;
                    if changed {
                        entry.timestamp_ms = state.snapshot.entries[index].timestamp_ms;
                        state.snapshot.entries[index] = entry;
                        emit(&mut state, AgentConversationDelta::Reset);
                    }
                } else {
                    state.snapshot.entries.push(entry.clone());
                    emit(&mut state, AgentConversationDelta::UserMessage(entry));
                }
                state.source_messages_seen = state.source_messages_seen.max(message_index + 1);
                None
            }
            EngineEvent::AssistantMessageStarted => {
                let id = format!(
                    "{}-assistant-{}",
                    state.snapshot.run_id, state.snapshot.next_assistant_item
                );
                state.snapshot.next_assistant_item += 1;
                state.snapshot.active_assistant_item_id = Some(id.clone());
                state.snapshot.entries.push(AgentConversationEntry {
                    web_sources: Vec::new(),
                    thinking: Vec::new(),
                    id,
                    client_message_id: None,
                    timestamp_ms: now_ms(),
                    message: Message::Assistant {
                        content: Vec::new(),
                        usage: None,
                    },
                });
                Some(event.clone())
            }
            EngineEvent::AssistantTextDelta(delta) => {
                let mut truncated = false;
                if let Some(entry) = active_assistant(&mut state.snapshot)
                    && let Message::Assistant { content, .. } = &mut entry.message
                {
                    let follows_thinking = entry
                        .thinking
                        .last()
                        .is_some_and(|phase| phase.before_block == content.len());
                    if !follows_thinking
                        && let Some(ContentBlock::Text { text }) = content.last_mut()
                    {
                        text.push_str(delta);
                        truncated = truncate_text(text, MAX_CONTENT_BYTES);
                    } else {
                        content.push(ContentBlock::Text {
                            text: delta.clone(),
                        });
                    }
                }
                state.snapshot.truncated |= truncated;
                Some(event.clone())
            }
            EngineEvent::AssistantMessageDone => {
                state.snapshot.active_assistant_item_id = None;
                Some(event.clone())
            }
            EngineEvent::ToolInputReset => {
                state.snapshot.pending_events.clear();
                Some(event.clone())
            }
            EngineEvent::ToolInputProgress { id, .. } => {
                state.snapshot.pending_events.retain(|event| !matches!(event, EngineEvent::ToolInputProgress { id: other, .. } if other == id));
                state.snapshot.pending_events.push(event.clone());
                Some(event.clone())
            }
            EngineEvent::ToolInputPreview { .. } | EngineEvent::ToolPathPreview { .. } => {
                Some(event.clone())
            }
            EngineEvent::ToolExecutionStarted { .. } => Some(event.clone()),
            EngineEvent::ToolUseStarted { id, name, input } => {
                let input = if serde_json::to_vec(input).map_or(0, |value| value.len())
                    > MAX_CONTENT_BYTES
                {
                    serde_json::json!({"_truncated":true})
                } else {
                    input.clone()
                };
                state
                    .snapshot
                    .tool_inputs
                    .insert(id.clone(), (name.clone(), input.clone()));
                state
                    .snapshot
                    .tool_started_at_ms
                    .insert(id.clone(), now_ms());
                state.snapshot.pending_events.retain(|event| !matches!(event, EngineEvent::ToolInputProgress { id: other, .. } if other == id));
                if let Some(entry) = state
                    .snapshot
                    .entries
                    .iter_mut()
                    .rev()
                    .find(|entry| matches!(entry.message, Message::Assistant { .. }))
                    && let Message::Assistant { content, .. } = &mut entry.message
                {
                    content.push(ContentBlock::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                    });
                }
                Some(EngineEvent::ToolUseStarted {
                    id: id.clone(),
                    name: name.clone(),
                    input,
                })
            }
            EngineEvent::ToolResult { id, name, output } => {
                let mut output = output.clone();
                let mut image_bytes = 0usize;
                let mut images_omitted = false;
                output.content.retain(|block| match block {
                    ContentBlock::Text { .. } => true,
                    ContentBlock::Image { source }
                        if source.data.len() <= (1024 * 1024usize).saturating_sub(image_bytes) =>
                    {
                        image_bytes += source.data.len();
                        true
                    }
                    ContentBlock::Image { .. } => {
                        images_omitted = true;
                        false
                    }
                    _ => false,
                });
                if images_omitted {
                    output.content.push(ContentBlock::Image {
                        source: kcoder_types::ImageSource::base64("image/png", ""),
                    });
                }
                for block in &mut output.content {
                    if let ContentBlock::Text { text } = block {
                        truncate_text(text, MAX_CONTENT_BYTES);
                    }
                }
                state.snapshot.truncated |= bound_output(&mut output.content);
                let entry_id = format!(
                    "{}-result-{id}-{}",
                    state.snapshot.run_id, state.snapshot.sequence
                );
                state.snapshot.entries.push(AgentConversationEntry {
                    thinking: Vec::new(),
                    web_sources: output
                        .execution_metadata
                        .iter()
                        .filter_map(|metadata| match metadata {
                            kcoder_tools::ToolExecutionMetadata::WebSources(receipt)
                                if receipt.tool_call_id == *id =>
                            {
                                Some(receipt.clone())
                            }
                            _ => None,
                        })
                        .collect(),
                    id: entry_id,
                    client_message_id: None,
                    timestamp_ms: now_ms(),
                    message: Message::user_content(vec![ContentBlock::ToolResult {
                        tool_use_id: id.clone(),
                        content: output.content.clone(),
                        is_error: Some(output.is_error),
                    }]),
                });
                Some(EngineEvent::ToolResult {
                    id: id.clone(),
                    name: name.clone(),
                    output,
                })
            }
            EngineEvent::ToolDenied { id, reason, .. } => {
                let entry_id = format!(
                    "{}-denied-{id}-{}",
                    state.snapshot.run_id, state.snapshot.sequence
                );
                state.snapshot.entries.push(AgentConversationEntry {
                    web_sources: Vec::new(),
                    thinking: Vec::new(),
                    id: entry_id,
                    client_message_id: None,
                    timestamp_ms: now_ms(),
                    message: Message::user_content(vec![ContentBlock::ToolResult {
                        tool_use_id: id.clone(),
                        content: vec![ContentBlock::Text {
                            text: reason.clone(),
                        }],
                        is_error: Some(true),
                    }]),
                });
                Some(event.clone())
            }
            EngineEvent::ProviderRetry(details) => {
                state.snapshot.provider_retry = Some((details.clone(), std::time::Instant::now()));
                Some(event.clone())
            }
            EngineEvent::Error(message) | EngineEvent::ProviderFailed { message, .. } => {
                state.snapshot.status = "failed".into();
                let mut public_message = message.clone();
                truncate_text(&mut public_message, MAX_CONTENT_BYTES);
                state.snapshot.failure = Some(AgentConversationFailure {
                    item_id: state
                        .snapshot
                        .active_assistant_item_id
                        .clone()
                        .unwrap_or_else(|| format!("{}:assistant", state.snapshot.run_id)),
                    message: public_message,
                    details: match event {
                        EngineEvent::ProviderFailed { details, .. } => Some(details.clone()),
                        _ => None,
                    },
                    timestamp_ms: now_ms(),
                });
                Some(event.clone())
            }
            EngineEvent::StreamAborted { .. } | EngineEvent::MaxTurnsReached { .. } => {
                state.snapshot.status = "interrupted".into();
                Some(event.clone())
            }
            // An unprojected event with no source cannot change transcript retention.
            _ if source.is_none() => return,
            // Source synchronization above may have appended user messages.
            _ => None,
        };
        if let Some(event) = public {
            emit(&mut state, AgentConversationDelta::Event(event));
        }
        if !matches!(
            event,
            EngineEvent::AssistantTextDelta(_)
                | EngineEvent::ToolInputProgress { .. }
                | EngineEvent::ToolInputPreview { .. }
                | EngineEvent::ToolPathPreview { .. }
        ) {
            bound_snapshot(&mut state.snapshot);
            let retained = state
                .snapshot
                .entries
                .iter()
                .map(|entry| entry.id.clone())
                .collect::<std::collections::HashSet<_>>();
            state
                .source_users
                .retain(|_, (id, _)| retained.contains(id));
        }
    }

    pub(crate) fn finish(&self, status: &str) {
        let run_id = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if !state.snapshot.active {
                return;
            }
            complete_thinking(&mut state);
            state.snapshot.active = false;
            state.snapshot.provider_retry = None;
            state.snapshot.status = status.into();
            state.snapshot.active_assistant_item_id = None;
            state.snapshot.pending_events.clear();
            emit(
                &mut state,
                AgentConversationDelta::Finished {
                    status: status.into(),
                },
            );
            state.snapshot.run_id.clone()
        };
        let mut registry = self.registry.0.lock().unwrap_or_else(|e| e.into_inner());
        registry.finished.push_back((self.id.clone(), run_id));
        while registry.finished.len() > MAX_RETAINED_FINISHED {
            if let Some((id, run)) = registry.finished.pop_front()
                && registry.entries.get(&id).is_some_and(|state| {
                    state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .snapshot
                        .run_id
                        == run
                })
            {
                registry.entries.remove(&id);
            }
        }
    }
}

impl Drop for AgentConversationWriter {
    fn drop(&mut self) {
        if !self.finalize_on_drop {
            return;
        }
        let status = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot
            .status
            .clone();
        self.finish(if status == "running" {
            "interrupted"
        } else {
            &status
        });
    }
}

fn active_assistant(
    snapshot: &mut AgentConversationSnapshot,
) -> Option<&mut AgentConversationEntry> {
    let id = snapshot.active_assistant_item_id.as_deref()?;
    snapshot
        .entries
        .iter_mut()
        .rev()
        .find(|entry| entry.id == id)
}

fn checkpoint_entry(
    run_id: &str,
    index: usize,
    message: &Message,
    timestamp_ms: u64,
) -> Option<AgentConversationEntry> {
    let id = format!("{run_id}-history-{index}");
    let mut thinking = Vec::new();
    if let Message::Assistant { content, .. } = message {
        let mut before_block = 0;
        for block in content {
            let mut text = match block {
                ContentBlock::Thinking { thinking, .. } if !thinking.is_empty() => thinking.clone(),
                ContentBlock::RedactedThinking { .. } => String::new(),
                ContentBlock::Thinking { .. } => continue,
                _ => {
                    before_block += 1;
                    continue;
                }
            };
            truncate_text(&mut text, MAX_CONTENT_BYTES);
            thinking.push(AgentConversationThinking {
                id: format!("{id}-thought-{}", thinking.len() + 1),
                before_block,
                started_at_ms: 0,
                completed_at_ms: Some(0),
                text: text.into(),
            });
        }
    }
    let message = public_conversation_message(message).or_else(|| {
        (!thinking.is_empty()).then(|| Message::Assistant {
            content: Vec::new(),
            usage: None,
        })
    })?;
    Some(AgentConversationEntry {
        web_sources: Vec::new(),
        thinking,
        id,
        client_message_id: None,
        timestamp_ms,
        message,
    })
}

fn start_thinking(state: &mut Conversation) {
    let sequence = state.snapshot.sequence + 1;
    let Some(entry) = active_assistant(&mut state.snapshot) else {
        return;
    };
    let Message::Assistant { content, .. } = &entry.message else {
        return;
    };
    let block_id = format!("{}-thought-{sequence}", entry.id);
    entry.thinking.push(AgentConversationThinking {
        id: block_id,
        before_block: content.len(),
        started_at_ms: now_ms(),
        completed_at_ms: None,
        text: AgentConversationReasoningText::default(),
    });
    state.snapshot.thinking_active = true;
    state.snapshot.provider_retry = None;
    emit(state, AgentConversationDelta::ThinkingStarted);
}

fn append_thinking(state: &mut Conversation, delta: &str) {
    if !state.snapshot.thinking_active {
        return;
    }
    if let Some(entry) = active_assistant(&mut state.snapshot)
        && let Some(phase) = entry.thinking.last_mut()
    {
        let content = Arc::make_mut(&mut phase.text.0);
        content.push_str(delta);
        let truncated = truncate_text(content, MAX_CONTENT_BYTES);
        let item_id = entry.id.clone();
        let block_id = phase.id.clone();
        state.snapshot.truncated |= truncated;
        emit(
            state,
            AgentConversationDelta::ThinkingDelta {
                item_id,
                block_id,
                text: delta.to_owned().into(),
            },
        );
    }
}

fn complete_thinking(state: &mut Conversation) {
    if !std::mem::take(&mut state.snapshot.thinking_active) {
        return;
    }
    if let Some(entry) = active_assistant(&mut state.snapshot)
        && let Some(phase) = entry.thinking.last_mut()
    {
        phase.completed_at_ms = Some(now_ms().max(phase.started_at_ms));
        let item_id = entry.id.clone();
        let block_id = phase.id.clone();
        emit(
            state,
            AgentConversationDelta::ThinkingCompleted { item_id, block_id },
        );
    }
}

fn emit(state: &mut Conversation, delta: AgentConversationDelta) {
    state.snapshot.sequence += 1;
    if !matches!(&delta, AgentConversationDelta::ThinkingDelta { .. }) {
        state.snapshot.public_revision = state.snapshot.sequence;
    }
    let _ = state.sender.send(AgentConversationFrame {
        sequence: state.snapshot.sequence,
        occurred_at_ms: now_ms(),
        delta,
    });
}

fn truncate_text(text: &mut String, limit: usize) -> bool {
    if text.len() <= limit {
        return false;
    }
    let mut start = text.len() - limit;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text.drain(..start);
    true
}

fn entry_projection_bytes(entry: &AgentConversationEntry) -> usize {
    serde_json::to_vec(&entry.message).map_or(0, |value| value.len())
        + serde_json::to_vec(&entry.web_sources).map_or(0, |value| value.len())
        + entry
            .thinking
            .iter()
            .map(|phase| phase.id.len() + phase.text.0.len() + 64)
            .sum::<usize>()
}

fn bound_snapshot(snapshot: &mut AgentConversationSnapshot) {
    #[cfg(test)]
    tests::BOUND_PASSES.set(tests::BOUND_PASSES.get() + 1);
    let mut bytes = 0;
    let mut image_remaining = 1024 * 1024usize;
    let mut reasoning_remaining = MAX_SNAPSHOT_BYTES / 2;
    for entry in snapshot.entries.iter_mut().rev() {
        for phase in entry.thinking.iter_mut().rev() {
            if phase.text.0.len() > reasoning_remaining {
                snapshot.truncated |=
                    truncate_text(Arc::make_mut(&mut phase.text.0), reasoning_remaining);
            }
            reasoning_remaining -= phase.text.0.len();
        }
        let content = match &mut entry.message {
            Message::User { content, .. } | Message::Assistant { content, .. } => content,
        };
        for block in content.iter_mut().rev() {
            let images: &mut [ContentBlock] = match block {
                ContentBlock::ToolResult { content, .. } => content,
                other => std::slice::from_mut(other),
            };
            for image in images.iter_mut().rev() {
                if let ContentBlock::Image { source } = image {
                    if source.data.len() <= image_remaining {
                        image_remaining -= source.data.len();
                    } else {
                        source.data.clear();
                        snapshot.truncated = true;
                    }
                }
            }
        }
        for block in content.iter_mut() {
            match block {
                ContentBlock::Text { text } => {
                    snapshot.truncated |= truncate_text(text, MAX_CONTENT_BYTES);
                }
                ContentBlock::ToolUse { input, .. }
                    if serde_json::to_vec(input).map_or(0, |v| v.len()) > MAX_CONTENT_BYTES =>
                {
                    *input = serde_json::json!({"_truncated":true});
                    snapshot.truncated = true;
                }
                ContentBlock::ToolResult { content, .. } => {
                    for block in content.iter_mut() {
                        if let ContentBlock::Text { text } = block {
                            snapshot.truncated |= truncate_text(text, MAX_CONTENT_BYTES);
                        }
                    }
                    snapshot.truncated |= bound_output(content);
                }
                ContentBlock::Image { .. } => {}
                _ => {}
            }
        }
        while serde_json::to_vec(content).map_or(0, |value| value.len()) > MAX_SNAPSHOT_BYTES
            && content.len() > 1
        {
            content.remove(0);
            entry.thinking.retain_mut(|phase| {
                let Some(index) = phase.before_block.checked_sub(1) else {
                    return false;
                };
                phase.before_block = index;
                true
            });
            snapshot.truncated = true;
        }
        bytes += entry_projection_bytes(entry);
    }
    while bytes > MAX_SNAPSHOT_BYTES && snapshot.entries.len() > 1 {
        let removed = snapshot.entries.remove(0);
        bytes = bytes.saturating_sub(entry_projection_bytes(&removed));
        snapshot.truncated = true;
    }
    let referenced = snapshot
        .entries
        .iter()
        .flat_map(|entry| match &entry.message {
            Message::User { content, .. } | Message::Assistant { content, .. } => content,
        })
        .filter_map(|block| match block {
            ContentBlock::ToolUse { id, .. } => Some(id.clone()),
            ContentBlock::ToolResult { tool_use_id, .. } => Some(tool_use_id.clone()),
            _ => None,
        })
        .collect::<std::collections::HashSet<_>>();
    snapshot.tool_inputs.retain(|id, (_, input)| {
        if serde_json::to_vec(input).map_or(0, |value| value.len()) > MAX_CONTENT_BYTES {
            *input = serde_json::json!({"_truncated":true});
        }
        referenced.contains(id)
    });
    let mut input_remaining = 256 * 1024usize;
    for (_, input) in snapshot.tool_inputs.values_mut() {
        let bytes = serde_json::to_vec(input).map_or(0, |value| value.len());
        if bytes > input_remaining {
            *input = serde_json::json!({"_truncated":true});
            snapshot.truncated = true;
        } else {
            input_remaining -= bytes;
        }
    }
    snapshot
        .tool_started_at_ms
        .retain(|id, _| referenced.contains(id));
}

fn bound_output(content: &mut [ContentBlock]) -> bool {
    let mut remaining = MAX_CONTENT_BYTES;
    let mut truncated = false;
    for block in content.iter_mut().rev() {
        if let ContentBlock::Text { text } = block {
            truncated |= truncate_text(text, remaining);
            remaining = remaining.saturating_sub(text.len());
        }
    }
    truncated
}

fn tool_inputs(messages: &[Message]) -> HashMap<String, (String, serde_json::Value)> {
    messages
        .iter()
        .flat_map(|message| match message {
            Message::User { content, .. } | Message::Assistant { content, .. } => content,
        })
        .filter_map(|block| match block {
            ContentBlock::ToolUse { id, name, input } => {
                Some((id.clone(), (name.clone(), input.clone())))
            }
            _ => None,
        })
        .collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn source_prefix_fingerprint(messages: &[Message], index: usize) -> Option<String> {
    let prefix = messages.get(..index)?;
    serde_json::to_vec(prefix)
        .ok()
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    thread_local! {
        pub(super) static BOUND_PASSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    #[test]
    fn unprojected_events_do_not_rescan_the_transcript() {
        let registry = AgentConversationStreams::default();
        let writer = registry.register("child", "run".into(), &[]);
        writer.update(&EngineEvent::AssistantMessageStarted, None);
        writer.update(
            &EngineEvent::AssistantThinkingDelta("planning".into()),
            None,
        );
        let mut observer = registry.subscribe("child").unwrap();
        let initial = observer.snapshot.clone();
        let before = BOUND_PASSES.get();
        let notice = EngineEvent::SystemNotice("internal".into());
        let usage = EngineEvent::ContextUsageUpdated {
            usage: serde_json::from_value(
                serde_json::json!({"input_tokens": 8, "output_tokens": 1}),
            )
            .unwrap(),
            model_context_window: 128_000,
        };
        for _ in 0..64 {
            writer.update(&usage, None);
            writer.update(&notice, None);
            writer.update(
                &EngineEvent::AssistantStopReason { reason: "end_turn" },
                None,
            );
        }
        assert_eq!(BOUND_PASSES.get(), before);
        assert!(observer.receiver.try_recv().is_err());
        let quiet = observer.resynchronize();
        assert_eq!(quiet.sequence, initial.sequence);
        assert_eq!(quiet.public_revision, initial.public_revision);
        assert!(quiet.thinking_active);
        assert_eq!(quiet.entries[0].thinking[0].text.as_str(), "planning");

        let source = [Message::user_text("accepted follow-up")];
        writer.update(&notice, Some(&source));
        assert_eq!(BOUND_PASSES.get(), before + 1);
        let frame = observer.receiver.try_recv().unwrap();
        assert_eq!(frame.sequence, initial.sequence + 1);
        assert!(matches!(
            frame.delta,
            AgentConversationDelta::UserMessage(_)
        ));
        writer.update(&EngineEvent::AssistantMessageDone, None);
        assert_eq!(BOUND_PASSES.get(), before + 2);
        let completed = observer.resynchronize();
        assert!(!completed.thinking_active);
        assert_eq!(completed.entries.len(), 2);
        assert_eq!(completed.entries[1].message, source[0]);
        assert!(completed.entries[0].thinking[0].completed_at_ms.is_some());
    }

    #[test]
    fn reasoning_activity_keeps_its_position_and_private_contents() {
        let registry = AgentConversationStreams::default();
        let writer = registry.register("child", "run".into(), &[]);
        writer.update(&EngineEvent::AssistantMessageStarted, None);
        writer.update(&EngineEvent::AssistantTextDelta("before".into()), None);
        let mut observer = registry.subscribe("child").unwrap();
        writer.update(
            &EngineEvent::AssistantThinkingDelta("private thought".into()),
            None,
        );
        writer.update(
            &EngineEvent::AssistantThinkingDelta("more private thought".into()),
            None,
        );
        assert!(matches!(
            observer.receiver.try_recv().unwrap().delta,
            AgentConversationDelta::ThinkingStarted
        ));
        for expected in ["private thought", "more private thought"] {
            let AgentConversationDelta::ThinkingDelta { text, .. } =
                observer.receiver.try_recv().unwrap().delta
            else {
                panic!("expected an owned reasoning delta");
            };
            assert_eq!(text.as_str(), expected);
        }
        assert!(observer.receiver.try_recv().is_err());
        let reopened = registry.subscribe("child").unwrap().snapshot;
        assert!(reopened.thinking_active);
        assert_eq!(reopened.public_revision + 2, reopened.sequence);
        assert_eq!(reopened.entries[0].thinking[0].before_block, 1);
        assert_eq!(
            reopened.entries[0].thinking[0].text.as_str(),
            "private thoughtmore private thought"
        );
        assert!(!format!("{:?}", reopened.entries).contains("private thought"));

        writer.update(
            &EngineEvent::AssistantTextDelta("visible text".into()),
            None,
        );
        let reopened = registry.subscribe("child").unwrap().snapshot;
        assert!(!reopened.thinking_active);
        assert!(reopened.entries[0].thinking[0].completed_at_ms.is_some());
        let Message::Assistant { content, .. } = &reopened.entries[0].message else {
            panic!("assistant entry")
        };
        assert!(
            matches!(&content[..], [ContentBlock::Text { text: before }, ContentBlock::Text { text: after }] if before == "before" && after == "visible text")
        );
        writer.finish("completed");
        assert!(
            !registry
                .subscribe("child")
                .unwrap()
                .snapshot
                .thinking_active
        );
    }

    #[test]
    fn subscribe_mid_response_has_atomic_cursor_and_future_text_is_only_delta() {
        let registry = AgentConversationStreams::default();
        let writer = registry.register("child", "run-1".into(), &[Message::user_text("task")]);
        writer.update(&EngineEvent::AssistantMessageStarted, None);
        writer.update(&EngineEvent::AssistantTextDelta("first".into()), None);
        let mut subscriber = registry.subscribe("child").unwrap();
        assert_eq!(subscriber.snapshot.sequence, 2);
        assert_eq!(
            subscriber.snapshot.active_assistant_item_id.as_deref(),
            Some("run-1-assistant-1")
        );
        assert_eq!(
            subscriber.snapshot.entries.last().unwrap().id,
            "run-1-assistant-1"
        );
        assert!(
            subscriber
                .snapshot
                .entries
                .last()
                .unwrap()
                .message
                .preview(100)
                .contains("first")
        );
        writer.update(&EngineEvent::AssistantTextDelta(" second".into()), None);
        let frame = subscriber.receiver.try_recv().unwrap();
        assert_eq!(frame.sequence, 3);
        assert!(frame.occurred_at_ms > 0);
        assert!(
            matches!(frame.delta, AgentConversationDelta::Event(EngineEvent::AssistantTextDelta(delta)) if delta == " second")
        );
        assert!(subscriber.receiver.try_recv().is_err());
        writer.finish("completed");
        assert!(
            matches!(subscriber.receiver.try_recv().unwrap().delta, AgentConversationDelta::Finished { status } if status == "completed")
        );
        assert!(!registry.subscribe("child").unwrap().snapshot.active);
    }

    #[test]
    fn reopen_and_stale_message_done_checkpoint_preserve_initial_text_before_tools() {
        let registry = AgentConversationStreams::default();
        let task = Message::user_text("inspect workspace");
        let writer = registry.register("child", "run".into(), std::slice::from_ref(&task));
        writer.update(
            &EngineEvent::AssistantMessageStarted,
            Some(std::slice::from_ref(&task)),
        );
        let first = "## 分析进度\n\n正在检查项目。\nS03_LIVE_VISIBLE";
        writer.update(&EngineEvent::AssistantTextDelta(first.into()), None);
        let initial = registry.subscribe("child").unwrap();
        assert_eq!(
            initial.snapshot.active_assistant_item_id.as_deref(),
            Some("run-assistant-1")
        );
        assert!(
            initial
                .snapshot
                .entries
                .last()
                .unwrap()
                .message
                .preview(1000)
                .contains(first)
        );
        writer.update(
            &EngineEvent::AssistantTextDelta("\n\nS03_SECOND_LIVE_DELTA".into()),
            None,
        );
        writer.update(
            &EngineEvent::AssistantTextDelta("\n\nS03_THIRD_LIVE_DELTA".into()),
            None,
        );
        drop(initial);
        let reopened = registry.subscribe("child").unwrap();
        assert!(
            reopened
                .snapshot
                .entries
                .last()
                .unwrap()
                .message
                .preview(1000)
                .contains(first)
        );
        let stale_private_messages = vec![
            task.clone(),
            Message::assistant_text("stale private checkpoint"),
        ];
        writer.update(
            &EngineEvent::AssistantMessageDone,
            Some(&stale_private_messages),
        );
        writer.update(
            &EngineEvent::ToolUseStarted {
                id: "bash".into(),
                name: "bash".into(),
                input: serde_json::json!({"command":"inspect"}),
            },
            None,
        );
        writer.update(
            &EngineEvent::ToolResult {
                id: "bash".into(),
                name: "bash".into(),
                output: kcoder_tools::ToolOutput::text("tool done"),
            },
            None,
        );
        writer.update(
            &EngineEvent::AssistantMessageStarted,
            Some(&stale_private_messages),
        );
        writer.update(
            &EngineEvent::AssistantMessageDone,
            Some(&stale_private_messages),
        );
        writer.update(
            &EngineEvent::ToolUseStarted {
                id: "question".into(),
                name: "AskUserQuestion".into(),
                input: serde_json::json!({"questions":[]}),
            },
            None,
        );
        let snapshot = registry.subscribe("child").unwrap().snapshot;
        let first_message = snapshot
            .entries
            .iter()
            .find(|entry| entry.id == "run-assistant-1")
            .unwrap();
        let public = first_message.message.preview(2000);
        for expected in [first, "S03_SECOND_LIVE_DELTA", "S03_THIRD_LIVE_DELTA"] {
            assert!(
                public.contains(expected),
                "lost first message text: {public}"
            );
        }
        assert!(!public.contains("stale private checkpoint"));
        assert!(snapshot.active_assistant_item_id.is_none());
        assert_eq!(snapshot.next_assistant_item, 3);
    }

    #[test]
    fn results_publish_before_private_batch_commit_and_thoughts_never_publish() {
        let registry = AgentConversationStreams::default();
        let writer = registry.register(
            "child",
            "run".into(),
            &[Message::runtime_text("secret runtime")],
        );
        let mut subscriber = registry.subscribe("child").unwrap();
        writer.update(
            &EngineEvent::AssistantThinkingDelta("secret thought".into()),
            None,
        );
        assert!(subscriber.receiver.try_recv().is_err());
        assert!(subscriber.snapshot.entries.is_empty());
        writer.update(&EngineEvent::AssistantMessageStarted, None);
        writer.update(
            &EngineEvent::ToolUseStarted {
                id: "tool".into(),
                name: "read".into(),
                input: serde_json::json!({"path":"main.rs"}),
            },
            None,
        );
        writer.update(
            &EngineEvent::ToolResult {
                id: "tool".into(),
                name: "read".into(),
                output: kcoder_tools::ToolOutput::text("file body"),
            },
            None,
        );
        let snapshot = subscriber.resynchronize();
        assert_eq!(snapshot.sequence, 3);
        assert!(snapshot.tool_started_at_ms["tool"] > 0);
        let wire = serde_json::to_string(
            &snapshot
                .entries
                .iter()
                .map(|entry| &entry.message)
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(wire.contains("file body"));
        assert!(!wire.contains("secret"));
        assert!(subscriber.receiver.try_recv().is_err());
    }

    #[test]
    fn lag_resets_to_current_snapshot_without_replaying_old_deltas() {
        let registry = AgentConversationStreams::default();
        let writer = registry.register("child", "run".into(), &[]);
        writer.update(&EngineEvent::AssistantMessageStarted, None);
        let mut subscriber = registry.subscribe("child").unwrap();
        for _ in 0..(STREAM_CAPACITY + 1) {
            writer.update(&EngineEvent::AssistantTextDelta("x".into()), None);
        }
        assert!(matches!(
            subscriber.receiver.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
        let reset = subscriber.resynchronize();
        assert_eq!(reset.sequence, STREAM_CAPACITY as u64 + 2);
        assert!(subscriber.receiver.try_recv().is_err());
        writer.update(&EngineEvent::AssistantTextDelta("y".into()), None);
        assert_eq!(
            subscriber.receiver.try_recv().unwrap().sequence,
            reset.sequence + 1
        );
    }

    #[test]
    fn observation_before_worker_is_adopted_and_old_run_cannot_affect_new() {
        let registry = AgentConversationStreams::default();
        let mut observer =
            registry.observe_checkpoint("child", "run-1".into(), &[], true, "pending");
        let old_writer = registry.register("child", "run-1".into(), &[Message::user_text("task")]);
        assert!(matches!(
            observer.receiver.try_recv().unwrap().delta,
            AgentConversationDelta::Reset
        ));
        observer.resynchronize();
        old_writer.update(&EngineEvent::AssistantMessageStarted, None);
        assert!(matches!(
            observer.receiver.try_recv().unwrap().delta,
            AgentConversationDelta::Event(EngineEvent::AssistantMessageStarted)
        ));
        let _new_writer = registry.register("child", "run-2".into(), &[]);
        assert!(
            matches!(observer.receiver.try_recv().unwrap().delta, AgentConversationDelta::Finished { status } if status == "superseded")
        );
        drop(old_writer);
        let new_run = registry.subscribe("child").unwrap();
        assert_eq!(new_run.snapshot.run_id, "run-2");
        assert!(new_run.snapshot.active);
        registry.finish_run("child", "run-1", "failed");
        assert!(registry.subscribe("child").unwrap().snapshot.active);
    }

    #[test]
    fn reliable_batch_uses_exact_receipt_ids_without_duplicate_user_messages() {
        let registry = AgentConversationStreams::default();
        let writer = registry.register("child", "run".into(), &[Message::user_text("task")]);
        for (index, id, body) in [(1, "receipt-1", "first"), (2, "receipt-2", "second")] {
            writer.update(
                &EngineEvent::SubagentUserMessageAdded {
                    agent_id: "child".into(),
                    message_id: id.into(),
                    client_message_id: Some(format!("client-{id}")),
                    message_index: index,
                    text: body.into(),
                },
                None,
            );
        }
        let source = vec![
            Message::user_text("task"),
            Message::user_text("first"),
            Message::user_text("second"),
        ];
        writer.update(&EngineEvent::AssistantMessageStarted, Some(&source));
        let snapshot = registry.subscribe("child").unwrap().snapshot;
        assert_eq!(snapshot.entries.len(), 4);
        assert_eq!(snapshot.entries[1].id, "receipt-1");
        assert_eq!(snapshot.entries[2].id, "receipt-2");
    }

    fn delivery_event(index: usize, id: &str, body: &str) -> EngineEvent {
        EngineEvent::SubagentUserMessageAdded {
            agent_id: "child".into(),
            message_id: id.into(),
            client_message_id: Some(format!("client-{id}")),
            message_index: index,
            text: body.into(),
        }
    }

    fn assert_unique_deliveries(snapshot: &AgentConversationSnapshot) {
        for (id, body) in [
            ("receipt-1", "S03_ADJUST_ONE"),
            ("receipt-2", "S03_ADJUST_TWO"),
        ] {
            let records = snapshot
                .entries
                .iter()
                .filter(|entry| {
                    kcoder_types::is_real_user_message(&entry.message)
                        && entry.message.preview(1000) == body
                })
                .collect::<Vec<_>>();
            assert_eq!(
                records.len(),
                1,
                "one committed command must have one public record: {body}"
            );
            assert_eq!(records[0].id, id);
            assert_eq!(
                records[0].client_message_id.as_deref(),
                Some(format!("client-{id}").as_str())
            );
        }
    }

    #[test]
    fn delivery_source_same_frame_and_committed_batch_publish_each_command_once() {
        let registry = AgentConversationStreams::default();
        let task = Message::user_text("task");
        let writer = registry.register("child", "run".into(), std::slice::from_ref(&task));
        let source = vec![
            task,
            Message::user_text("S03_ADJUST_ONE"),
            Message::user_text("S03_ADJUST_TWO"),
        ];
        let mut subscriber = registry.subscribe("child").unwrap();
        writer.update(
            &delivery_event(1, "receipt-1", "S03_ADJUST_ONE"),
            Some(&source),
        );
        writer.update(
            &delivery_event(2, "receipt-2", "S03_ADJUST_TWO"),
            Some(&source),
        );
        writer.update(&EngineEvent::AssistantMessageStarted, Some(&source));
        assert_unique_deliveries(&subscriber.resynchronize());
        assert!(subscriber.receiver.try_recv().is_err());
    }

    #[test]
    fn delivery_source_already_published_upgrades_exact_index_and_resets_old_ids() {
        let registry = AgentConversationStreams::default();
        let task = Message::user_text("task");
        let writer = registry.register("child", "run".into(), std::slice::from_ref(&task));
        let source = vec![
            task,
            Message::user_text("S03_ADJUST_ONE"),
            Message::user_text("S03_ADJUST_TWO"),
        ];
        writer.update(&EngineEvent::UserMessageAdded, Some(&source));
        let mut subscriber = registry.subscribe("child").unwrap();
        writer.update(
            &delivery_event(1, "receipt-1", "S03_ADJUST_ONE"),
            Some(&source),
        );
        assert!(matches!(
            subscriber.receiver.try_recv().unwrap().delta,
            AgentConversationDelta::Reset
        ));
        writer.update(
            &delivery_event(2, "receipt-2", "S03_ADJUST_TWO"),
            Some(&source),
        );
        assert!(matches!(
            subscriber.receiver.try_recv().unwrap().delta,
            AgentConversationDelta::Reset
        ));
        let snapshot = subscriber.resynchronize();
        assert_unique_deliveries(&snapshot);
        assert_eq!(snapshot.entries.len(), 3);
        // Retried exact lifecycle observations must also remain idempotent.
        writer.update(
            &delivery_event(1, "receipt-1", "S03_ADJUST_ONE"),
            Some(&source),
        );
        assert!(subscriber.receiver.try_recv().is_err());
        assert_unique_deliveries(&subscriber.resynchronize());
    }

    #[test]
    fn delivery_source_compacted_prefix_cannot_upgrade_an_unrelated_reused_index() {
        let registry = AgentConversationStreams::default();
        let task = Message::user_text("task");
        let writer = registry.register("child", "run".into(), std::slice::from_ref(&task));
        writer.update(
            &EngineEvent::UserMessageAdded,
            Some(&[task, Message::user_text("unrelated old user")]),
        );
        let compacted = vec![
            Message::compaction_text("private compacted checkpoint"),
            Message::user_text("S03_ADJUST_ONE"),
        ];
        writer.update(
            &delivery_event(1, "receipt-1", "S03_ADJUST_ONE"),
            Some(&compacted),
        );
        let snapshot = registry.subscribe("child").unwrap().snapshot;
        assert_eq!(
            snapshot
                .entries
                .iter()
                .filter(|entry| entry.message.preview(1000) == "unrelated old user")
                .count(),
            1
        );
        assert_eq!(
            snapshot
                .entries
                .iter()
                .filter(|entry| entry.id == "receipt-1")
                .count(),
            1
        );
        assert!(
            !snapshot
                .entries
                .iter()
                .find(|entry| entry.message.preview(1000) == "unrelated old user")
                .unwrap()
                .id
                .starts_with("receipt")
        );
    }

    #[test]
    fn dropping_worker_finishes_observers_and_finished_retention_is_bounded() {
        let registry = AgentConversationStreams::default();
        for index in 0..(MAX_RETAINED_FINISHED + 2) {
            let writer = registry.register(&format!("child-{index}"), format!("run-{index}"), &[]);
            drop(writer);
        }
        assert!(registry.subscribe("child-0").is_none());
        assert!(registry.subscribe("child-1").is_none());
        let snapshot = registry.subscribe("child-2").unwrap().snapshot;
        assert!(!snapshot.active);
        assert_eq!(snapshot.status, "interrupted");
    }
}
