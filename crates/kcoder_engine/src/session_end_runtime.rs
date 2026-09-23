use super::{
    EngineEvent, QueryEngine, current_time_millis, default_timed_stream, last_assistant_text,
    last_user_text, message_has_text, recover_read_lock,
};
use crate::context::{ContextManager, messages_after_latest_compact_boundary};
use anyhow::Result;
use futures::StreamExt;
use kcoder_api::Provider;
use kcoder_memory::MemorySummaryInput;
use kcoder_types::{ContentDelta, Message, MessagesRequest, StreamEvent};
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::time::timeout;
use tracing::{debug, warn};

const SESSION_END_SUMMARY_TIMEOUT: Duration = Duration::from_secs(30);
const SESSION_END_DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(2);

impl QueryEngine {
    /// Run teardown hooks. This is best-effort and intended for plugin cleanup
    /// or telemetry; blocking errors are surfaced as hook messages.
    pub async fn run_session_end_hooks(&self, exit_reason: &str) -> Vec<EngineEvent> {
        self.record_session_end_summary(exit_reason).await;
        self.finish_memory_session(exit_reason);
        self.persist_tool_repair_examples_on_session_end().await;
        let (events, _effects, _blocking_error) = self
            .run_simple_hooks(
                kcoder_hooks::HookEvent::SessionEnd,
                exit_reason,
                serde_json::json!({
                    "exit_reason": exit_reason,
                    "cwd": self.state.cwd(),
                    "session_id": self.state.session_id(),
                }),
            )
            .await;
        self.flush_workspace_diagnostics_until(
            std::time::Instant::now() + SESSION_END_DIAGNOSTIC_TIMEOUT,
        )
        .await;
        events
    }

    /// Flush one snapshot of workspace attempts and payloads without closing intake.
    /// Resident-thread teardown should flush its AppState scope instead.
    pub async fn flush_workspace_diagnostics_until(&self, deadline: std::time::Instant) -> bool {
        let barrier = self.state.diagnostic_writer().barrier();
        let writer_flushed = matches!(
            tokio::time::timeout_at(
                deadline.into(),
                tokio::task::spawn_blocking(move || barrier.wait_until(deadline)),
            )
            .await,
            Ok(Ok(true))
        );
        if !writer_flushed {
            warn!("diagnostic shutdown flush did not complete before its deadline");
        }
        writer_flushed
    }

