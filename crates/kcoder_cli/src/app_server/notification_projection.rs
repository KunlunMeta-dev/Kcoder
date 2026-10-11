//! Notification projection: extracted from the app-server connection boundary.

use super::*;

const STREAM_TEXT_CHUNK_BYTES: usize = 128 * 1024;
const TOOL_PREVIEW_BYTES: usize = 64 * 1024;

pub(super) fn input_preview(input: Value) -> (Value, bool, usize) {
    let encoded = serde_json::to_string(&input).expect("tool input serializes");
    let bytes = encoded.len();
    if bytes <= TOOL_PREVIEW_BYTES {
        return (input, false, bytes);
    }
    let (preview, _, _) = truncate_utf8_bytes(encoded, TOOL_PREVIEW_BYTES);
    (
        json!({"_truncated":true,"_preview":preview,"_original_bytes":bytes}),
        true,
        bytes,
    )
}

fn text_chunks(text: &str) -> impl Iterator<Item = &str> {
    let mut rest = text;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let mut end = rest.len().min(STREAM_TEXT_CHUNK_BYTES);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        let (part, remaining) = rest.split_at(end);
        rest = remaining;
        Some(part)
    })
}

impl StreamProjection {
    pub(super) fn new(
        server_id: String,
        thread_id: String,
        turn_id: String,
        sequence: Arc<AtomicU64>,
    ) -> Self {
        Self {
            server_id,
            thread_id,
            item_namespace: turn_id.clone(),
            turn_id,
            sequence,
            next_item: 1,
            assistant_item: None,
        }
    }

    pub(super) fn params(&self, payload: Value) -> Value {
        with_event_context(
            &self.server_id,
            &self.thread_id,
            Some(&self.turn_id),
            &self.sequence,
            payload,
        )
    }

    pub(super) fn project(&mut self, event: EngineEvent) -> Vec<Value> {
        self.project_with_client_message_id(event, None)
    }

    pub(super) fn project_with_client_message_id(
        &mut self,
        event: EngineEvent,
        client_message_id: Option<String>,
    ) -> Vec<Value> {
        if let EngineEvent::BackgroundScoped { identity, event } = event {
            let mut messages = self.project_with_client_message_id(*event, client_message_id);
            for message in &mut messages {
                if let Some(params) = message.get_mut("params").and_then(Value::as_object_mut) {
                    params.insert(
                        "identity".into(),
                        serde_json::to_value(&identity).expect("background identity serializes"),
                    );
                }
            }
            return messages;
        }
        match event {
            EngineEvent::SubagentSteerApplied {
                agent_id,
                message_id,
                queue_depth,
            } => vec![notification(
                method::AGENT_STEER_APPLIED,
                serde_json::to_value(AgentSteerAppliedParams {
                    identity: None,
                    context: kcoder_app_protocol::EventContext {
                        server_id: self.server_id.clone(),
                        thread_id: self.thread_id.clone(),
                        turn_id: Some(self.turn_id.clone()),
                        sequence: self.sequence.fetch_add(1, Ordering::SeqCst),
                    },
                    agent_id,
                    message_id,
                    queue_depth,
                    applied_at_ms: now_millis(),
                    client_message_id,
                })
                .expect("agent steer applied params serialize"),
            )],
            EngineEvent::AssistantMessageStarted => {
                let id = format!("{}-assistant-{}", self.item_namespace, self.next_item);
                self.next_item += 1;
                self.assistant_item = Some(id.clone());
                vec![notification(
                    "item/started",
                    self.params(json!({"item": {"id": id, "type": "agentMessage"}})),
                )]
            }
            EngineEvent::AssistantTextDelta(text) => {
                let id = self.assistant_item.clone().unwrap_or_else(|| {
                    let id = format!("{}-assistant-{}", self.item_namespace, self.next_item);
                    self.next_item += 1;
                    self.assistant_item = Some(id.clone());
                    id
                });
                text_chunks(&text)
                    .map(|text| {
                        notification(
                            "item/delta",
                            self.params(json!({"itemId":id,"delta":{"text":text}})),
                        )
                    })
                    .collect()
            }
            EngineEvent::AssistantMessageDone => self
                .assistant_item
                .take()
                .map(|id| {
                    notification(
                        "item/completed",
                        self.params(json!({
                            "item": {"id": id, "type": "agentMessage", "status": "completed"}
                        })),
                    )
                })
                .into_iter()
                .collect(),
            EngineEvent::AssistantThinkingDelta(text) => text_chunks(&text)
                .map(|text| {
                    notification(
                        "item/event",
                        self.params(json!({"event":{
                            "type":"assistant_thinking_delta","text":text
                        }})),
                    )
                })
                .collect(),
            EngineEvent::ToolUseStarted { id, name, input } => {
                // Full arguments remain in authoritative history; the live preview must fit
                // even when JSON escaping expands control characters sixfold.
                let (input, truncated, bytes) = input_preview(input);
                vec![notification(
                    "item/started",
                    self.params(json!({"item":{
                        "id":id,"type":"toolCall","name":name,"input":input,
                        "inputTruncated":truncated,"inputOriginalBytes":bytes
                    }})),
                )]
            }
            EngineEvent::ToolResult { id, name, output } => {
                let (images, images_omitted) = tool_images::observations(&output.content);
                let mut raw = engine_event_json(EngineEvent::ToolResult {
                    id: id.clone(),
                    name: name.clone(),
                    output,
                });
                let text = raw.get_mut("text").map(Value::take).unwrap_or(Value::Null);
                let (text, truncated, bytes) = match text {
                    Value::String(text) => {
                        let bytes = text.len();
                        let (preview, truncated, _) = truncate_utf8_bytes(text, TOOL_PREVIEW_BYTES);
                        (Value::String(preview), truncated, bytes)
                    }
                    other => (other, false, 0),
                };
                vec![notification(
                    "item/completed",
                    self.params(json!({
                        "item": {
                            "id": id,
                            "type": "toolCall",
                            "name": name,
                            "status": if raw.get("is_error").and_then(Value::as_bool).unwrap_or(false) { "failed" } else { "completed" },
                            "output": text,
                            "outputTruncated": truncated,
                            "outputOriginalBytes": bytes,
                            "outputImages": images,
                            "outputImagesOmitted": images_omitted,
                        },
                    })),
                )]
            }
            other => vec![notification(
                "item/event",
                self.params(json!({"event": engine_event_json(other)})),
            )],
        }
    }
}

