use agent_client_protocol::schema::v1::{SessionNotification, StopReason};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// Ordered native-to-ACP projection bound to one authoritative thread and turn.
pub struct TurnProjection {
    session_id: String,
    thread_id: String,
    turn_id: String,
    sequence: Option<u64>,
    tools: BTreeMap<String, bool>,
    input_tools: BTreeSet<String>,
    generation: u64,
    tool_count: usize,
    approval_tools: BTreeSet<String>,
    text_items: BTreeSet<String>,
    model_stop_reason: Option<&'static str>,
    finished: bool,
}

impl TurnProjection {
    /// The caller obtains `thread_id` and `turn_id` from app-server receipts.
    pub fn new(session_id: String, thread_id: String, turn_id: String) -> Self {
        Self {
            session_id,
            thread_id,
            turn_id,
            sequence: None,
            tools: BTreeMap::new(),
            input_tools: BTreeSet::new(),
            generation: 0,
            tool_count: 0,
            approval_tools: BTreeSet::new(),
            text_items: BTreeSet::new(),
            model_stop_reason: None,
            finished: false,
        }
    }

    /// Project visible text, bounded parameter progress and registered tool lifecycle.
    /// Unrelated sessions/turns and duplicate or late notifications are ignored.
    pub fn project(&mut self, frame: &Value) -> Result<Vec<SessionNotification>> {
        let params = &frame["params"];
        if self.finished || params["threadId"] != self.thread_id || params["turnId"] != self.turn_id
        {
            return Ok(Vec::new());
        }
        let Some(sequence) = params["sequence"].as_u64() else {
            return Ok(Vec::new());
        };
        if self.sequence.is_some_and(|last| sequence <= last) {
            return Ok(Vec::new());
        }
        self.sequence = Some(sequence);
        let mut updates = Vec::new();
        match frame["method"].as_str() {
            Some("item/started") => {
                let item = &params["item"];
                if item["type"] == "agentMessage" {
                    self.model_stop_reason = None;
                    if let Some(id) = item["id"].as_str() {
                        ensure!(
                            self.text_items.len() < 4096 || self.text_items.contains(id),
                            "ACP message count limit reached"
                        );
                        self.text_items.insert(id.into());
                    }
                } else if item["type"] == "toolCall" {
                    let id = item["id"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("Native tool identity is missing"))?;
                    if !self.tools.contains_key(id) {
                        self.register_tool(id)?;
                        let name = item["name"].as_str().unwrap_or("tool");
                        updates.push(self.update(json!({"sessionUpdate":"tool_call", "toolCallId":id,
                            "name":name, "title":name, "kind":tool_kind(name), "status":"pending", "rawInput":item["input"]}))?);
                    } else if self.input_tools.remove(id) || self.approval_tools.remove(id) {
                        let name = item["name"].as_str().unwrap_or("tool");
                        updates.push(
                            self.update(
                                json!({"sessionUpdate":"tool_call_update","toolCallId":id,
                            "title":name,"kind":tool_kind(name),"rawInput":item["input"],"content":[],"_meta":{"kcoder/inputProgress":null}}),
                            )?,
                        );
                    } else if self.tools.get(id) == Some(&true) {
                        anyhow::bail!(
                            "Native reused a completed tool identity in one provider request; effects may be unknown"
                        );
                    }
                }
            }
            Some("item/delta") => {
                if let Some(id) = params["itemId"].as_str()
                    && self.text_items.contains(id)
                    && let Some(text) = params["delta"]["text"].as_str()
                {
                    updates.push(self.text("agent_message_chunk", text)?);
                }
            }
            Some("item/event") => {
                let event = &params["event"];
                if event["type"] == "tool_input_reset" {
                    ensure!(
                        self.tools
                            .iter()
                            .all(|(id, terminal)| *terminal || self.input_tools.contains(id)),
                        "Native provider restarted before an active tool settled; effects may be unknown"
                    );
                    let next_generation = self
                        .generation
                        .checked_add(1)
                        .ok_or_else(|| anyhow::anyhow!("ACP input generation limit reached"))?;
                    for id in &self.input_tools {
                        updates.push(self.update(json!({"sessionUpdate":"tool_call_update","toolCallId":id,"status":"failed",
                            "content":[{"type":"content","content":{"type":"text","text":"Input generation was superseded without an authoritative execution result. Do not replay tools blindly."}}]}))?);
                    }
                    self.tools.clear();
                    self.input_tools.clear();
                    self.approval_tools.clear();
                    self.generation = next_generation;
                    self.model_stop_reason = None;
                } else if event["type"] == "tool_input_progress" {
                    if let Some(id) = event["id"]
                        .as_str()
                        .filter(|id| !id.is_empty() && id.len() <= 1024)
                    {
                        let new = !self.tools.contains_key(id);
                        if new || self.input_tools.contains(id) {
                            let name = event["name"]
                                .as_str()
                                .filter(|name| !name.is_empty())
                                .unwrap_or("tool");
                            ensure!(
                                name.len() <= 512,
                                "Native tool name exceeds the progress budget"
                            );
                            if new {
                                self.register_tool(id)?;
                                self.input_tools.insert(id.into());
                            }
                            let chars = event["chars"].as_u64().unwrap_or(0);
                            let generated = event["lines"]["generatedLines"].as_u64();
                            let replaced = event["lines"]["replacedLines"].as_u64();
                            let lines = match (generated, replaced) {
                                (Some(add), Some(remove)) => format!("; +{add} -{remove} lines"),
                                (Some(add), None) => format!("; +{add} generated lines"),
                                _ => String::new(),
                            };
                            updates.push(self.update(json!({"sessionUpdate":if new {"tool_call"} else {"tool_call_update"},
                                "toolCallId":id,"title":format!("{name} · preparing input"),"kind":tool_kind(name),"status":"pending",
                                "content":[{"type":"content","content":{"type":"text","text":format!("Preparing parameters: {chars} characters{lines}. Tool execution has not been reported.")}}],
                                "_meta":{"kcoder/inputProgress":{"characters":chars,"generatedLines":generated,"replacedLines":replaced}}}))?);
                        }
                    }
                } else if event["type"] == "assistant_stop_reason" {
                    self.model_stop_reason = Some(match event["reason"].as_str() {
                        Some("end_turn") => "end_turn",
                        Some("tool_use") => "tool_use",
                        Some("max_tokens") => "max_tokens",
                        Some("refusal") => "refusal",
                        Some("pause_turn") => "pause_turn",
                        _ => "unknown",
                    });
                } else if event["type"] == "assistant_thinking_delta" {
                    if let Some(text) = event["text"].as_str() {
                        updates.push(self.text("agent_thought_chunk", text)?);
                    }
                } else if event["type"] == "tool_execution_started"
                    && let Some(id) = event["id"].as_str()
                    && self.tools.get(id) == Some(&false)
                {
                    updates.push(self.update(json!({"sessionUpdate":"tool_call_update", "toolCallId":id, "status":"in_progress"}))?);
                }
            }
            Some("item/completed") => {
                let item = &params["item"];
                if item["type"] == "toolCall"
                    && let Some(id) = item["id"].as_str()
                    && self.tools.get(id) == Some(&false)
                {
                    let status = match item["status"].as_str() {
                        Some("completed") => "completed",
                        Some("failed") => "failed",
                        _ => return Err(anyhow::anyhow!("Native tool terminal status is unknown")),
                    };
                    self.tools.insert(id.into(), true);
                    let text = item["output"].as_str().unwrap_or("");
                    let text = if item["outputTruncated"] == true {
                        format!("{text}\n[Tool output truncated by the runtime]")
                    } else {
                        text.into()
                    };
                    updates.push(self.update(json!({"sessionUpdate":"tool_call_update", "toolCallId":id,
                        "status":status, "content":[{"type":"content", "content":{"type":"text", "text":text}}]}))?);
                }
            }
            _ => {}
        }
        Ok(updates)
    }

