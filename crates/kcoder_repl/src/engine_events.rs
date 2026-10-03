//! EngineEvent to AppEvent translation with generation fencing.

use super::*;

#[cfg(test)]
pub(super) fn engine_event_to_app_event(event: EngineEvent) -> Option<AppEvent> {
    engine_event_to_app_event_for_generation(event, 0)
}

pub(super) fn engine_event_to_app_event_for_generation(
    event: EngineEvent,
    generation: u64,
) -> Option<AppEvent> {
    Some(match event {
        EngineEvent::BackgroundScoped { event, .. } => {
            return engine_event_to_app_event_for_generation(*event, generation);
        }
        EngineEvent::AssistantMessageStarted => AppEvent::AssistantMessageStarted,
        EngineEvent::TurnSteerApplied { id } => AppEvent::TurnSteerApplied { id },
        EngineEvent::AssistantTextDelta(text) => AppEvent::AssistantDelta(text),
        EngineEvent::AssistantThinkingDelta(text) => AppEvent::AssistantThinkingDelta(text),
        EngineEvent::ToolInputReset => return None,
        EngineEvent::ToolInputProgress { name, chars, .. } => {
            AppEvent::ToolInputProgress { name, chars }
        }
        EngineEvent::ToolInputPreview { id, preview } => AppEvent::ToolInputPreview { id, preview },
        EngineEvent::ToolPathPreview {
            attempt_id,
            id,
            path,
        } => AppEvent::ToolPathPreview {
            generation,
            attempt_id,
            id,
            path,
        },
        EngineEvent::AssistantMessageDone => AppEvent::AssistantMessageDone,
        EngineEvent::ToolUseStarted { id, name, input } => AppEvent::ToolUseStarted {
            id,
            name,
            input: input.to_string(),
        },
        EngineEvent::ToolResult { id, name, output } => {
            let text = output
                .content
                .into_iter()
                .filter_map(|b| match b {
                    kcoder_types::ContentBlock::Text { text } => Some(text),
                    _ => None,
                })
                .collect::<String>();
            AppEvent::ToolResult {
                id,
                name,
                text,
                is_error: output.is_error,
            }
        }
        EngineEvent::ToolDenied { id, name, reason } => AppEvent::ToolResult {
            id,
            name,
            text: reason,
            is_error: true,
        },
        EngineEvent::SystemNotice(text) => AppEvent::SystemNotice(text),
        EngineEvent::ProviderRetry(details) => AppEvent::SystemNotice(details.notice_text()),
        EngineEvent::MoaReference {
            label,
            text,
            index,
            count,
        } => AppEvent::MoaReference {
            label,
            text,
            index,
            count,
        },
        EngineEvent::MoaAggregating { aggregator } => AppEvent::MoaAggregating { aggregator },
        EngineEvent::Error(err) | EngineEvent::ProviderFailed { message: err, .. } => {
            AppEvent::Error(err)
        }
        EngineEvent::UserMessageAdded => AppEvent::HistoryChanged,
        EngineEvent::SubagentSteerApplied { .. } => return None,
        EngineEvent::MaxTurnsReached { max_turns, .. } => AppEvent::SystemNotice(format!(
            "Reached the maximum number of turns ({} turns).",
            max_turns
        )),
        EngineEvent::StreamAborted { reason } => {
            AppEvent::SystemNotice(format!("Stream aborted: {}", reason))
        }
        EngineEvent::CompactionFailed { error, .. } => {
            AppEvent::SystemNotice(format!("Compaction failed: {}", error))
        }
        EngineEvent::CompactionRecovered { details } => {
            AppEvent::SystemNotice(details.recovered_notice_text())
        }
        EngineEvent::HookMessage { text, is_error } => AppEvent::SystemNotice(if is_error {
            format!("[hook error] {}", text)
        } else {
            text
        }),
        EngineEvent::BackgroundJobStarted { .. }
        | EngineEvent::BackgroundJobAssociated { .. }
        | EngineEvent::BackgroundJobPromoted { .. }
        | EngineEvent::BackgroundJobProgress { .. }
        | EngineEvent::BackgroundJobCompleted { .. }
        | EngineEvent::BackgroundJobFailed { .. }
        | EngineEvent::BackgroundJobPaused { .. }
        | EngineEvent::BackgroundJobHalted { .. }
        | EngineEvent::BackgroundJobCancelled { .. } => return None,
    })
}
