//! Connection-owned, bounded child conversation observers.
use super::*;
use crate::app_server::task_spawn::JoinSetExt as _;
use kcoder_app_protocol::{
    AgentStreamEventParams, AgentStreamSnapshot, AgentStreamSubscribeParams,
    AgentStreamUnsubscribeParams,
};
use kcoder_engine::agent_conversation_stream::{
    AgentConversationDelta, AgentConversationEntry, AgentConversationSnapshot,
    AgentConversationSubscription,
};
use kcoder_types::{ContentBlock, Message};

mod delivery;
use delivery::StreamDelivery;
pub(super) use delivery::StreamObservation;

const MAX_SUBSCRIPTIONS: usize = 16;
const OWNER_IDLE_CHECK_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Default)]
pub(super) struct AgentConversationSubscriptions {
    tasks: tokio::task::JoinSet<()>,
    handles: HashMap<String, (String, tokio::task::AbortHandle)>,
}

impl AgentConversationSubscriptions {
    fn unsubscribe(&mut self, id: &str) -> bool {
        if let Some((_, handle)) = self.handles.remove(id) {
            handle.abort();
            true
        } else {
            false
        }
    }

    pub(super) fn unsubscribe_thread(&mut self, thread_id: &str) {
        self.handles.retain(|_, (thread, handle)| {
            if thread == thread_id {
                handle.abort();
                false
            } else {
                true
            }
        });
    }

    pub(super) async fn shutdown(&mut self) {
        self.tasks.abort_all();
        while self.tasks.join_next().await.is_some() {}
        self.handles.clear();
    }