    async fn record_session_end_summary(&self, exit_reason: &str) {
        if recover_read_lock(&self.settings, "settings").training_mode {
            return;
        }
        if self
            .memory_session_end_summary_recorded
            .swap(true, Ordering::SeqCst)
        {
            return;
        }

        let messages = messages_after_latest_compact_boundary(&self.state.messages());
        if !messages.iter().any(message_has_text) {
            return;
        }

        let (_, summary_model, summary_max_tokens, summary_provider) = match self.summary_runtime()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                self.record_deterministic_session_end_summary(
                    exit_reason,
                    &messages,
                    Some(error.to_string()),
                );
                return;
            }
        };

        let summary_result = timeout(
            SESSION_END_SUMMARY_TIMEOUT,
            self.generate_session_end_summary(
                exit_reason,
                &messages,
                &summary_model,
                summary_max_tokens,
                summary_provider,
            ),
        )
        .await;
        let (learned, generated_by_model, fallback_reason) = match summary_result {
            Ok(Ok(summary)) if !summary.trim().is_empty() => {
                (summary, Some(summary_model.clone()), None)
            }
            Ok(Ok(_)) => (
                deterministic_session_end_summary(exit_reason, &messages),
                None,
                Some("model returned an empty session summary".to_string()),
            ),
            Ok(Err(error)) => (
                deterministic_session_end_summary(exit_reason, &messages),
                None,
                Some(error.to_string()),
            ),
            Err(_) => (
                deterministic_session_end_summary(exit_reason, &messages),
                None,
                Some("session-end summary model call timed out".to_string()),
            ),
        };

        if learned.trim().is_empty() {
            return;
        }

        let message_count = messages.len();
        let input = MemorySummaryInput {
            session_id: self.state.session_id(),
            project_key: String::new(),
            prompt_number: self.current_memory_prompt_number(),
            request: Some("session end".to_string()),
            investigated: Some(format!(
                "Summarized {message_count} model-visible message(s) at session end."
            )),
            learned: Some(learned),
            completed: Some(format!(
                "Session ended with reason `{}`.",
                compact_session_summary_text(exit_reason, 120)
            )),
            next_steps: None,
            notes: Some("Generated during SessionEnd lifecycle.".to_string()),
            created_at_epoch: current_time_millis(),
        };

        match self.memory_manager.save_structured_summary(input) {
            Ok(Some(id)) => {
                debug!(summary_id = id, "recorded session-end structured summary");
                let mut metadata = serde_json::Map::new();
                metadata.insert(
                    "exit_reason".to_string(),
                    Value::String(compact_session_summary_text(exit_reason, 200)),
                );
                metadata.insert(
                    "message_count".to_string(),
                    serde_json::json!(message_count),
                );
                if let Some(model) = generated_by_model {
                    metadata.insert("summary_model".to_string(), Value::String(model));
                }
                if let Some(reason) = fallback_reason {
                    metadata.insert(
                        "fallback_reason".to_string(),
                        Value::String(compact_session_summary_text(&reason, 240)),
                    );
                }
                self.record_memory_source(
                    "summary",
                    id,
                    "session_end",
                    Some(self.state.session_id()),
                    Value::Object(metadata),
                );
            }
            Ok(None) => {}
            Err(error) => warn!("failed to record session-end structured summary: {error}"),
        }
    }

    fn record_deterministic_session_end_summary(
        &self,
        exit_reason: &str,
        messages: &[Message],
        fallback_reason: Option<String>,
    ) {
        let learned = deterministic_session_end_summary(exit_reason, messages);
        if learned.trim().is_empty() {
            return;
        }

        let message_count = messages.len();
        let input = MemorySummaryInput {
            session_id: self.state.session_id(),
            project_key: String::new(),
            prompt_number: self.current_memory_prompt_number(),
            request: Some("session end".to_string()),
            investigated: Some(format!(
                "Summarized {message_count} model-visible message(s) at session end."
            )),
            learned: Some(learned),
            completed: Some(format!(
                "Session ended with reason `{}`.",
                compact_session_summary_text(exit_reason, 120)
            )),
            next_steps: None,
            notes: Some("Generated during SessionEnd lifecycle.".to_string()),
            created_at_epoch: current_time_millis(),
        };

        match self.memory_manager.save_structured_summary(input) {
            Ok(Some(id)) => {
                debug!(
                    summary_id = id,
                    "recorded deterministic session-end structured summary"
                );
                let mut metadata = serde_json::Map::new();
                metadata.insert(
                    "exit_reason".to_string(),
                    Value::String(compact_session_summary_text(exit_reason, 200)),
                );
                metadata.insert(
                    "message_count".to_string(),
                    serde_json::json!(message_count),
                );
                if let Some(reason) = fallback_reason {
                    metadata.insert(
                        "fallback_reason".to_string(),
                        Value::String(compact_session_summary_text(&reason, 240)),
                    );
                }
                self.record_memory_source(
                    "summary",
                    id,
                    "session_end",
                    Some(self.state.session_id()),
                    Value::Object(metadata),
                );
            }
            Ok(None) => {}
            Err(error) => warn!("failed to record deterministic session-end summary: {error}"),
        }
    }

    async fn generate_session_end_summary(
        &self,
        exit_reason: &str,
        messages: &[Message],
        summary_model: &str,
        summary_max_tokens: u32,
        provider: Arc<dyn Provider>,
    ) -> Result<String> {
        let transcript = ContextManager::format_for_summary(messages);
        if transcript.trim().is_empty() {
            anyhow::bail!("session transcript was empty");
        }
        let prompt = build_session_end_summary_prompt(exit_reason, &transcript);
        let request = MessagesRequest::new(summary_model, vec![Message::user_text(prompt)])
            .with_max_tokens(summary_max_tokens.max(1))
            .with_debug_session_id(self.state.session_id());
        let mut stream = default_timed_stream(provider.stream_messages(request)?);
        let mut summary = String::new();

        while let Some(event) = stream.next().await {
            match event {
                Ok(StreamEvent::ContentBlockDelta {
                    delta: ContentDelta::TextDelta { text },
                    ..
                }) => summary.push_str(&text),
                Ok(StreamEvent::MessageStop) => break,
                Ok(StreamEvent::Error { error }) => {
                    return Err(anyhow::Error::new(kcoder_api::ApiErrorKind::Api {
                        error_type: error.error_type,
                        message: error.message,
                    })
                    .context("API error during session-end summary"));
                }
                Err(error) => {
                    return Err(anyhow::Error::new(error)
                        .context("stream error during session-end summary"));
                }
                _ => {}
            }
        }

        Ok(normalize_session_end_summary(&summary))
    }

    fn finish_memory_session(&self, exit_reason: &str) {
        let status = match exit_reason.trim() {
            "success" => "ended",
            "ctrl-c" | "cancelled" | "cancelled by user" => "cancelled",
            _ => "failed",
        };
        match self.memory_manager.finish_structured_session(
            &self.state.session_id(),
            current_time_millis(),
            status,
        ) {
            Ok(true) => {}
            Ok(false) => {}
            Err(error) => warn!("failed to mark structured memory session ended: {error}"),
        }
    }

    async fn persist_tool_repair_examples_on_session_end(&self) {
        if !self
            .workspace_persistence_mode
            .allows_implicit_project_writes()
        {
            return;
        }
        let cwd = self.cwd.clone();
        let session_id = self.state.session_id();
        let recorder = Arc::clone(&self.tool_repair_recorder);
        let result = tokio::task::spawn_blocking(move || {
            let recorder = recover_read_lock(&recorder, "tool_repair_recorder");
            recorder.persist_session_examples(&cwd, &session_id)
        })
        .await;

        match result {
            Ok(Ok(count)) if count > 0 => {
                debug!("persisted {} tool repair example(s)", count);
            }
            Ok(Ok(_)) => {}
            Ok(Err(error)) => warn!("failed to persist tool repair examples: {}", error),
            Err(error) => warn!("tool repair example persistence task failed: {}", error),
        }
    }
}