    pub(crate) fn completion_reason(&self, fallback: StopReason) -> Result<StopReason> {
        match self.model_stop_reason {
            Some("max_tokens") => Ok(StopReason::MaxTokens),
            // ACP Refusal promises to exclude the refused prompt from future context.
            // Native rollback also changes files, so never call it implicitly or claim
            // that history promise. Close the session with an explicit error instead.
            Some("refusal") => anyhow::bail!(
                "Provider refused this response; the ACP session is closed. Create a new session; no files were automatically rolled back"
            ),
            Some("pause_turn") => anyhow::bail!(
                "Provider paused this response; ACP continuation is not available. The session is closed; do not blindly replay tools"
            ),
            Some("unknown") => anyhow::bail!(
                "Provider returned an unsupported stop reason; this is not a completed answer"
            ),
            _ => Ok(fallback),
        }
    }

    /// Register the exact tool referenced by an approval, including pump reordering.
    pub(crate) fn register_permission_call(
        &mut self,
        request: &kcoder_app_protocol::ApprovalRequestParams,
    ) -> Result<Vec<SessionNotification>> {
        ensure!(
            !self.finished
                && request.thread_id == self.thread_id
                && request.turn_id == self.turn_id,
            "Approval belongs to another or completed turn"
        );
        let id = request
            .tool_call_id
            .as_deref()
            .filter(|id| !id.is_empty() && id.len() <= 1024)
            .ok_or_else(|| anyhow::anyhow!("Approval lacks a negotiated tool identity"))?;
        ensure!(
            self.tools.get(id) != Some(&true),
            "Approval belongs to an already settled tool"
        );
        if self.tools.contains_key(id) {
            return Ok(Vec::new());
        }
        self.register_tool(id)?;
        self.approval_tools.insert(id.into());
        // Native approval and stream projection use separate pumps. Both carry
        // the same authoritative call ID even when the approval arrives first.
        let kind = match request.action {
            kcoder_app_protocol::ApprovalAction::Command { .. } => "execute",
            kcoder_app_protocol::ApprovalAction::FileChange { .. } => "edit",
            _ => "other",
        };
        Ok(vec![self.update(json!({"sessionUpdate":"tool_call","toolCallId":id,"title":"Permission required","kind":kind,"status":"pending"}))?])
    }