    pub(super) async fn dispatch(
        &mut self,
        method_name: &str,
        id: Value,
        params: Value,
        manager: &ThreadManager,
        outbound: &mpsc::Sender<Value>,
        server_id: &str,
    ) -> Result<DispatchControl> {
        while self.tasks.try_join_next().is_some() {}
        self.handles.retain(|_, (_, handle)| !handle.is_finished());
        if method_name == method::AGENT_STREAM_UNSUBSCRIBE {
            let params: AgentStreamUnsubscribeParams = match serde_json::from_value(params) {
                Ok(value) => value,
                Err(error) => {
                    send(outbound, error_response(id, -32602, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            let removed = self.unsubscribe(&params.subscription_id);
            send(
                outbound,
                success_response(
                    id,
                    json!({"subscriptionId":params.subscription_id,"unsubscribed":removed}),
                ),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        let result = (|| -> Result<_> {
            let params: AgentStreamSubscribeParams = serde_json::from_value(params)?;
            anyhow::ensure!(
                !params.subscription_id.is_empty() && params.subscription_id.len() <= 128,
                "subscriptionId must contain 1..=128 bytes"
            );
            anyhow::ensure!(
                self.handles.len() < MAX_SUBSCRIPTIONS
                    || self.handles.contains_key(&params.subscription_id),
                "agent conversation subscription capacity reached"
            );
            let engine = manager
                .engine(&params.thread_id)
                .context("thread/start or thread/resume is required")?;
            let lease = manager
                .lease(&params.thread_id)
                .context("thread/start or thread/resume is required")?;
            let observer = StreamObservation::capture(&engine, lease, &params)?;
            let subscription = if let Some(expected) = params.expected_background_run.as_ref() {
                engine
                    .subscribe_subagent_conversation_for_run(expected)
                    .map_err(|_| {
                        anyhow::Error::from(agent_run_constraint::ExactRunUnavailable(
                            kcoder_app_protocol::AgentStreamCloseReason::OwnerUnavailable,
                        ))
                    })?
            } else {
                engine.subscribe_subagent_conversation(&params.agent_id)?
            };
            let snapshot = project_snapshot(&params, &subscription.snapshot);
            Ok((params, subscription, snapshot, engine, observer))
        })();
        let (params, subscription, snapshot, engine, observer) = match result {
            Ok(value) => value,
            Err(error) => {
                send(
                    outbound,
                    error_response(
                        id,
                        agent_run_constraint::response_code(&error, -32025),
                        &error.to_string(),
                    ),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
        };
        let reply = success_response(id.clone(), serde_json::to_value(&snapshot)?);
        let slot = outbound
            .reserve()
            .await
            .context("app-server outbound queue closed")?;
        if let Err(error) = observer.verify(&engine, &params) {
            slot.send(error_response(
                id,
                agent_run_constraint::response_code(&error, -32025),
                &error.to_string(),
            ));
            return Ok(DispatchControl::Continue);
        }
        self.unsubscribe(&params.subscription_id);
        // The initial snapshot and live emissions share the same publication boundary.
        slot.send(reply);
        if snapshot.active {
            let key = params.subscription_id.clone();
            let thread_id = params.thread_id.clone();
            let outbound = outbound.clone();
            let server_id = server_id.to_owned();
            let handle = self.tasks.spawn_shared(async move {
                let _ = pump(params, subscription, engine, outbound, server_id, observer).await;
            });
            self.handles.insert(key, (thread_id, handle));
        }
        Ok(DispatchControl::Continue)
    }
}

fn project_snapshot(
    params: &AgentStreamSubscribeParams,
    snapshot: &AgentConversationSnapshot,
) -> AgentStreamSnapshot {
    let entries = snapshot
        .entries
        .iter()
        .map(|entry| history_entry(snapshot, entry, params.include_reasoning))
        .collect::<Vec<_>>();
    let mut contexts = TranscriptToolContexts::new();
    extend_transcript_tool_contexts(&mut contexts, &entries, 0);
    for (id, started_at) in &snapshot.tool_started_at_ms {
        if let Some(calls) = contexts.get_mut(id.as_str()) {
            for call in calls {
                call.observe_start(*started_at);
            }
        }
    }
    for (id, (name, input)) in &snapshot.tool_inputs {
        if let Some(calls) = contexts.get_mut(id.as_str()) {
            for call in calls {
                call.fill_unrecorded_input(name, input);
            }
        }
    }
    let mut messages = entries.into_iter().enumerate().filter_map(|(index, entry)| {
        let active_empty = snapshot.active_assistant_item_id.as_deref() == entry.uuid.as_deref();
        let id = entry.uuid.clone();
        let timestamp = entry.timestamp_ms;
        history_entry_thread_message(index, entry, Some(snapshot.run_id.clone()), &contexts).or_else(|| active_empty.then(|| serde_json::from_value(json!({"id":id,"role":"assistant","content":"","timestampMs":timestamp,"turnId":snapshot.run_id})).expect("empty assistant uses the ordinary ThreadMessage contract")))
    }).collect::<Vec<_>>();
    for message in &mut messages {
        let entry = snapshot.entries.iter().find(|entry| entry.id == message.id);
        message.client_message_id = entry.and_then(|entry| entry.client_message_id.clone());
        message.status = Some(
            if snapshot.active_assistant_item_id.as_deref() == Some(message.id.as_str()) {
                "streaming"
            } else {
                "done"
            }
            .into(),
        );
        if params.include_reasoning
            && let Some(entry) = entry
        {
            let mut phases = entry.thinking.iter();
            let mut preceding_timestamp = message.timestamp_ms;
            for block in &mut message.blocks {
                if block["type"] == "thinking"
                    && let Some(phase) = phases.next()
                {
                    block["id"] = json!(phase.id);
                    block["timestamp"] = json!(phase.started_at_ms.max(preceding_timestamp));
                    block["status"] = json!(if phase.completed_at_ms.is_some() {
                        "done"
                    } else {
                        "streaming"
                    });
                    if let Some(completed_at) = phase.completed_at_ms {
                        block["completedAt"] = json!(completed_at);
                    }
                } else if block["type"] == "text" {
                    // Checkpoint prose has only the assistant's start time.
                    // Preserve its position after a preceding timed phase.
                    block["timestamp"] = json!(preceding_timestamp);
                }
                preceding_timestamp =
                    preceding_timestamp.max(block["timestamp"].as_u64().unwrap_or(0));
            }
        }
        if !snapshot.active {
            for block in &mut message.blocks {
                if block.get("type").and_then(Value::as_str) == Some("tool")
                    && matches!(
                        block.get("status").and_then(Value::as_str),
                        Some("running" | "pending")
                    )
                {
                    block["status"] = json!("unknown");
                    block["tool_output"] = json!("Result was not recorded.");
                }
            }
        }
    }
    if let Some(active_id) = &snapshot.active_assistant_item_id
        && let Some(message) = messages.iter_mut().find(|message| &message.id == active_id)
    {
        for event in &snapshot.pending_events {
            if let EngineEvent::ToolInputProgress {
                id, name, chars, ..
            } = event
            {
                let timestamp = message
                    .blocks
                    .last()
                    .and_then(|block| block["timestamp"].as_u64())
                    .unwrap_or(message.timestamp_ms);
                message.blocks.push(json!({"id":id,"type":"tool","tool_name":name,"toolName":name,"status":"generating_arguments","timestamp":timestamp,"argument_chars":chars}));
            }
        }
    }
    if snapshot.status == "failed"
        && let Some(failure) = &snapshot.failure
    {
        if let Some(message) = messages
            .iter_mut()
            .find(|message| message.id == failure.item_id)
        {
            message.status = Some("failed".into());
            message.error = Some(failure.message.clone());
            message.provider_failure = failure.details.clone();
        } else {
            messages.push(serde_json::from_value(json!({
                "id": failure.item_id, "role": "assistant", "content": "", "status": "failed",
                "error": failure.message, "providerFailure": failure.details, "timestampMs": failure.timestamp_ms,
                "turnId": snapshot.run_id,
            })).expect("failed assistant uses the ordinary ThreadMessage contract"));
        }
    }
    let mut pending_events: Vec<_> = snapshot
        .pending_events
        .iter()
        .cloned()
        .map(engine_event_json)
        .collect();
    if snapshot.active && snapshot.thinking_active {
        pending_events.push(thinking_started());
    }
    if snapshot.active
        && let Some((retry, since)) = &snapshot.provider_retry
    {
        let mut retry = retry.clone();
        retry.retry_after_ms = retry
            .retry_after_ms
            .saturating_sub(since.elapsed().as_millis().min(u128::from(u64::MAX)) as u64);
        pending_events.push(engine_event_json(EngineEvent::ProviderRetry(retry)));
    }
    AgentStreamSnapshot {
        thread_id: params.thread_id.clone(),
        agent_id: params.agent_id.clone(),
        subscription_id: params.subscription_id.clone(),
        run_id: snapshot.run_id.clone(),
        sequence: snapshot.sequence,
        active: snapshot.active,
        status: snapshot.status.clone(),
        messages,
        truncated: snapshot.truncated,
        active_assistant_item_id: snapshot.active_assistant_item_id.clone(),
        next_assistant_item: snapshot.next_assistant_item,
        pending_events,
    }
}

fn thinking_started() -> Value {
    json!({"type":"assistant_thinking_started"})
}

fn history_entry(
    snapshot: &AgentConversationSnapshot,
    entry: &AgentConversationEntry,
    include_reasoning: bool,
) -> kcoder_state::HistoryEntry {
    let mut message = entry.message.clone();
    if include_reasoning && let Message::Assistant { content, .. } = &mut message {
        for (offset, phase) in entry.thinking.iter().enumerate() {
            let index = (phase.before_block + offset).min(content.len());
            let text = phase.text.as_str();
            let block = if text.is_empty() {
                ContentBlock::RedactedThinking {
                    data: String::new(),
                }
            } else {
                ContentBlock::Thinking {
                    thinking: text.to_owned(),
                    signature: String::new(),
                }
            };
            content.insert(index, block);
        }
    }
    kcoder_state::HistoryEntry {
        web_sources: entry.web_sources.clone(),
        history_attempt: entry
            .web_sources
            .first()
            .map(|receipt| receipt.identity.clone()),
        session_id: entry
            .web_sources
            .first()
            .map(|receipt| receipt.identity.thread_id.clone())
            .unwrap_or_else(|| snapshot.run_id.clone()),
        timestamp_ms: entry.timestamp_ms,
        uuid: Some(entry.id.clone()),
        parent_uuid: None,
        message,
    }
}

fn projection(
    server_id: &str,
    params: &AgentStreamSubscribeParams,
    snapshot: &AgentConversationSnapshot,
    sequence: Arc<AtomicU64>,
) -> StreamProjection {
    let mut projection = StreamProjection::new(
        server_id.into(),
        params.thread_id.clone(),
        snapshot.run_id.clone(),
        sequence,
    );
    projection.native_child_sources = true;
    projection.next_item = snapshot.next_assistant_item;
    projection.assistant_item = snapshot.active_assistant_item_id.clone();
    projection
}

fn projected_event(
    subscription: &AgentStreamSubscribeParams,
    run_id: &str,
    occurred_at_ms: u64,
    notification: &Value,
) -> Result<AgentStreamEventParams> {
    let params = &notification["params"];
    let sequence = params["sequence"]
        .as_u64()
        .context("child conversation notification has no sequence")?;
    Ok(AgentStreamEventParams {
        thread_id: subscription.thread_id.clone(),
        agent_id: subscription.agent_id.clone(),
        subscription_id: subscription.subscription_id.clone(),
        run_id: run_id.to_owned(),
        sequence,
        occurred_at_ms,
        method: notification["method"]
            .as_str()
            .unwrap_or("item/event")
            .into(),
        params: params.clone(),
    })
}

/// Runs the full exact-run verification. On failure it publishes
/// `agent/stream/closed` and returns `false`; the caller must end the pump.
pub(super) async fn exact_run_still_current(
    exact: &agent_run_constraint::AgentRunObservation,
    engine: &QueryEngine,
    outbound: &mpsc::Sender<Value>,
    subscription_id: &str,
) -> Result<bool> {
    let Err(error) = exact.verify(engine) else {
        return Ok(true);
    };
    send(
        outbound,
        notification(
            kcoder_app_protocol::AGENT_STREAM_CLOSED,
            serde_json::to_value(exact.closed(subscription_id, &error))?,
        ),
    )
    .await?;
    Ok(false)
}

pub(super) async fn pump(
    params: AgentStreamSubscribeParams,
    mut subscription: AgentConversationSubscription,
    engine: QueryEngine,
    outbound: mpsc::Sender<Value>,
    server_id: String,
    observer: StreamObservation,
) -> Result<()> {
    if !subscription.snapshot.active {
        return Ok(());
    }
    let run_id = subscription.snapshot.run_id.clone();
    // Source frames can project to zero or several notifications. Client
    // cursors count the actual notifications within this subscription.
    let sequence = Arc::new(AtomicU64::new(subscription.snapshot.sequence + 1));
    let mut projected = projection(
        &server_id,
        &params,
        &subscription.snapshot,
        sequence.clone(),
    );
    let mut cursor = subscription.snapshot.sequence;
    let mut delivery = StreamDelivery::new(&engine, &observer, &params, &outbound);
    let mut tick = tokio::time::interval_at(
        tokio::time::Instant::now() + OWNER_IDLE_CHECK_INTERVAL,
        OWNER_IDLE_CHECK_INTERVAL,
    );
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let received = tokio::select! {
            biased;
            _ = outbound.closed() => return Ok(()),
            _ = tokio::time::sleep_until(delivery.next_flush), if !delivery.pending.is_empty() => {
                if !delivery.flush().await? { return Ok(()); }
                continue;
            },
            _ = tick.tick(), if matches!(observer, StreamObservation::Exact(_)) => {
                if let StreamObservation::Exact(exact) = &observer
                    && !exact_run_still_current(exact, &engine, &outbound, &params.subscription_id).await?
                {
                    return Ok(());
                }
                continue;
            },
            received = subscription.receiver.recv() => received,
            // Batch together frames that are already available, without
            // waiting for a future fragment just to fill the batch.
            _ = std::future::ready(()), if !delivery.pending.is_empty() => {
                if !delivery.flush().await? { return Ok(()); }
                continue;
            },
        };
        let frame = match received {
            Ok(frame) if frame.sequence <= cursor => continue,
            Ok(frame)
                if frame.sequence == cursor + 1
                    && !matches!(frame.delta, AgentConversationDelta::Reset) =>
            {
                frame
            }
            Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                let snapshot = subscription.resynchronize();
                cursor = snapshot.sequence;
                let mut reset = project_snapshot(&params, &snapshot);
                reset.sequence = sequence.fetch_add(1, Ordering::Relaxed);
                projected = projection(&server_id, &params, &snapshot, sequence.clone());
                delivery.pending.push(notification(
                    method::AGENT_STREAM_RESET,
                    serde_json::to_value(reset)?,
                ));
                if !delivery.flush().await? || !snapshot.active {
                    return Ok(());
                }
                continue;
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                if !delivery.pending.is_empty() {
                    delivery.flush().await?;
                } else if let StreamObservation::Exact(exact) = &observer {
                    exact_run_still_current(exact, &engine, &outbound, &params.subscription_id)
                        .await?;
                }
                return Ok(());
            }
        };
        cursor = frame.sequence;
        let immediate = !delivery::small_stream_delta(&frame.delta);
        let (notifications, finished) = match frame.delta {
            AgentConversationDelta::Event(event) => (projected.project(event), false),
            AgentConversationDelta::ThinkingStarted => (
                vec![notification(
                    "item/event",
                    projected.params(json!({"event":thinking_started()})),
                )],
                false,
            ),
            AgentConversationDelta::ThinkingDelta {
                item_id,
                block_id,
                text,
            } if params.include_reasoning => (
                vec![notification("item/event", projected.params(json!({
                    "itemId": item_id,
                    "event": {"type":"assistant_thinking_delta","id":block_id,"text":text.as_str()},
                })))],
                false,
            ),
            AgentConversationDelta::ThinkingCompleted { item_id, block_id }
                if params.include_reasoning =>
            {
                (
                    vec![notification(
                        "item/event",
                        projected.params(json!({
                            "itemId": item_id,
                            "event": {"type":"assistant_thinking_completed","id":block_id},
                        })),
                    )],
                    false,
                )
            }
            AgentConversationDelta::ThinkingDelta { .. }
            | AgentConversationDelta::ThinkingCompleted { .. } => (Vec::new(), false),
            AgentConversationDelta::UserMessage(entry) => {
                let history = history_entry(&subscription.snapshot, &entry, false);
                let mut message = history_entry_thread_message(
                    0,
                    history,
                    Some(run_id.clone()),
                    &TranscriptToolContexts::new(),
                );
                if let Some(message) = &mut message {
                    message.client_message_id = entry.client_message_id.clone();
                }
                (vec![notification("item/started", projected.params(json!({"item":{"id":entry.id,"type":"userMessage","clientMessageId":entry.client_message_id,"text":message.as_ref().map(|m|m.content.clone()).unwrap_or_default(),"message":message}})))], false)
            }
            AgentConversationDelta::Finished { status } => (
                vec![notification(
                    "turn/completed",
                    projected.params(json!({"turn":{"id":run_id,"status":status}})),
                )],
                true,
            ),
            AgentConversationDelta::Reset => unreachable!("reset handled before projection"),
        };
        for notification_frame in notifications {
            let event =
                projected_event(&params, &run_id, frame.occurred_at_ms, &notification_frame)?;
            delivery.pending.push(notification(
                method::AGENT_STREAM_EVENT,
                serde_json::to_value(event)?,
            ));
        }
        if delivery.should_flush(immediate) && !delivery.flush().await? {
            return Ok(());
        }
        if finished {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::{ContentBlock, Message};
    fn params() -> AgentStreamSubscribeParams {
        AgentStreamSubscribeParams {
            expected_background_run: None,
            thread_id: "parent".into(),
            agent_id: "child".into(),
            subscription_id: "view".into(),
            include_reasoning: false,
        }
    }

    #[test]
    fn owned_child_snapshot_restores_thinking_between_narrative_and_tools() {
        let mut source = snapshot();
        source.entries[0].thinking.push(
            kcoder_engine::agent_conversation_stream::AgentConversationThinking {
                id: "reasoning".into(),
                before_block: 1,
                started_at_ms: 11,
                completed_at_ms: Some(22),
                text: String::from("checking which file to read").into(),
            },
        );
        let mut request = params();
        let public = project_snapshot(&request, &source);
        assert!(
            !serde_json::to_string(&public)
                .unwrap()
                .contains("which file")
        );
        request.include_reasoning = true;
        let owned = project_snapshot(&request, &source);
        let blocks = &owned.messages[0].blocks;
        assert_eq!(
            blocks
                .iter()
                .map(|block| block["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["text", "thinking", "tool"]
        );
        assert_eq!(blocks[1]["content"], "checking which file to read");
        assert_eq!(blocks[1]["id"], "reasoning");
        assert_eq!(blocks[1]["status"], "done");
        assert_eq!(blocks[1]["completedAt"], 22);
    }

    #[test]
    fn observing_empty_and_split_deltas_keeps_contiguous_notification_sequences() {
        let params = params();
        let snapshot = snapshot();
        let sequence = Arc::new(AtomicU64::new(snapshot.sequence + 1));
        let mut view = projection("target", &params, &snapshot, sequence.clone());
        assert!(
            view.project(EngineEvent::AssistantTextDelta(String::new()))
                .is_empty()
        );
        let text = "你".repeat(100_000);
        let notifications = view.project(EngineEvent::AssistantTextDelta(text.clone()));
        assert!(notifications.len() > 1);
        let mut cursor = snapshot.sequence;
        let mut visible = String::new();
        for notification in notifications {
            let frame = projected_event(&params, &snapshot.run_id, 18, &notification).unwrap();
            assert_eq!(frame.sequence, cursor + 1);
            assert_eq!(frame.occurred_at_ms, 18);
            visible.push_str(frame.params["delta"]["text"].as_str().unwrap());
            cursor = frame.sequence;
        }
        assert_eq!(visible, text);

        // Resynchronization can rewind the projector to a different source
        // cursor, while the client's notification cursor keeps advancing.
        assert_eq!(sequence.fetch_add(1, Ordering::Relaxed), cursor + 1);
        let mut view = projection("target", &params, &snapshot, sequence);
        let next = view.project(EngineEvent::AssistantMessageDone);
        let frame = projected_event(&params, &snapshot.run_id, 20, &next[0]).unwrap();
        assert_eq!(frame.sequence, cursor + 2);
    }

    fn snapshot() -> AgentConversationSnapshot {
        AgentConversationSnapshot {
            run_id: "run".into(),
            sequence: 4,
            public_revision: 4,
            active: true,
            status: "running".into(),
            thinking_active: false,
            provider_retry: None,
            failure: None,
            entries: vec![AgentConversationEntry {
                web_sources: Vec::new(),
                thinking: Vec::new(),
                id: "run-assistant-1".into(),
                client_message_id: None,
                timestamp_ms: 10,
                message: Message::Assistant {
                    usage: None,
                    content: vec![
                        ContentBlock::Text {
                            text: "checking files".into(),
                        },
                        ContentBlock::ToolUse {
                            id: "read-1".into(),
                            name: "read".into(),
                            input: json!({"path":"main.rs"}),
                        },
                    ],
                },
            }],
            truncated: false,
            active_assistant_item_id: Some("run-assistant-1".into()),
            next_assistant_item: 2,
            pending_events: vec![],
            tool_started_at_ms: HashMap::from([("read-1".into(), 20)]),
            tool_inputs: HashMap::from([(
                "read-1".into(),
                ("read".into(), json!({"path":"main.rs"})),
            )]),
        }
    }
    #[test]
    fn snapshot_uses_ordinary_transcript_tool_projection_and_live_ids() {
        let source = snapshot();
        let projected = project_snapshot(&params(), &source);
        assert_eq!(projected.messages[0].id, "run-assistant-1");
        assert_eq!(projected.messages[0].status.as_deref(), Some("streaming"));
        let tool = projected.messages[0]
            .blocks
            .iter()
            .find(|block| block["type"] == "tool")
            .unwrap();
        assert_eq!(tool["tool_name"], "read");
        assert_eq!(tool["tool_input"]["path"], "main.rs");
        assert_eq!(tool["timestamp"], 20);
        let sequence = Arc::new(AtomicU64::new(source.sequence + 1));
        let mut projection = projection("server", &params(), &source, sequence);
        let event = projection.project(EngineEvent::AssistantTextDelta("suffix".into()));
        assert_eq!(event[0]["params"]["itemId"], projected.messages[0].id);
    }

    #[test]
    fn child_snapshot_restores_remaining_retry_time_and_provider_failure() {
        let mut source = snapshot();
        source.provider_retry = Some((
            kcoder_engine::ProviderRetryDetails {
                request_kind: "main".into(),
                provider: "owned".into(),
                model: "test-model".into(),
                attempt: 2,
                max_retries: 5,
                elapsed_ms: 100,
                turn_elapsed_ms: 200,
                transport_elapsed_ms: 100,
                retry_after_ms: 10_000,
                first_token_ms: None,
                last_token_ms: None,
                timeout_kind: None,
                reason: "network_error".into(),
            },
            std::time::Instant::now() - Duration::from_secs(2),
        ));
        let active = project_snapshot(&params(), &source);
        let retry = active
            .pending_events
            .iter()
            .find(|event| event["kind"] == "provider_retry")
            .unwrap();
        assert_eq!(retry["attempt"], 2);
        assert!(retry["retry_after_ms"].as_u64().unwrap() <= 8_000);
        source.active = false;
        source.status = "failed".into();
        source.failure = Some(
            kcoder_engine::agent_conversation_stream::AgentConversationFailure {
                item_id: "run:assistant".into(),
                message: "owned diagnostic".into(),
                details: Some(kcoder_types::ProviderFailureDetails {
                    category: kcoder_types::ProviderFailureCategory::AuthenticationError,
                    recovery_action: kcoder_types::ProviderFailureRecoveryAction::NeedsHuman,
                    http_status: Some(401),
                    retryable: false,
                    resume_safe: false,
                    retry_after_ms: None,
                    context_preflight: None,
                }),
                timestamp_ms: 30,
            },
        );
        let terminal = project_snapshot(&params(), &source);
        assert!(
            terminal
                .pending_events
                .iter()
                .all(|event| event["kind"] != "provider_retry")
        );
        let error = terminal
            .messages
            .iter()
            .find(|message| message.id == "run:assistant")
            .unwrap();
        assert_eq!(error.status.as_deref(), Some("failed"));
        assert_eq!(error.error.as_deref(), Some("owned diagnostic"));
        assert_eq!(
            error.provider_failure.as_ref().unwrap().http_status,
            Some(401)
        );
    }

    #[test]
    fn initial_snapshot_text_moves_to_text_block_before_tools_without_loss() {
        let mut source = snapshot();
        let first = "## 分析进度\n\n正在检查项目。\nS03_LIVE_VISIBLE";
        source.entries[0].message = Message::assistant_text(first);
        source.tool_inputs.clear();
        source.tool_started_at_ms.clear();
        let middle = project_snapshot(&params(), &source);
        assert_eq!(middle.messages[0].content, first);
        assert_eq!(middle.messages[0].id, "run-assistant-1");
        assert_eq!(
            middle.active_assistant_item_id.as_deref(),
            Some("run-assistant-1")
        );
        let full = format!("{first}\n\nS03_SECOND_LIVE_DELTA\n\nS03_THIRD_LIVE_DELTA");
        source.entries[0].message = Message::Assistant {
            usage: None,
            content: vec![
                ContentBlock::Text { text: full.clone() },
                ContentBlock::ToolUse {
                    id: "bash".into(),
                    name: "bash".into(),
                    input: json!({"command":"inspect"}),
                },
            ],
        };
        source.active_assistant_item_id = None;
        source.next_assistant_item = 3;
        source.entries.push(AgentConversationEntry {
            web_sources: Vec::new(),
            thinking: Vec::new(),
            id: "run-assistant-2".into(),
            client_message_id: None,
            timestamp_ms: 30,
            message: Message::Assistant {
                usage: None,
                content: vec![ContentBlock::ToolUse {
                    id: "question".into(),
                    name: "AskUserQuestion".into(),
                    input: json!({"questions":[]}),
                }],
            },
        });
        let reopened = project_snapshot(&params(), &source);
        assert_eq!(reopened.messages[0].id, "run-assistant-1");
        assert!(
            reopened.messages[0].content.is_empty(),
            "ordinary transcript places commentary before tools in text blocks"
        );
        assert_eq!(reopened.messages[0].blocks[0]["type"], "text");
        assert_eq!(reopened.messages[0].blocks[0]["content"], full);
        assert_eq!(reopened.messages[0].blocks[1]["tool_name"], "bash");
        assert_eq!(
            reopened.messages[1].blocks[0]["tool_name"],
            "AskUserQuestion"
        );
        assert!(reopened.active_assistant_item_id.is_none());
    }
    #[test]
    fn empty_live_assistant_is_present_and_inactive_tools_settle_without_false_success() {
        let mut source = snapshot();
        source.entries[0].message = Message::assistant_text("");
        let projected = project_snapshot(&params(), &source);
        assert_eq!(projected.messages.len(), 1);
        assert_eq!(projected.messages[0].id, "run-assistant-1");
        source = snapshot();
        source.active = false;
        source.active_assistant_item_id = None;
        let projected = project_snapshot(&params(), &source);
        let tool = projected.messages[0]
            .blocks
            .iter()
            .find(|block| block["type"] == "tool")
            .unwrap();
        assert_eq!(tool["status"], "unknown");
        assert_ne!(tool["status"], "done");
    }
    #[tokio::test]
    async fn subscriptions_abort_on_unsubscribe_and_shutdown() {
        let mut streams = AgentConversationSubscriptions::default();
        let handle = streams.tasks.spawn(std::future::pending());
        streams
            .handles
            .insert("view".into(), ("parent".into(), handle.clone()));
        assert!(streams.unsubscribe("view"));
        streams.tasks.join_next().await;
        assert!(handle.is_finished());
        let other = streams.tasks.spawn(std::future::pending());
        streams
            .handles
            .insert("other".into(), ("parent".into(), other.clone()));
        streams.shutdown().await;
        assert!(other.is_finished());
        assert!(streams.handles.is_empty());
    }
}