fn deterministic_session_end_summary(exit_reason: &str, messages: &[Message]) -> String {
    let mut parts = vec![format!(
        "Session ended with reason `{}` after {} model-visible message(s).",
        compact_session_summary_text(exit_reason, 120),
        messages.len()
    )];
    if let Some(user) = last_user_text(messages) {
        parts.push(format!(
            "Last user request: {}",
            compact_session_summary_text(&user, 300)
        ));
    }
    if let Some(assistant) = last_assistant_text(messages) {
        let assistant = assistant.trim();
        if !assistant.is_empty() {
            parts.push(format!(
                "Last assistant response: {}",
                compact_session_summary_text(assistant, 300)
            ));
        }
    }
    parts.join(" ")
}

fn build_session_end_summary_prompt(exit_reason: &str, transcript: &str) -> String {
    format!(
        "Summarize this just-finished KCoder session for long-term memory. Return concise plain text only. Focus on durable outcomes, decisions, important findings, completed work, and concrete next steps. Do not include raw secrets or private data. Exit reason: {}.\n\nTranscript:\n{}",
        compact_session_summary_text(exit_reason, 160),
        transcript
    )
}

fn normalize_session_end_summary(summary: &str) -> String {
    let trimmed = summary.trim();
    let without_open = trimmed.strip_prefix("<summary>").unwrap_or(trimmed);
    let without_close = without_open
        .strip_suffix("</summary>")
        .unwrap_or(without_open);
    without_close.trim().to_string()
}

fn compact_session_summary_text(text: &str, max_chars: usize) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= max_chars {
        return compact;
    }
    let truncated = compact
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect::<String>();
    format!("{truncated}...")
}

#[cfg(test)]
#[path = "session_end_runtime/tests.rs"]
mod tests;