    fn register_tool(&mut self, id: &str) -> Result<()> {
        ensure!(
            !id.is_empty() && id.len() <= 1024,
            "Native tool identity exceeds the ACP budget"
        );
        ensure!(self.tool_count < 4096, "ACP tool count limit reached");
        self.tool_count += 1;
        self.tools.insert(id.into(), false);
        Ok(())
    }

    pub(crate) fn approval_tool_id(
        &self,
        request: &kcoder_app_protocol::ApprovalRequestParams,
    ) -> Result<String> {
        let id = request
            .tool_call_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("Approval lacks its tool identity"))?;
        ensure!(
            self.tools.get(id) == Some(&false),
            "Approval refers to an inactive tool"
        );
        Ok(generation_tool_id(&self.turn_id, id, self.generation))
    }

    /// Settle unresolved rows honestly before the caller sends a final prompt response.
    pub fn finish(&mut self) -> Result<Vec<SessionNotification>> {
        if self.finished {
            return Ok(Vec::new());
        }
        self.finished = true;
        let mut updates = Vec::new();
        for (id, terminal) in &self.tools {
            if !terminal {
                updates.push(self.update(json!({"sessionUpdate":"tool_call_update", "toolCallId":id, "status":"failed",
                    "content":[{"type":"content", "content":{"type":"text", "text":"Execution ended without an authoritative tool result. External effects may have occurred; reconcile before retrying."}}]}))?);
            }
        }
        Ok(updates)
    }

    fn text(&self, kind: &str, text: &str) -> Result<SessionNotification> {
        self.update(json!({"sessionUpdate":kind, "content":{"type":"text", "text":text}}))
    }

    fn update(&self, mut update: Value) -> Result<SessionNotification> {
        if let Some(id) = update["toolCallId"].as_str() {
            update["toolCallId"] =
                Value::String(generation_tool_id(&self.turn_id, id, self.generation));
        }
        // The pinned SDK validates the actual wire variant before serialization.
        Ok(serde_json::from_value(
            json!({"sessionId":self.session_id, "update":update}),
        )?)
    }
}

