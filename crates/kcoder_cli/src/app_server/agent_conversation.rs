//! Connection-owned, bounded child conversation observers.
use super::*;
use kcoder_app_protocol::{
    AgentStreamEventParams, AgentStreamSnapshot, AgentStreamSubscribeParams,
    AgentStreamUnsubscribeParams,
};
use kcoder_engine::agent_conversation_stream::{
    AgentConversationDelta, AgentConversationEntry, AgentConversationSnapshot,
    AgentConversationSubscription,
};

const MAX_SUBSCRIPTIONS: usize = 16;

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
            ensure_active_thread(&engine, manager.lease(&params.thread_id), &params.thread_id)?;
            let subscription = engine.subscribe_subagent_conversation(&params.agent_id)?;
            let snapshot = project_snapshot(&params, &subscription.snapshot);
            Ok((params, subscription, snapshot, engine))
        })();
        let (params, subscription, snapshot, engine) = match result {
            Ok(value) => value,
            Err(error) => {
                send(outbound, error_response(id, -32025, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
        };
        self.unsubscribe(&params.subscription_id);
        // Queue response before allowing the subscription pump to publish any deltas.
        send(
            outbound,
            success_response(id, serde_json::to_value(&snapshot)?),
        )
        .await?;
        if snapshot.active {
            let key = params.subscription_id.clone();
            let thread_id = params.thread_id.clone();
            let outbound = outbound.clone();
            let server_id = server_id.to_owned();
            let handle = self.tasks.spawn(async move {
                let _ = pump(params, subscription, engine, outbound, server_id).await;
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
        .map(|entry| history_entry(snapshot, entry))
        .collect::<Vec<_>>();
    let mut contexts = TranscriptToolContexts::new();
    extend_transcript_tool_contexts(&mut contexts, &entries, 0);
    for (id, started_at) in &snapshot.tool_started_at_ms {
        if let Some(calls) = contexts.get_mut(id.as_str()) {
            for call in calls {
                call.started_at_ms = *started_at;
            }
        }
    }
    for (id, (name, input)) in &snapshot.tool_inputs {
        if let Some(calls) = contexts.get_mut(id.as_str()) {
            for call in calls {
                if !call.has_tool_use {
                    call.name = name.clone();
                    call.input = input.clone();
                }
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
        message.client_message_id = snapshot
            .entries
            .iter()
            .find(|entry| entry.id == message.id)
            .and_then(|entry| entry.client_message_id.clone());
        message.status = Some(
            if snapshot.active_assistant_item_id.as_deref() == Some(message.id.as_str()) {
                "streaming"
            } else {
                "done"
            }
            .into(),
        );
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
                message.blocks.push(json!({"id":id,"type":"tool","tool_name":name,"toolName":name,"status":"generating_arguments","timestamp":message.timestamp_ms,"argument_chars":chars}));
            }
        }
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
        pending_events: snapshot
            .pending_events
            .iter()
            .cloned()
            .map(engine_event_json)
            .collect(),
    }
}

fn history_entry(
    snapshot: &AgentConversationSnapshot,
    entry: &AgentConversationEntry,
) -> kcoder_state::HistoryEntry {
    kcoder_state::HistoryEntry {
        session_id: snapshot.run_id.clone(),
        timestamp_ms: entry.timestamp_ms,
        uuid: Some(entry.id.clone()),
        parent_uuid: None,
        message: entry.message.clone(),
    }
}

fn projection(
    server_id: &str,
    params: &AgentStreamSubscribeParams,
    snapshot: &AgentConversationSnapshot,
) -> StreamProjection {
    let mut projection = StreamProjection::new(
        server_id.into(),
        params.thread_id.clone(),
        snapshot.run_id.clone(),
        Arc::new(AtomicU64::new(snapshot.sequence + 1)),
    );
    projection.next_item = snapshot.next_assistant_item;
    projection.assistant_item = snapshot.active_assistant_item_id.clone();
    projection
}

async fn pump(
    params: AgentStreamSubscribeParams,
    mut subscription: AgentConversationSubscription,
    engine: QueryEngine,
    outbound: mpsc::Sender<Value>,
    server_id: String,
) -> Result<()> {
    let run_id = subscription.snapshot.run_id.clone();
    let mut projected = projection(&server_id, &params, &subscription.snapshot);
    let mut cursor = subscription.snapshot.sequence;
    loop {
        let received = tokio::select! {
            _ = outbound.closed() => return Ok(()),
            received = subscription.receiver.recv() => received,
        };
        // Deleting a parent/child invalidates its observer; retained stream data never grants authority.
        if !engine.state.task(&params.agent_id).is_some_and(|task| {
            task.kind == TaskKind::Subagent
                && task.parent_session_id.as_deref() == Some(params.thread_id.as_str())
        }) {
            return Ok(());
        }
        let frame = match received {
            Ok(frame) if frame.sequence <= cursor => continue,
            Ok(frame)
                if frame.sequence != cursor + 1
                    || matches!(frame.delta, AgentConversationDelta::Reset) =>
            {
                let snapshot = subscription.resynchronize();
                cursor = snapshot.sequence;
                projected = projection(&server_id, &params, &snapshot);
                send(
                    &outbound,
                    notification(
                        method::AGENT_STREAM_RESET,
                        serde_json::to_value(project_snapshot(&params, &snapshot))?,
                    ),
                )
                .await?;
                if !snapshot.active {
                    return Ok(());
                }
                continue;
            }
            Ok(frame) => frame,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                let snapshot = subscription.resynchronize();
                cursor = snapshot.sequence;
                projected = projection(&server_id, &params, &snapshot);
                send(
                    &outbound,
                    notification(
                        method::AGENT_STREAM_RESET,
                        serde_json::to_value(project_snapshot(&params, &snapshot))?,
                    ),
                )
                .await?;
                if !snapshot.active {
                    return Ok(());
                }
                continue;
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return Ok(()),
        };
        cursor = frame.sequence;
        let (notifications, finished) = match frame.delta {
            AgentConversationDelta::Event(event) => (projected.project(event), false),
            AgentConversationDelta::UserMessage(entry) => {
                let history = history_entry(&subscription.snapshot, &entry);
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
            let event = AgentStreamEventParams {
                thread_id: params.thread_id.clone(),
                agent_id: params.agent_id.clone(),
                subscription_id: params.subscription_id.clone(),
                run_id: run_id.clone(),
                sequence: cursor,
                occurred_at_ms: frame.occurred_at_ms,
                method: notification_frame["method"]
                    .as_str()
                    .unwrap_or("item/event")
                    .into(),
                params: notification_frame["params"].clone(),
            };
            send(
                &outbound,
                notification(method::AGENT_STREAM_EVENT, serde_json::to_value(event)?),
            )
            .await?;
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
            thread_id: "parent".into(),
            agent_id: "child".into(),
            subscription_id: "view".into(),
        }
    }
    fn snapshot() -> AgentConversationSnapshot {
        AgentConversationSnapshot {
            run_id: "run".into(),
            sequence: 4,
            active: true,
            status: "running".into(),
            entries: vec![AgentConversationEntry {
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
        let mut projection = projection("server", &params(), &source);
        let event = projection.project(EngineEvent::AssistantTextDelta("suffix".into()));
        assert_eq!(event[0]["params"]["itemId"], projected.messages[0].id);
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
