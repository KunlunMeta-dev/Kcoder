use super::*;

#[path = "codex_checkpoint.rs"]
mod checkpoint;
#[path = "codex_context.rs"]
mod context;
#[path = "codex_events.rs"]
mod events;

pub(super) fn parse(fields: &Fields, record: &mut HistoricalRecord) -> Result<()> {
    let root = Vec::new();
    let payload = path(&["payload"]);
    record.timestamp = fields.text(&root, "timestamp");
    record.persisted_ordinal = fields.number(&root, "ordinal");
    record.source_id = fields.text(&payload, "id");
    record.turn_id = fields
        .text(
            &child(&payload, "internal_chat_message_metadata_passthrough"),
            "turn_id",
        )
        .or_else(|| fields.text(&payload, "turn_id"));
    record.hidden = fields
        .boolean(&path(&["metadata"]), "compaction_output")
        .unwrap_or(false)
        || fields
            .boolean(&path(&["metadata"]), "inherited_user_message")
            .unwrap_or(false);
    let source_type = fields.text(&root, "type");
    record.codex = Some(checkpoint::metadata(
        fields,
        source_type.as_deref().unwrap_or("unknown_record"),
        &payload,
        &path(&["metadata"]),
        record,
    ));
    match source_type.as_deref() {
        Some("session_meta") => {
            let id = fields.text(&payload, "id").unwrap_or_default();
            if id.is_empty() {
                diagnostic(record, "missing_source_session_id", true);
            }
            let version = fields.text(&payload, "cli_version");
            record.source_version = version.clone();
            record.source_session_id = Some(id.clone());
            if fields.nodes.contains_key(&child(&payload, "history_mode"))
                && !matches!(
                    fields.text(&payload, "history_mode").as_deref(),
                    Some("legacy" | "paginated")
                )
            {
                diagnostic(record, "unsupported_codex_history_mode", true);
            }
            if fields.policy.pins_product_version()
                && version.as_deref() != Some(CODEX_ROLLOUT_BASELINE)
            {
                diagnostic(record, "unsupported_codex_source_version", true);
            }
            if fields
                .reference(&child(&payload, "history_base"), false)
                .is_some_and(|_| {
                    !matches!(
                        fields
                            .nodes
                            .get(&child(&payload, "history_base"))
                            .map(|node| &node.value),
                        Some(Value::Null)
                    )
                })
            {
                diagnostic(record, "source_history_base_required", true);
            }
            record.data = HistoricalRecordData::Session {
                session_id: id,
                version,
                project: fields.text(&payload, "cwd"),
                title: fields.reference(&child(&payload, "title"), true),
                parent_session_id: fields
                    .text(&payload, "parent_thread_id")
                    .or_else(|| fields.text(&payload, "forked_from_id")),
                history_mode: fields.text(&payload, "history_mode"),
                inherited_before_ordinal: fields.number(&payload, "subagent_history_start_ordinal"),
            };
        }
        Some("response_item") => {
            record.data = item(fields, &payload, record)?;
        }
        Some("compacted") => {
            record.data = checkpoint::parse(fields, &payload, record)?;
        }
        Some("event_msg") => {
            let kind = fields
                .text(&payload, "type")
                .unwrap_or_else(|| "unknown_event".into());
            if matches!(
                kind.as_str(),
                "task_started" | "turn_started" | "task_complete" | "turn_complete"
            ) && record.turn_id.as_deref().is_none_or(str::is_empty)
            {
                diagnostic(record, "invalid_codex_turn_identity", true);
            }
            if kind == "thread_rolled_back" {
                let turns = fields.number(&payload, "num_turns");
                if turns.is_none() {
                    diagnostic(record, "invalid_rollback_boundary", true);
                }
                record.data = HistoricalRecordData::Boundary {
                    source_type: "rollback".into(),
                    payload: required(fields, &payload)?,
                    rollback_turns: turns,
                    replacement_history: None,
                };
            } else {
                let outcome = if kind == "exec_command_end" {
                    fields.integer(&payload, "exit_code").map(|code| {
                        if code == 0 {
                            HistoricalToolOutcome::RecordedSuccess
                        } else {
                            HistoricalToolOutcome::RecordedError
                        }
                    })
                } else if kind == "patch_apply_end" && fields.policy.captures_execution_events() {
                    events::patch_outcome(fields, &payload, record)
                } else {
                    None
                };
                record.data = HistoricalRecordData::Event {
                    source_type: kind,
                    payload: required(fields, &payload)?,
                    call_id: fields.text(&payload, "call_id"),
                    outcome,
                };
            }
        }
        Some(
            "turn_context"
            | "token_usage_record"
            | "world_state"
            | "security_risk_score"
            | "inter_agent_communication"
            | "inter_agent_communication_metadata"
            | "retained_context"
            | "realtime_item",
        ) => {
            let kind = source_type.clone().unwrap();
            if matches!(kind.as_str(), "retained_context" | "realtime_item") {
                diagnostic(record, "unresolved_source_context_boundary", true);
            }
            record.data = HistoricalRecordData::Metadata {
                source_type: kind,
                payload: required(fields, &payload)?,
            };
        }
        _ => {
            diagnostic(record, "unknown_source_record", true);
            record.data = HistoricalRecordData::Unknown {
                source_type,
                payload: fields.reference(&[], false),
            };
        }
    }
    Ok(())
}