pub(super) fn background_event_id(event: &EngineEvent) -> Option<&str> {
    match event.background_payload() {
        EngineEvent::BackgroundJobStarted { id, .. }
        | EngineEvent::SubagentSteerApplied { agent_id: id, .. }
        | EngineEvent::BackgroundJobAssociated { id, .. }
        | EngineEvent::BackgroundJobPromoted { id }
        | EngineEvent::BackgroundJobProgress { id, .. }
        | EngineEvent::BackgroundJobPaused { id, .. }
        | EngineEvent::BackgroundJobHalted { id, .. }
        | EngineEvent::BackgroundJobCompleted { id, .. }
        | EngineEvent::BackgroundJobFailed { id, .. }
        | EngineEvent::BackgroundJobCancelled { id, .. } => Some(id),
        _ => None,
    }
}

pub(super) fn tool_can_spawn_managed_background_job(name: &str) -> bool {
    matches!(
        name,
        "spawn_agent" | "explore_agent" | "PlanAgent" | "Workflow"
    )
}

pub(super) fn is_background_terminal_event(event: &EngineEvent) -> bool {
    matches!(
        event.background_payload(),
        EngineEvent::BackgroundJobCompleted { .. }
            | EngineEvent::BackgroundJobFailed { .. }
            | EngineEvent::BackgroundJobHalted { .. }
            | EngineEvent::BackgroundJobCancelled { .. }
    )
}

pub(super) fn agent_steer_result_from_receipt(
    client_message_id: Option<String>,
    receipt: kcoder_tools::SubagentSteerReceipt,
) -> AgentSteerResult {
    let status = match receipt.status {
        kcoder_tools::SubagentSteerStatus::Applied => AgentSteerStatus::Applied,
        kcoder_tools::SubagentSteerStatus::QueuedLive => AgentSteerStatus::QueuedLive,
        kcoder_tools::SubagentSteerStatus::QueuedPaused => AgentSteerStatus::QueuedPaused,
        kcoder_tools::SubagentSteerStatus::QueuedBehindBlocked => {
            AgentSteerStatus::QueuedBehindBlocked
        }
        kcoder_tools::SubagentSteerStatus::Resuming => AgentSteerStatus::Resuming,
        kcoder_tools::SubagentSteerStatus::Finishing => AgentSteerStatus::Finishing,
        kcoder_tools::SubagentSteerStatus::Cancelled => AgentSteerStatus::Cancelled,
        kcoder_tools::SubagentSteerStatus::Closed => AgentSteerStatus::Closed,
        kcoder_tools::SubagentSteerStatus::Rejected => AgentSteerStatus::Rejected,
    };
    AgentSteerResult {
        agent_id: receipt.agent_id,
        message_id: receipt.message_id,
        status,
        queued: receipt.queued,
        queue_position: receipt.queue_position,
        reason_code: receipt.reason_code,
        client_message_id,
    }
}

pub(super) fn with_event_context(
    server_id: &str,
    thread_id: &str,
    turn_id: Option<&str>,
    sequence: &AtomicU64,
    mut payload: Value,
) -> Value {
    let object = payload
        .as_object_mut()
        .expect("event notification payload must be an object");
    object.insert("serverId".into(), json!(server_id));
    object.insert("threadId".into(), json!(thread_id));
    if let Some(turn_id) = turn_id {
        object.insert("turnId".into(), json!(turn_id));
    }
    object.insert(
        "sequence".into(),
        json!(sequence.fetch_add(1, Ordering::Relaxed)),
    );
    payload
}

pub(super) fn turn_completion_error(
    message: Option<String>,
    details: Option<kcoder_types::ProviderFailureDetails>,
) -> Option<Value> {
    message.map(|message| json!({"code": -32010, "message": message, "details": details}))
}

/// Cancellation can close a provider socket before its transport returns an error.
/// Normalize before persisting or projecting the event, not only at turn completion.
pub(super) fn normalize_cancelled_terminal_event(
    event: EngineEvent,
    cancelled: bool,
) -> EngineEvent {
    if cancelled
        && matches!(
            &event,
            EngineEvent::Error(_)
                | EngineEvent::ProviderFailed { .. }
                | EngineEvent::StreamAborted { .. }
        )
    {
        EngineEvent::StreamAborted {
            reason: "cancelled by user".into(),
        }
    } else {
        event
    }
}

pub(super) fn terminal_outcome(
    event: &EngineEvent,
    cancelled: bool,
) -> Option<(&'static str, String)> {
    match event {
        EngineEvent::Error(message) | EngineEvent::ProviderFailed { message, .. } => {
            Some(("failed", message.clone()))
        }
        EngineEvent::StreamAborted { reason } => Some((
            if cancelled { "interrupted" } else { "failed" },
            reason.clone(),
        )),
        _ => None,
    }
}