/// Native IDs may repeat across provider requests; ACP IDs include turn and generation.
pub(crate) fn tool_id(turn: &str, native: &str) -> String {
    generation_tool_id(turn, native, 0)
}

fn generation_tool_id(turn: &str, native: &str, generation: u64) -> String {
    format!(
        "{generation}:{}:{turn}:{}:{native}",
        turn.len(),
        native.len()
    )
}

fn tool_kind(name: &str) -> &'static str {
    match name {
        "read" => "read",
        "edit" | "write" | "apply_patch" => "edit",
        "glob" | "grep" | "WebSearch" => "search",
        "WebFetch" => "fetch",
        "bash" | "PowerShell" | "REPL" => "execute",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parameter_progress_uses_one_row_and_retries_never_reopen_a_retired_row() {
        let mut p = TurnProjection::new("session".into(), "thread".into(), "turn".into());
        p.project(&frame(
            "item/event",
            1,
            json!({"event":{"type":"tool_input_reset"}}),
        ))
        .unwrap();
        let progress = |sequence, chars, lines| {
            frame(
                "item/event",
                sequence,
                json!({"event":{"type":"tool_input_progress","id":"same","name":"write","chars":chars,"lines":{"generatedLines":lines}}}),
            )
        };
        let first = serde_json::to_value(p.project(&progress(2, 12, 1)).unwrap()).unwrap();
        assert_eq!(first[0]["update"]["sessionUpdate"], "tool_call");
        // The pinned schema omits the default pending status on initial ToolCall.
        assert_eq!(
            first[0]["update"]["status"].as_str().unwrap_or("pending"),
            "pending"
        );
        let id = first[0]["update"]["toolCallId"].clone();
        let next = serde_json::to_value(p.project(&progress(3, 24, 3)).unwrap()).unwrap();
        assert_eq!(next[0]["update"]["sessionUpdate"], "tool_call_update");
        assert_eq!(next[0]["update"]["toolCallId"], id);
        assert_eq!(
            next[0]["update"]["_meta"]["kcoder/inputProgress"]["generatedLines"],
            3
        );
        assert!(
            next[0]["update"]["content"]
                .to_string()
                .contains("+3 generated lines")
        );
        let started = serde_json::to_value(p.project(&frame("item/started", 4, json!({"item":{"id":"same","type":"toolCall","name":"write","input":{"file_path":"fixture","content":"ready"}}}))).unwrap()).unwrap();
        assert_eq!(started[0]["update"]["sessionUpdate"], "tool_call_update");
        assert_eq!(started[0]["update"]["toolCallId"], id);
        assert_eq!(started[0]["update"]["title"], "write");
        p.project(&frame(
            "item/completed",
            5,
            json!({"item":{"id":"same","type":"toolCall","status":"completed","output":"done"}}),
        ))
        .unwrap();
        assert!(
            p.project(&frame(
                "item/event",
                6,
                json!({"event":{"type":"tool_input_reset"}})
            ))
            .unwrap()
            .is_empty()
        );
        let retry = serde_json::to_value(p.project(&progress(7, 8, 1)).unwrap()).unwrap();
        assert_ne!(retry[0]["update"]["toolCallId"], id);
        let retired = serde_json::to_value(
            p.project(&frame(
                "item/event",
                8,
                json!({"event":{"type":"tool_input_reset"}}),
            ))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            retired[0]["update"]["toolCallId"],
            retry[0]["update"]["toolCallId"]
        );
        assert_eq!(retired[0]["update"]["status"], "failed");
        assert!(
            p.project(&progress(7, 100, 50)).unwrap().is_empty(),
            "late progress reopened a retired row"
        );
        assert!(
            p.project(&frame(
                "item/started",
                9,
                json!({"item":{"type":"toolCall","id":"x".repeat(1025),"name":"write","input":{}}})
            ))
            .is_err()
        );
        assert!(
            p.finish().unwrap().is_empty(),
            "rejected oversized identity retained a tool row"
        );
    }

    #[test]
    fn model_stop_reasons_obey_sequence_and_message_boundaries() {
        let mut p = TurnProjection::new("session".into(), "thread".into(), "turn".into());
        p.project(&frame(
            "item/event",
            2,
            json!({"event":{"type":"assistant_stop_reason","reason":"max_tokens"}}),
        ))
        .unwrap();
        assert_eq!(
            p.completion_reason(StopReason::EndTurn).unwrap(),
            StopReason::MaxTokens
        );
        p.project(&frame(
            "item/event",
            1,
            json!({"event":{"type":"assistant_stop_reason","reason":"end_turn"}}),
        ))
        .unwrap();
        assert_eq!(
            p.completion_reason(StopReason::EndTurn).unwrap(),
            StopReason::MaxTokens
        );
        p.project(&frame(
            "item/started",
            3,
            json!({"item":{"type":"agentMessage","id":"next"}}),
        ))
        .unwrap();
        assert_eq!(
            p.completion_reason(StopReason::EndTurn).unwrap(),
            StopReason::EndTurn
        );
        for (sequence, reason) in [
            (4, "refusal"),
            (5, "pause_turn"),
            (6, "untrusted-provider-text"),
        ] {
            p.project(&frame(
                "item/event",
                sequence,
                json!({"event":{"type":"assistant_stop_reason","reason":reason}}),
            ))
            .unwrap();
            let error = p
                .completion_reason(StopReason::EndTurn)
                .unwrap_err()
                .to_string();
            assert!(!error.contains("untrusted-provider-text"));
        }
    }

    #[test]
    fn approval_before_streamed_tool_start_uses_one_real_call_and_late_approval_is_rejected() {
        let mut p = TurnProjection::new("session".into(), "thread".into(), "turn".into());
        let request = kcoder_app_protocol::ApprovalRequestParams {
            app_server_epoch: None,
            tool_call_id: Some("actual-tool".into()),
            server_id: "native".into(),
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            approval_id: "approval".into(),
            action: kcoder_app_protocol::ApprovalAction::FileChange {
                path: "fixture.txt".into(),
            },
            reason: "Write file".into(),
        };
        let pending = serde_json::to_value(p.register_permission_call(&request).unwrap()).unwrap();
        assert_eq!(pending[0]["update"]["sessionUpdate"], "tool_call");
        let call_id = pending[0]["update"]["toolCallId"].clone();
        assert_ne!(call_id, "actual-tool");
        assert!(p.register_permission_call(&request).unwrap().is_empty());
        let start = serde_json::to_value(
            p.project(&frame(
                "item/started",
                1,
                json!({"item":{"id":"actual-tool","type":"toolCall","name":"write","input":{}}}),
            ))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(start[0]["update"]["sessionUpdate"], "tool_call_update");
        assert_eq!(start[0]["update"]["toolCallId"], call_id);
        p.project(&frame("item/completed",2,json!({"item":{"id":"actual-tool","type":"toolCall","name":"write","status":"failed","output":"Denied"}}))).unwrap();
        assert!(p.register_permission_call(&request).is_err());
        assert!(p.finish().unwrap().is_empty());
    }

    #[test]
    fn reused_native_tool_ids_in_different_turns_never_share_an_acp_row() {
        let mut first = TurnProjection::new("session".into(), "thread".into(), "turn".into());
        let mut second = TurnProjection::new("session".into(), "thread".into(), "next".into());
        let first_frame = frame(
            "item/started",
            1,
            json!({"item":{"id":"reused","type":"toolCall","name":"write","input":{}}}),
        );
        let mut second_frame = first_frame.clone();
        second_frame["params"]["turnId"] = json!("next");
        let one = serde_json::to_value(first.project(&first_frame).unwrap()).unwrap();
        let two = serde_json::to_value(second.project(&second_frame).unwrap()).unwrap();
        assert_ne!(
            one[0]["update"]["toolCallId"],
            two[0]["update"]["toolCallId"]
        );
        assert_ne!(tool_id("a:b", "c"), tool_id("a", "b:c"));
    }

    fn frame(method: &str, sequence: u64, extra: Value) -> Value {
        let mut params = json!({"threadId":"thread", "turnId":"turn", "sequence":sequence});
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        json!({"jsonrpc":"2.0", "method":method, "params":params})
    }

    #[test]
    fn text_and_tool_events_preserve_identity_status_and_terminal_boundaries() {
        let mut p = TurnProjection::new("session".into(), "thread".into(), "turn".into());
        p.project(&frame(
            "item/started",
            1,
            json!({"item":{"id":"message", "type":"agentMessage"}}),
        ))
        .unwrap();
        let text = frame(
            "item/delta",
            2,
            json!({"itemId":"message", "delta":{"text":"中文🙂"}}),
        );
        let value = serde_json::to_value(p.project(&text).unwrap()).unwrap();
        assert_eq!(value[0]["update"]["content"]["text"], "中文🙂");
        assert!(p.project(&text).unwrap().is_empty());
        let started = frame(
            "item/started",
            3,
            json!({"item":{"id":"tool", "type":"toolCall", "name":"PowerShell", "input":{"command":"Get-Date"}}}),
        );
        let value = serde_json::to_value(p.project(&started).unwrap()).unwrap();
        assert_eq!(
            value[0]["update"]["status"].as_str().unwrap_or("pending"),
            "pending"
        );
        assert_eq!(value[0]["update"]["kind"], "execute");
        let executing = frame(
            "item/event",
            4,
            json!({"event":{"type":"tool_execution_started", "id":"tool"}}),
        );
        assert_eq!(
            serde_json::to_value(p.project(&executing).unwrap()).unwrap()[0]["update"]["status"],
            "in_progress"
        );
        let done = frame(
            "item/completed",
            5,
            json!({"item":{"id":"tool", "type":"toolCall", "status":"completed", "output":"date", "outputTruncated":true}}),
        );
        let value = serde_json::to_value(p.project(&done).unwrap()).unwrap();
        assert_eq!(value[0]["update"]["status"], "completed");
        assert!(
            value[0]["update"]["content"][0]["content"]["text"]
                .as_str()
                .unwrap()
                .contains("truncated")
        );
        assert!(p.finish().unwrap().is_empty());
        assert!(p.project(&executing).unwrap().is_empty());
    }

    #[test]
    fn unrelated_events_and_unresolved_effects_never_become_success() {
        let mut p = TurnProjection::new("session".into(), "thread".into(), "turn".into());
        let mut wrong = frame(
            "item/started",
            1,
            json!({"item":{"id":"tool", "type":"toolCall", "name":"write"}}),
        );
        wrong["params"]["threadId"] = json!("other");
        assert!(p.project(&wrong).unwrap().is_empty());
        wrong["params"]["threadId"] = json!("thread");
        p.project(&wrong).unwrap();
        let result = serde_json::to_value(p.finish().unwrap()).unwrap();
        assert_eq!(result[0]["update"]["status"], "failed");
        assert!(
            result[0]["update"]["content"][0]["content"]["text"]
                .as_str()
                .unwrap()
                .contains("External effects may have occurred")
        );
        assert!(p.finish().unwrap().is_empty());
    }
}