fn required(fields: &Fields, path: &[Segment]) -> Result<HistoricalValueRef> {
    fields
        .reference(path, false)
        .ok_or_else(|| anyhow::anyhow!("migration_history_missing_payload"))
}

fn item(
    fields: &Fields,
    base: &[Segment],
    record: &mut HistoricalRecord,
) -> Result<HistoricalRecordData> {
    let kind = fields.text(base, "type").unwrap_or_default();
    let mut blocks = Vec::new();
    let role = match kind.as_str() {
        "message" => {
            let role = role(fields.text(base, "role").as_deref());
            let content = child(base, "content");
            if role == HistoricalRole::Unknown
                || !matches!(
                    fields.nodes.get(&content).map(|node| &node.value),
                    Some(Value::Array)
                )
            {
                diagnostic(record, "invalid_source_message_content", true);
            }
            for index in fields.indices(&content) {
                let mut at = content.clone();
                at.push(Segment::Index(index));
                match fields.text(&at, "type").as_deref() {
                    Some("input_text" | "output_text" | "text") => {
                        if let Some(value) = fields.reference(&child(&at, "text"), true) {
                            blocks.push(HistoricalBlock::Text { value });
                        } else {
                            diagnostic(record, "missing_source_text", true);
                        }
                    }
                    Some("input_image" | "output_image" | "image" | "input_file" | "file") => {
                        blocks.push(HistoricalBlock::Attachment {
                            source_type: fields.text(&at, "type").unwrap(),
                            value: required(fields, &at)?,
                            media_type: fields.text(&at, "media_type"),
                        })
                    }
                    _ => {
                        blocks.push(HistoricalBlock::Opaque {
                            source_type: fields
                                .text(&at, "type")
                                .unwrap_or_else(|| "unknown_content".into()),
                            value: required(fields, &at)?,
                        });
                        diagnostic(record, "unknown_source_content", true);
                    }
                }
            }
            role
        }
        "function_call" | "custom_tool_call" => {
            let call_id = fields.text(base, "call_id").unwrap_or_default();
            let name = fields.text(base, "name").unwrap_or_default();
            let namespace = fields.text(base, "namespace");
            if namespace.is_none()
                && fields
                    .nodes
                    .get(&child(base, "namespace"))
                    .is_some_and(|node| !matches!(node.value, Value::Null))
            {
                diagnostic(record, "unsupported_historical_tool_namespace", true);
            }
            let input = fields.reference(
                &child(
                    base,
                    if kind == "function_call" {
                        "arguments"
                    } else {
                        "input"
                    },
                ),
                true,
            );
            if call_id.is_empty() || name.is_empty() || input.is_none() {
                diagnostic(record, "incomplete_historical_tool_call", true);
            }
            if let Some(input) = input {
                blocks.push(HistoricalBlock::ToolCall {
                    call_id,
                    name,
                    namespace,
                    source_type: Some(kind.clone()),
                    input,
                });
            }
            HistoricalRole::Assistant
        }
        "function_call_output" | "custom_tool_call_output" => {
            let call_id = fields.text(base, "call_id").unwrap_or_default();
            if call_id.is_empty() {
                diagnostic(record, "missing_tool_result_identity", true);
            }
            if let Some(output) = fields.reference(&child(base, "output"), true) {
                blocks.push(HistoricalBlock::ToolResult {
                    call_id,
                    output,
                    outcome: HistoricalToolOutcome::RecordedResult,
                });
            } else {
                diagnostic(record, "missing_tool_result_payload", true);
            }
            HistoricalRole::Tool
        }
        "reasoning" => {
            for group in ["summary", "content"] {
                let content = child(base, group);
                for index in fields.indices(&content) {
                    let mut at = content.clone();
                    at.push(Segment::Index(index));
                    if let Some(value) = fields.reference(&child(&at, "text"), true) {
                        blocks.push(HistoricalBlock::Thinking { value });
                    }
                }
            }
            if let Some(value) = fields.reference(&child(base, "encrypted_content"), false) {
                blocks.push(HistoricalBlock::Opaque {
                    source_type: "encrypted_reasoning".into(),
                    value,
                });
            }
            HistoricalRole::Assistant
        }
        _ => {
            diagnostic(record, "unsupported_response_item", true);
            blocks.push(HistoricalBlock::Opaque {
                source_type: kind,
                value: required(fields, base)?,
            });
            HistoricalRole::Unknown
        }
    };
    if let Some(value) = fields.reference(&child(base,"encrypted_content"),false)
        && !blocks.iter().any(|block| matches!(block, HistoricalBlock::Opaque {source_type,..} if source_type == "encrypted_reasoning")) {
        blocks.push(HistoricalBlock::Opaque { source_type: "encrypted_content".into(),value });
    }
    Ok(HistoricalRecordData::Message {
        role,
        phase: fields.text(base, "phase"),
        blocks,
    })
}
