use kcoder_engine::EngineEvent;
use kcoder_types::ContentBlock;
use serde_json::Value;

pub fn visible_system_notice(text: &str) -> &str {
    if text == "kcoder.notice.imported_context_legacy_unobserved" {
        "This older conversation has no saved imported-context snapshot. Current profile notes were not applied; start a new conversation to use them."
    } else {
        text
    }
}

pub fn engine_event_json(event: EngineEvent) -> Value {
    match event {
        EngineEvent::BackgroundScoped { identity, event } => {
            let mut value = engine_event_json(*event);
            value["backgroundIdentity"] = serde_json::to_value(identity).unwrap_or(Value::Null);
            value
        }
        EngineEvent::UserMessageAdded => serde_json::json!({"type": "user_message_added"}),
        EngineEvent::SubagentUserMessageAdded {
            agent_id,
            message_id,
            client_message_id,
            message_index,
            text,
        } => {
            serde_json::json!({"type":"subagent_user_message_added", "agent_id":agent_id, "message_id":message_id, "client_message_id":client_message_id, "message_index":message_index, "text":text})
        }
        EngineEvent::TurnSteerApplied { id } => {
            serde_json::json!({"type": "turn_steer_applied", "id": id})
        }
        EngineEvent::SubagentSteerApplied {
            agent_id,
            message_id,
            queue_depth,
        } => {
            serde_json::json!({
                "type": "subagent_steer_applied",
                "agent_id": agent_id,
                "message_id": message_id,
                "queue_depth": queue_depth,
            })
        }
        EngineEvent::AssistantTextDelta(text) => {
            serde_json::json!({"type": "assistant_text_delta", "text": text})
        }
        EngineEvent::AssistantMessageStarted => {
            serde_json::json!({"type": "assistant_message_started"})
        }
        EngineEvent::AssistantMessageDone => serde_json::json!({"type": "assistant_message_done"}),
        EngineEvent::AssistantStopReason { reason } => {
            serde_json::json!({"type":"assistant_stop_reason", "reason":reason})
        }
        EngineEvent::AssistantThinkingDelta(text) => {
            serde_json::json!({"type": "assistant_thinking_delta", "text": text})
        }
        EngineEvent::ToolUseStarted { id, name, input } => {
            serde_json::json!({"type": "tool_use_started", "id": id, "name": name, "input": input})
        }
        EngineEvent::ToolExecutionStarted { id, name } => {
            serde_json::json!({"type": "tool_execution_started", "id": id, "name": name})
        }
        EngineEvent::ToolInputReset => serde_json::json!({"type": "tool_input_reset"}),
        EngineEvent::ToolInputProgress {
            id,
            name,
            chars,
            lines,
        } => {
            let mut event = serde_json::json!({"type": "tool_input_progress", "id": id, "name": name, "chars": chars});
            if let Some(lines) = lines {
                event["lines"] = serde_json::to_value(lines).unwrap_or_default();
            }
            event
        }
        EngineEvent::ToolInputPreview { id, preview } => {
            serde_json::json!({"type": "tool_input_preview", "id": id, "preview": preview})
        }
        EngineEvent::WidgetInputPreview { id, preview } => {
            serde_json::json!({"type":"widget_input_preview", "id":id, "preview":preview})
        }
        EngineEvent::ToolPathPreview {
            attempt_id,
            id,
            path,
        } => {
            serde_json::json!({"type": "tool_path_preview", "attempt_id": attempt_id, "id": id, "path": path})
        }
        EngineEvent::ToolDenied { id, name, reason } => {
            serde_json::json!({"type": "tool_denied", "id": id, "name": name, "reason": reason})
        }
        EngineEvent::ToolResult { id, name, output } => {
            let web_sources =
                output
                    .execution_metadata
                    .iter()
                    .find_map(|metadata| match metadata {
                        kcoder_tools::ToolExecutionMetadata::WebSources(receipt)
                            if receipt.tool_call_id == id =>
                        {
                            Some(receipt.clone())
                        }
                        _ => None,
                    });
            let text = output
                .content
                .into_iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text),
                    _ => None,
                })
                .collect::<String>();
            let mut event = serde_json::json!({"type": "tool_result", "id": id, "name": name, "text": text, "is_error": output.is_error});
            if let Some(receipt) = web_sources {
                event["webSources"] = serde_json::json!(receipt);
            }
            event
        }
        EngineEvent::SystemNotice(text) => {
            if text == "kcoder.notice.imported_context_legacy_unobserved" {
                serde_json::json!({"type":"system_notice","code":text,"text":visible_system_notice(&text)})
            } else {
                serde_json::json!({"type": "system_notice", "text": text})
            }
        }
        EngineEvent::ProviderRetry(details) => {
            let text = details.notice_text();
            let mut event = serde_json::to_value(details).unwrap_or_else(|_| serde_json::json!({}));
            if let Some(event) = event.as_object_mut() {
                event.insert(
                    "type".to_string(),
                    Value::String("system_notice".to_string()),
                );
                event.insert(
                    "kind".to_string(),
                    Value::String("provider_retry".to_string()),
                );
                event.insert("text".to_string(), Value::String(text));
            }
            crate::build_identity::add_to_json(&mut event);
            event
        }
        EngineEvent::MoaReference {
            label,
            text,
            index,
            count,
        } => {
            serde_json::json!({"type": "moa_reference", "label": label, "text": text, "index": index, "count": count})
        }
        EngineEvent::MoaAggregating { aggregator } => {
            serde_json::json!({"type": "moa_aggregating", "aggregator": aggregator})
        }
        EngineEvent::ProviderFailed { message, details } => serde_json::json!({
            "type": "error",
            "error": message,
            "retryable": details.retryable,
            "resume_safe": details.resume_safe,
            "retry_after_ms": details.retry_after_ms,
            "provider_failure": details,
        }),
        EngineEvent::Error(error) => {
            let retryable = crate::failure_policy::is_retryable_failure(&error);
            let retry_after_ms = crate::failure_policy::recommended_retry_after_ms(&error);
            serde_json::json!({
                "type": "error",
                "error": error,
                "retryable": retryable,
                "resume_safe": retryable,
                "retry_after_ms": retry_after_ms,
            })
        }
        EngineEvent::MaxTurnsReached { max_turns, .. } => {
            serde_json::json!({"type": "max_turns_reached", "max_turns": max_turns})
        }
        EngineEvent::StreamAborted { reason } => {
            serde_json::json!({"type": "stream_aborted", "reason": reason})
        }
        EngineEvent::CompactionFailed { error, details } => {
            let mut event = serde_json::json!({"type": "compaction_failed", "error": error});
            if let (Some(details), Some(event)) = (details, event.as_object_mut())
                && let Ok(serde_json::Value::Object(fields)) = serde_json::to_value(details)
            {
                event.extend(fields);
            }
            crate::build_identity::add_to_json(&mut event);
            event
        }
        EngineEvent::CompactionRecovered { details } => {
            let mut event = serde_json::json!({"type": "compaction_recovered"});
            if let (Ok(serde_json::Value::Object(fields)), Some(event)) =
                (serde_json::to_value(details), event.as_object_mut())
            {
                event.extend(fields);
            }
            crate::build_identity::add_to_json(&mut event);
            event
        }
        EngineEvent::HookMessage { text, is_error } => {
            serde_json::json!({"type": "hook_message", "text": text, "is_error": is_error})
        }
        EngineEvent::BackgroundJobStarted { id, description } => {
            serde_json::json!({"type": "background_job_started", "id": id, "description": description})
        }
        EngineEvent::BackgroundJobAssociated {
            id,
            tool_call_id,
            run_in_background,
        } => {
            serde_json::json!({"type": "background_job_associated", "id": id, "tool_call_id": tool_call_id, "run_in_background": run_in_background})
        }
        EngineEvent::BackgroundJobPromoted { id } => {
            serde_json::json!({"type": "background_job_promoted", "id": id})
        }
        EngineEvent::BackgroundJobProgress {
            id,
            message,
            detail,
            current,
            total,
        } => {
            serde_json::json!({"type": "background_job_progress", "id": id, "message": message, "detail": detail, "current": current, "total": total})
        }
        EngineEvent::BackgroundJobCompleted { id, output } => {
            let text = output
                .content
                .into_iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text),
                    _ => None,
                })
                .collect::<String>();
            serde_json::json!({"type": "background_job_completed", "id": id, "text": text, "is_error": output.is_error})
        }
        EngineEvent::BackgroundJobFailed { id, error } => {
            serde_json::json!({"type": "background_job_failed", "id": id, "error": error})
        }
        EngineEvent::BackgroundJobPaused { id, reason } => {
            serde_json::json!({"type": "background_job_paused", "id": id, "reason": reason})
        }
        EngineEvent::BackgroundJobHalted { id, reason } => {
            serde_json::json!({"type": "background_job_halted", "id": id, "reason": reason})
        }
        EngineEvent::BackgroundJobCancelled { id, reason } => {
            serde_json::json!({"type": "background_job_cancelled", "id": id, "reason": reason})
        }
    }
}
