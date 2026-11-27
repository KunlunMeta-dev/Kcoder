use super::*;

pub(super) fn parse(fields: &Fields, record: &mut HistoricalRecord) -> Result<()> {
    let root = Vec::new();
    record.source_id = fields.text(&root, "uuid");
    record.parent_id = fields.text(&root, "parentUuid");
    record.logical_parent_id = fields.text(&root, "logicalParentUuid");
    record.source_session_id = fields.text(&root, "sessionId");
    record.timestamp = fields.text(&root, "timestamp");
    record.source_version = fields.text(&root, "version");
    record.sidechain = fields.boolean(&root, "isSidechain").unwrap_or(false);
    record.hidden = fields.boolean(&root, "isMeta").unwrap_or(false)
        || fields.text(&root, "teamName").is_some();
    record.compact_summary = fields.boolean(&root, "isCompactSummary").unwrap_or(false);
    if fields.policy.pins_product_version()
        && record
            .source_version
            .as_deref()
            .is_some_and(|version| version != CLAUDE_TRANSCRIPT_BASELINE)
    {
        diagnostic(record, "unsupported_claude_source_version", true);
    }
    let source_type = fields.text(&root, "type");
    match source_type.as_deref() {
        Some("user" | "assistant") => {
            if record.source_id.as_deref().is_none_or(str::is_empty)
                || record
                    .source_session_id
                    .as_deref()
                    .is_none_or(str::is_empty)
            {
                diagnostic(record, "missing_source_message_identity", true);
            }
            let message = path(&["message"]);
            let content = child(&message, "content");
            let mut blocks = Vec::new();
            if matches!(
                fields.nodes.get(&content).map(|node| &node.value),
                Some(Value::String(_))
            ) {
                blocks.push(HistoricalBlock::Text {
                    value: fields.reference(&content, true).unwrap(),
                });
            } else {
                for index in fields.indices(&content) {
                    let mut at = content.clone();
                    at.push(Segment::Index(index));
                    let kind = fields.text(&at, "type").unwrap_or_default();
                    match kind.as_str() {
                        "text" | "thinking" => {
                            if let Some(value) = fields.reference(
                                &child(
                                    &at,
                                    if kind == "thinking" {
                                        "thinking"
                                    } else {
                                        "text"
                                    },
                                ),
                                true,
                            ) {
                                blocks.push(if kind == "thinking" {
                                    HistoricalBlock::Thinking { value }
                                } else {
                                    HistoricalBlock::Text { value }
                                });
                            } else {
                                diagnostic(record, "missing_source_text", true);
                            }
                            if let Some(value) = fields.reference(&child(&at, "signature"), false) {
                                blocks.push(HistoricalBlock::Opaque {
                                    source_type: "thinking_signature".into(),
                                    value,
                                });
                            }
                        }
                        "tool_use" => {
                            let call_id = fields.text(&at, "id").unwrap_or_default();
                            let name = fields.text(&at, "name").unwrap_or_default();
                            let input = fields.reference(&child(&at, "input"), true);
                            if call_id.is_empty() || name.is_empty() || input.is_none() {
                                diagnostic(record, "incomplete_historical_tool_call", true);
                            }
                            if let Some(input) = input {
                                blocks.push(HistoricalBlock::ToolCall {
                                    call_id,
                                    name,
                                    namespace: None,
                                    source_type: Some(kind.clone()),
                                    input,
                                });
                            }
                        }
                        "tool_result" => {
                            let call_id = fields.text(&at, "tool_use_id").unwrap_or_default();
                            let outcome = match fields.boolean(&at, "is_error") {
                                Some(true) => HistoricalToolOutcome::RecordedError,
                                Some(false) => HistoricalToolOutcome::RecordedSuccess,
                                None => HistoricalToolOutcome::RecordedResult,
                            };
                            if call_id.is_empty() {
                                diagnostic(record, "missing_tool_result_identity", true);
                            }
                            if let Some(output) = fields.reference(&child(&at, "content"), true) {
                                blocks.push(HistoricalBlock::ToolResult {
                                    call_id,
                                    output,
                                    outcome,
                                });
                            } else {
                                diagnostic(record, "missing_tool_result_payload", true);
                            }
                        }
                        "image" | "document" | "file" => blocks.push(HistoricalBlock::Attachment {
                            source_type: kind,
                            value: fields.reference(&at, false).unwrap(),
                            media_type: fields.text(&child(&at, "source"), "media_type"),
                        }),
                        _ => {
                            diagnostic(record, "unknown_source_content", true);
                            blocks.push(HistoricalBlock::Opaque {
                                source_type: if kind.is_empty() {
                                    "unknown_content".into()
                                } else {
                                    kind
                                },
                                value: fields.reference(&at, false).unwrap(),
                            });
                        }
                    }
                }
            }
            let role = if blocks
                .iter()
                .all(|block| matches!(block, HistoricalBlock::ToolResult { .. }))
                && !blocks.is_empty()
            {
                HistoricalRole::Tool
            } else {
                role(source_type.as_deref())
            };
            if !matches!(
                fields.nodes.get(&content).map(|node| &node.value),
                Some(Value::String(_) | Value::Array)
            ) {
                diagnostic(record, "invalid_source_message_content", true);
            }
            record.data = HistoricalRecordData::Message {
                role,
                phase: None,
                blocks,
            };
        }
        Some("system") if fields.text(&root, "subtype").as_deref() == Some("compact_boundary") => {
            record.data = HistoricalRecordData::Boundary {
                source_type: "compaction".into(),
                payload: fields.reference(&[], false).unwrap(),
                rollback_turns: None,
                replacement_history: None,
            };
        }
        Some(
            "system"
            | "progress"
            | "attachment"
            | "custom-title"
            | "summary"
            | "tag"
            | "file-history-snapshot"
            | "queue-operation"
            | "last-prompt"
            | "agent-setting",
        ) => {
            record.data = HistoricalRecordData::Metadata {
                source_type: source_type.unwrap(),
                payload: fields.reference(&[], false).unwrap(),
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
