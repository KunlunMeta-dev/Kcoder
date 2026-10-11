use super::session_memory::strip_assistant_usage;
use super::{ContextBudget, TokenCounter};
use crate::stream::default_timed_stream;
use anyhow::Result;
use futures::StreamExt;
use kcoder_api::{ApiErrorKind, Provider};
use kcoder_types::{
    ContentBlock, ContentDelta, Message, MessagesRequest, ResponseJsonSchema, StreamEvent,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tracing::debug;

mod history;
mod protocol;
mod usage;

#[allow(unused_imports)]
pub(crate) use history::CompactionSplit;
pub(crate) use history::{
    COMPACT_BOUNDARY_MARKER, is_user_request_message, split_for_compaction,
    split_for_compaction_with_recent_budget_and_emergency,
};
pub use history::{
    CompactBoundary, latest_compact_boundary, messages_after_latest_compact_boundary,
};
use history::{
    build_compacted_messages, fingerprint_messages, format_compact_summary_message,
    truncate_head_for_ptl_retry,
};
use protocol::{
    build_compact_prompt, build_compact_repair_prompt, build_compact_system_prompt,
    build_structured_compact_prompt, compaction_api_error, is_prompt_too_long_error,
    is_structured_output_unsupported_error, is_transient_compaction_transport_error,
    record_compaction_stop_reason, require_compaction_message_start,
    validate_compact_response_with_metadata, validate_structured_compact_response,
};

const MAX_PTL_RETRIES: usize = 3;
/// Inline retries for transport-level summarize failures (dropped SSE
/// connections, decode errors, proxy resets). The summarize request is
/// idempotent, so a brief network blip should not consume the engine's
/// auto-compact circuit-breaker budget.
const MAX_TRANSPORT_RETRIES: usize = 2;
/// Repair format drift with a small deterministic number of in-place requests; never feed invalid responses back into context.
const MAX_PROTOCOL_REPAIR_RETRIES: usize = 2;

/// Compaction-failure metadata safe for NDJSON, excluding summary body text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompactionFailureDetails {
    pub phase: String,
    pub reason: String,
    pub opening_summary_tags: usize,
    pub closing_summary_tags: usize,
    pub response_chars: usize,
    pub response_fingerprint: String,
    pub stop_reason: Option<String>,
    pub attempt: usize,
    pub will_retry: bool,
    pub state_mutated: bool,
}

impl CompactionFailureDetails {
    /// Render a recovered protocol deviation as an informational notice rather than a compaction failure.
    pub fn recovered_notice_text(&self) -> String {
        format!(
            "Compaction recovered: protocol violation `{}` at attempt {} was rejected and the repair retry succeeded.",
            self.reason, self.attempt
        )
    }
}

#[derive(Debug)]
pub(crate) struct CompactionProtocolError {
    message: String,
    pub details: CompactionFailureDetails,
}

impl CompactionProtocolError {
    pub(crate) fn new(message: impl Into<String>, details: CompactionFailureDetails) -> Self {
        Self {
            message: message.into(),
            details,
        }
    }
}

impl std::fmt::Display for CompactionProtocolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} [reason={}, attempt={}]",
            self.message, self.details.reason, self.details.attempt
        )
    }
}

impl std::error::Error for CompactionProtocolError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompactOutputFormat {
    TaggedText,
    StructuredJson,
}

#[derive(Debug, Clone, Copy)]
struct CompactProtocolOptions<'a> {
    output_format: CompactOutputFormat,
    repair_reason: Option<&'a str>,
}

pub(crate) fn compaction_protocol_details(
    error: &anyhow::Error,
) -> Option<CompactionFailureDetails> {
    error.chain().find_map(|cause| {
        cause
            .downcast_ref::<CompactionProtocolError>()
            .map(|error| error.details.clone())
    })
}

fn compaction_response_schema() -> ResponseJsonSchema {
    ResponseJsonSchema::new(
        "kcoder_compaction_summary",
        serde_json::json!({
            "type": "object",
            "properties": {
                "summary": {
                    "type": "string",
                    "minLength": 1
                }
            },
            "required": ["summary"],
            "additionalProperties": false
        }),
    )
    .with_description("Conversation compaction summary; no tools or extra fields")
}

/// Request to compact a conversation.
#[derive(Debug, Clone)]
pub struct CompactionRequest {
    pub messages: Vec<Message>,
    pub model: String,
    pub summary_model: Option<String>,
    pub summary_max_tokens: u32,
    pub custom_instructions: Option<String>,
    pub debug_session_id: Option<String>,
    /// Optional background "prefire" summary produced while the conversation
    /// was still below the threshold. When it still matches the conversation
    /// prefix, only the newer delta gets summarized at threshold time.
    pub prefire: Option<PrefireNote>,
    /// A true hard-limit trigger may override normal recent-message retention preferences while still preserving the current request in full.
    pub emergency_split: bool,
}

/// A background "prefire" summary produced while the conversation was below
/// the compaction threshold (grok-style two-pass: warm pass-1 early, only the
/// tail delta is summarized when the threshold is actually crossed).
#[derive(Debug, Clone)]
pub struct PrefireNote {
    /// Number of leading messages (counted from the model-visible start) that
    /// the prefire summary covers.
    pub covered: usize,
    /// Full prefix identity; serialization failure disables reuse.
    covered_fingerprint: Option<[u8; 32]>,
    /// Unwrapped validated summary; never recover it by splitting human-readable markers.
    summary: String,
}

impl PrefireNote {
    pub fn new(prefix: &[Message], summary: String) -> Self {
        Self {
            covered: prefix.len(),
            covered_fingerprint: fingerprint_messages(prefix),
            summary,
        }
    }

    /// True when the complete covered prefix still has the same SHA-256 identity.
    pub fn matches(&self, messages: &[Message]) -> bool {
        self.covered > 0
            && self.covered < messages.len()
            && self.covered_fingerprint.is_some()
            && fingerprint_messages(&messages[..self.covered]) == self.covered_fingerprint
    }
}

/// Result of a compaction pass.
#[derive(Debug, Clone)]
pub struct CompactionResult {
    pub messages: Vec<Message>,
    pub summary: String,
    pub pre_compact_tokens: usize,
    pub post_compact_tokens: usize,
    /// True when this pass actually summarized older messages.
    pub did_compact: bool,
    /// True when the pass consumed a background prefire note and only
    /// summarized the newer delta.
    pub used_prefire: bool,
    /// Protocol errors safely rejected and recovered through repair retry during this compaction.
    pub protocol_diagnostics: Vec<CompactionFailureDetails>,
    /// Recovered transient summary-provider retries during this compaction.
    pub provider_retries: Vec<crate::ProviderRetryDetails>,
}

/// Compacts conversations by summarizing older API rounds while preserving the
/// most recent turns and re-injecting essential context.
pub struct ConversationCompactor {
    provider: Arc<dyn Provider>,
    request_class: crate::request_admission::RequestClass,
    budget: ContextBudget,
    usage_state: Option<kcoder_state::AppState>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CompactStreamBlockKind {
    Text,
    Thinking,
    Other,
}

impl ConversationCompactor {
    pub fn new(provider: Arc<dyn Provider>, budget: ContextBudget) -> Self {
        Self {
            provider,
            request_class: crate::request_admission::RequestClass::Foreground,
            budget,
            usage_state: None,
        }
    }

    pub fn with_usage_tracking(mut self, state: kcoder_state::AppState) -> Self {
        self.usage_state = Some(state);
        self
    }

    pub(crate) fn with_request_class(
        mut self,
        class: crate::request_admission::RequestClass,
    ) -> Self {
        self.request_class = class;
        self
    }

    /// Compact `request.messages` if they exceed the message budget.
    ///
    /// Returns the original messages unchanged if compaction is not needed.
    pub async fn compact_if_needed(
        &self,
        request: CompactionRequest,
    ) -> Result<Option<CompactionResult>> {
        let pre_compact_tokens = TokenCounter::count(&request.messages);
        debug!(
            "compact check: {} tokens, budget {} messages",
            pre_compact_tokens, self.budget.messages
        );

        if pre_compact_tokens <= self.budget.auto_compact_threshold() {
            return Ok(None);
        }

        self.compact(request, pre_compact_tokens).await.map(Some)
    }

    pub async fn compact(
        &self,
        request: CompactionRequest,
        pre_compact_tokens: usize,
    ) -> Result<CompactionResult> {
        let CompactionRequest {
            messages,
            model,
            summary_model,
            summary_max_tokens,
            custom_instructions,
            debug_session_id,
            prefire,
            emergency_split,
        } = request;

        if messages.is_empty() {
            anyhow::bail!("cannot compact an empty conversation");
        }

        let boundary = latest_compact_boundary(&messages);
        let compact_start = boundary.as_ref().map(|b| b.summary_index).unwrap_or(0);
        let prior_summary = boundary.as_ref().map(|b| b.summary.clone());
        let mut messages_to_summarize =
            messages.into_iter().skip(compact_start).collect::<Vec<_>>();
        let mut ptl_attempts = 0;
        let mut transport_attempts = 0;
        let mut protocol_repair_attempts: usize = 0;
        let mut protocol_diagnostics = Vec::new();
        let mut provider_retries = Vec::new();
        let mut protocol_repair_reason: Option<String> = None;
        let mut output_format = if self.provider.supports_response_json_schema() {
            CompactOutputFormat::StructuredJson
        } else {
            CompactOutputFormat::TaggedText
        };
        let effective_summary_model = summary_model.unwrap_or_else(|| model.clone());
        let compaction_started_at = Instant::now();

        let summary = loop {
            // Reserve maximum output space for the summary itself. Regular turns try to
            // preserve the two most recent turns; if they are large enough to keep the
            // compacted result above threshold, retain only the final turn verbatim.
            let threshold = self.budget.auto_compact_threshold();
            let summary_reserve = (summary_max_tokens as usize).min(threshold / 2);
            let recent_budget = threshold.saturating_sub(summary_reserve);
            let split = split_for_compaction_with_recent_budget_and_emergency(
                &messages_to_summarize,
                recent_budget,
                emergency_split,
            );
            if split.old.is_empty() {
                // Nothing old enough to summarize.
                let messages = if latest_compact_boundary(&split.recent).is_some() {
                    split.recent
                } else {
                    build_compacted_messages(prior_summary.as_deref(), None, split.recent)
                };
                let post_compact_tokens = TokenCounter::count(&messages);
                return Ok(CompactionResult {
                    messages,
                    summary: prior_summary.unwrap_or_default(),
                    pre_compact_tokens,
                    post_compact_tokens,
                    did_compact: false,
                    used_prefire: false,
                    protocol_diagnostics,
                    provider_retries,
                });
            }

            // Two-pass prefire: when a background pass-1 note still matches the
            // prefix, summarize only the uncovered delta (prepended with the
            // pass-1 summary) instead of the whole old segment.
            let matching_note = prefire.as_ref().filter(|note| {
                note.covered <= split.old.len() && note.matches(&messages_to_summarize)
            });
            // No delta requires no merge request. New hook instructions still require a
            // fresh pass, and cached text must pass the same current protocol validator.
            let complete_summary = matching_note
                .filter(|note| note.covered == split.old.len() && custom_instructions.is_none())
                .and_then(|note| {
                    validate_compact_response_with_metadata(
                        &format!("<summary>{}</summary>", note.summary),
                        &split.old,
                        Some("end_turn"),
                    )
                    .ok()
                });
            let (old_for_call, prefire_used) = match matching_note {
                _ if complete_summary.is_some() => (Vec::new(), true),
                Some(note) if note.covered < split.old.len() => {
                    debug!(
                        "auto-compact reusing background prefire summary ({} messages pre-summarized)",
                        note.covered
                    );
                    (
                        std::iter::once(Message::compaction_text(format_compact_summary_message(
                            &note.summary,
                        )))
                        .chain(split.old[note.covered..].iter().cloned())
                        .collect::<Vec<_>>(),
                        true,
                    )
                }
                _ => (split.old.clone(), false),
            };

            let request_started_at = Instant::now();
            let outcome = if let Some(summary) = complete_summary {
                Ok(summary)
            } else {
                self.summarize_old_messages_with_protocol(
                    &old_for_call,
                    &effective_summary_model,
                    summary_max_tokens,
                    custom_instructions.as_deref(),
                    debug_session_id.as_deref(),
                    CompactProtocolOptions {
                        output_format,
                        repair_reason: protocol_repair_reason.as_deref(),
                    },
                )
                .await
            };
            match outcome {
                Ok(summary) => {
                    let new_messages = build_compacted_messages(None, Some(&summary), split.recent);
                    // Usage values on retained assistant messages describe the
                    // *pre-compaction* prompt. Keeping them would make
                    // TokenCounter anchor on that stale, much larger prompt
                    // size — post == pre and every later auto-compact check
                    // would also be skewed. Strip them, like the
                    // session-memory compaction path does.
                    let new_messages = strip_assistant_usage(&new_messages);
                    let post_compact_tokens = TokenCounter::count(&new_messages);
                    if post_compact_tokens >= pre_compact_tokens {
                        anyhow::bail!(
                            "compaction did not reduce context: pre_tokens={}, post_tokens={}",
                            pre_compact_tokens,
                            post_compact_tokens
                        );
                    }
                    break CompactionResult {
                        messages: new_messages,
                        summary,
                        pre_compact_tokens,
                        post_compact_tokens,
                        did_compact: true,
                        used_prefire: prefire_used,
                        protocol_diagnostics,
                        provider_retries,
                    };
                }
                Err(e) => {
                    // If the summary request itself failed because the prompt
                    // was too long, drop the oldest round and retry.
                    if is_prompt_too_long_error(&e) {
                        if ptl_attempts >= MAX_PTL_RETRIES {
                            return Err(
                                e.context("compaction failed: prompt too long after retries")
                            );
                        }
                        ptl_attempts += 1;
                        messages_to_summarize =
                            truncate_head_for_ptl_retry(messages_to_summarize, split.old.len())?;
                        continue;
                    }
                    if is_transient_compaction_transport_error(&e)
                        && transport_attempts < MAX_TRANSPORT_RETRIES
                    {
                        transport_attempts += 1;
                        let retry_delay = compaction_api_error(&e)
                            .and_then(crate::retry_policy::api_server_retry_after)
                            .unwrap_or_else(|| {
                                crate::retry_policy::backoff_delay(100, transport_attempts as u32)
                            });
                        let reason = compact_retry_reason(&e);
                        provider_retries.push(crate::ProviderRetryDetails {
                            request_kind: "summary".to_string(),
                            provider: self.provider.name().to_string(),
                            model: effective_summary_model.clone(),
                            attempt: transport_attempts,
                            max_retries: MAX_TRANSPORT_RETRIES,
                            elapsed_ms: duration_millis_u64(request_started_at.elapsed()),
                            turn_elapsed_ms: duration_millis_u64(compaction_started_at.elapsed()),
                            transport_elapsed_ms: duration_millis_u64(
                                compaction_started_at.elapsed(),
                            ),
                            retry_after_ms: duration_millis_u64(retry_delay),
                            first_token_ms: None,
                            last_token_ms: None,
                            timeout_kind: compact_timeout_kind(&e).map(str::to_string),
                            reason: reason.clone(),
                        });
                        debug!(
                            "compaction hit a transient transport error (retry {}/{}): {}",
                            transport_attempts, MAX_TRANSPORT_RETRIES, e
                        );
                        tokio::time::sleep(retry_delay).await;
                        continue;
                    }
                    if output_format == CompactOutputFormat::StructuredJson
                        && is_structured_output_unsupported_error(&e)
                    {
                        debug!(
                            "compaction provider rejected structured output; falling back to tagged text: {}",
                            e
                        );
                        output_format = CompactOutputFormat::TaggedText;
                        protocol_repair_reason = None;
                        continue;
                    }
                    if let Some(mut details) = compaction_protocol_details(&e) {
                        details.attempt = protocol_repair_attempts.saturating_add(1);
                        if protocol_repair_attempts < MAX_PROTOCOL_REPAIR_RETRIES {
                            protocol_repair_attempts += 1;
                            details.will_retry = true;
                            debug!(
                                reason = %details.reason,
                                attempt = details.attempt,
                                opening_summary_tags = details.opening_summary_tags,
                                closing_summary_tags = details.closing_summary_tags,
                                response_chars = details.response_chars,
                                response_fingerprint = %details.response_fingerprint,
                                stop_reason = ?details.stop_reason,
                                "compaction protocol validation failed; retrying with repair prompt"
                            );
                            protocol_repair_reason = Some(details.reason.clone());
                            protocol_diagnostics.push(details);
                            continue;
                        }
                        details.will_retry = false;
                        return Err(CompactionProtocolError::new(
                            format!("compaction protocol repair budget exhausted: {e}"),
                            details,
                        )
                        .into());
                    }
                    return Err(e);
                }
            }
        };

        Ok(summary)
    }

    pub(crate) async fn summarize_old_messages(
        &self,
        old_messages: &[Message],
        model: &str,
        summary_max_tokens: u32,
        custom_instructions: Option<&str>,
        debug_session_id: Option<&str>,
    ) -> Result<String> {
        let output_format = if self.provider.supports_response_json_schema() {
            CompactOutputFormat::StructuredJson
        } else {
            CompactOutputFormat::TaggedText
        };
        let mut repair_reason = None;
        // This standalone prefire entry is not called by `compact`, whose retry loop
        // already invokes the single-attempt helper directly. Do not nest retries.
        for attempt in 0..=MAX_PROTOCOL_REPAIR_RETRIES {
            match self
                .summarize_old_messages_with_protocol(
                    old_messages,
                    model,
                    summary_max_tokens,
                    custom_instructions,
                    debug_session_id,
                    CompactProtocolOptions {
                        output_format,
                        repair_reason: repair_reason.as_deref(),
                    },
                )
                .await
            {
                Ok(summary) => return Ok(summary),
                Err(error) => {
                    let Some(mut details) = compaction_protocol_details(&error) else {
                        // Prefire does not add an independent transport retry budget.
                        return Err(error);
                    };
                    details.attempt = attempt + 1;
                    details.will_retry = attempt < MAX_PROTOCOL_REPAIR_RETRIES;
                    if !details.will_retry {
                        return Err(CompactionProtocolError::new(
                            format!("prefire protocol repair budget exhausted: {error}"),
                            details,
                        )
                        .into());
                    }
                    debug!(reason = %details.reason, attempt = details.attempt,
                        "prefire protocol validation failed; retrying with repair prompt");
                    repair_reason = Some(details.reason);
                }
            }
        }
        unreachable!("bounded prefire repair loop returns on its final attempt")
    }

    async fn summarize_old_messages_with_protocol(
        &self,
        old_messages: &[Message],
        model: &str,
        summary_max_tokens: u32,
        custom_instructions: Option<&str>,
        debug_session_id: Option<&str>,
        protocol: CompactProtocolOptions<'_>,
    ) -> Result<String> {
        let prompt = match (protocol.repair_reason, protocol.output_format) {
            (Some(reason), format) => {
                build_compact_repair_prompt(old_messages, custom_instructions, reason, format)
            }
            (None, CompactOutputFormat::TaggedText) => {
                build_compact_prompt(old_messages, custom_instructions)
            }
            (None, CompactOutputFormat::StructuredJson) => {
                build_structured_compact_prompt(old_messages, custom_instructions)
            }
        };
        let mut request = MessagesRequest::new(model, vec![Message::user_text(prompt)])
            .with_system(build_compact_system_prompt(protocol.output_format))
            .with_max_tokens(summary_max_tokens.max(1));
        if protocol.output_format == CompactOutputFormat::StructuredJson {
            request = request.with_response_json_schema(compaction_response_schema());
        }
        let request = if let Some(debug_session_id) = debug_session_id {
            request.with_debug_session_id(debug_session_id)
        } else {
            request
        };

        let permit = crate::request_admission::acquire(&self.provider, self.request_class).await?;
        let mut usage = usage::UsageAttempt::new(self.usage_state.as_ref(), model);
        let mut stream = permit.wrap(default_timed_stream(
            self.provider.stream_messages(request)?,
        ));
        let mut summary = String::new();
        let mut stop_reason = None;
        let mut illegal_stop_reason = None;
        let mut saw_message_stop = false;
        let mut saw_message_start = false;
        let mut started_block_indices = std::collections::HashSet::new();
        let mut open_blocks = std::collections::HashMap::new();

        while let Some(event) = stream.next().await {
            if let Ok(event) = &event {
                usage.observe(event);
            }
            match event {
                Ok(StreamEvent::MessageStart { message }) => {
                    if saw_message_start {
                        anyhow::bail!(
                            "invalid compaction response: duplicate or late MessageStart"
                        );
                    }
                    saw_message_start = true;
                    for block in message.content {
                        match block {
                            ContentBlock::Text { text } => summary.push_str(&text),
                            ContentBlock::Thinking { .. }
                            | ContentBlock::RedactedThinking { .. } => {}
                            ContentBlock::ToolUse { .. } | ContentBlock::ToolResult { .. } => {
                                anyhow::bail!(
                                    "invalid compaction response: structured tool content in MessageStart is not allowed"
                                );
                            }
                            ContentBlock::Image { .. } => {
                                anyhow::bail!(
                                    "invalid compaction response: image content violates TEXT ONLY"
                                );
                            }
                        }
                    }
                    if let Some(reason) = message.stop_reason {
                        record_compaction_stop_reason(
                            reason,
                            &mut stop_reason,
                            &mut illegal_stop_reason,
                        );
                    }
                }
                Ok(StreamEvent::ContentBlockDelta {
                    index,
                    delta: ContentDelta::TextDelta { text },
                }) => {
                    require_compaction_message_start(saw_message_start)?;
                    if open_blocks.get(&index) != Some(&CompactStreamBlockKind::Text) {
                        anyhow::bail!(
                            "invalid compaction summary stream: text delta for unopened or non-text block {}",
                            index
                        );
                    }
                    summary.push_str(&text);
                }
                Ok(StreamEvent::ContentBlockDelta {
                    index,
                    delta: ContentDelta::ThinkingDelta { .. } | ContentDelta::SignatureDelta { .. },
                }) => {
                    require_compaction_message_start(saw_message_start)?;
                    if open_blocks.get(&index) != Some(&CompactStreamBlockKind::Thinking) {
                        anyhow::bail!(
                            "invalid compaction response: thinking delta for unopened or non-thinking block {}",
                            index
                        );
                    }
                }
                Ok(StreamEvent::ContentBlockDelta {
                    delta: ContentDelta::InputJsonDelta { .. },
                    ..
                }) => {
                    require_compaction_message_start(saw_message_start)?;
                    anyhow::bail!(
                        "invalid compaction response: structured tool input delta is not allowed"
                    );
                }
                Ok(StreamEvent::ContentBlockStart {
                    index,
                    content_block,
                }) => {
                    require_compaction_message_start(saw_message_start)?;
                    if !started_block_indices.insert(index) {
                        anyhow::bail!(
                            "invalid compaction response: duplicate content block start {}",
                            index
                        );
                    }
                    let kind = match content_block {
                        ContentBlock::ToolUse { .. } => {
                            anyhow::bail!(
                                "invalid compaction response: structured tool use is not allowed"
                            );
                        }
                        ContentBlock::ToolResult { .. } => {
                            anyhow::bail!(
                                "invalid compaction response: structured tool result is not allowed"
                            );
                        }
                        ContentBlock::Text { text } => {
                            summary.push_str(&text);
                            CompactStreamBlockKind::Text
                        }
                        ContentBlock::Thinking { .. } => CompactStreamBlockKind::Thinking,
                        ContentBlock::RedactedThinking { .. } => CompactStreamBlockKind::Other,
                        ContentBlock::Image { .. } => {
                            anyhow::bail!(
                                "invalid compaction response: image content violates TEXT ONLY"
                            );
                        }
                    };
                    open_blocks.insert(index, kind);
                }
                Ok(StreamEvent::ContentBlockStop { index }) => {
                    require_compaction_message_start(saw_message_start)?;
                    if open_blocks.remove(&index).is_none() {
                        anyhow::bail!(
                            "invalid compaction response: stop for unopened content block {}",
                            index
                        );
                    }
                }
                Ok(StreamEvent::MessageDelta { delta }) => {
                    require_compaction_message_start(saw_message_start)?;
                    if let Some(reason) = delta.stop_reason {
                        record_compaction_stop_reason(
                            reason,
                            &mut stop_reason,
                            &mut illegal_stop_reason,
                        );
                    }
                }
                Ok(StreamEvent::MessageStop) => {
                    require_compaction_message_start(saw_message_start)?;
                    if !open_blocks.is_empty() {
                        anyhow::bail!(
                            "invalid compaction response: MessageStop with unclosed content blocks"
                        );
                    }
                    saw_message_stop = true;
                    break;
                }
                Ok(StreamEvent::Error { error }) => {
                    return Err(anyhow::Error::new(ApiErrorKind::Api {
                        error_type: error.error_type,
                        message: error.message,
                    })
                    .context("API error during compaction"));
                }
                Err(e) => {
                    return Err(anyhow::Error::new(e).context("stream error during compaction"));
                }
                _ => {}
            }
        }

        if !saw_message_stop {
            anyhow::bail!("invalid compaction response: stream ended without MessageStop");
        }
        if !saw_message_start {
            anyhow::bail!("invalid compaction response: missing MessageStart");
        }
        if illegal_stop_reason.is_some() {
            anyhow::bail!(
                "invalid compaction response: non-terminal stop_reason; response details withheld"
            );
        }
        if stop_reason.is_none() {
            anyhow::bail!("invalid compaction response: missing stop_reason");
        }

        let validation = match protocol.output_format {
            CompactOutputFormat::TaggedText => validate_compact_response_with_metadata(
                &summary,
                old_messages,
                stop_reason.as_deref(),
            ),
            CompactOutputFormat::StructuredJson => {
                validate_structured_compact_response(&summary, old_messages, stop_reason.as_deref())
            }
        };
        match validation {
            Ok(validated) => Ok(validated),
            Err(e) => {
                if let Some(details) = compaction_protocol_details(&e) {
                    debug!(
                        reason = %details.reason,
                        opening_summary_tags = details.opening_summary_tags,
                        closing_summary_tags = details.closing_summary_tags,
                        response_chars = details.response_chars,
                        response_fingerprint = %details.response_fingerprint,
                        stop_reason = ?details.stop_reason,
                        "compaction response failed validation; raw response omitted"
                    );
                } else {
                    debug!("compaction response failed validation: {e}; raw response omitted");
                }
                Err(e)
            }
        }
    }
}

fn duration_millis_u64(duration: std::time::Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

fn compact_retry_reason(error: &anyhow::Error) -> String {
    const MAX_CHARS: usize = 240;
    let normalized = format!("{error:#}")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.chars().count() <= MAX_CHARS {
        normalized
    } else {
        format!(
            "{}...",
            normalized.chars().take(MAX_CHARS).collect::<String>()
        )
    }
}

fn compact_timeout_kind(error: &anyhow::Error) -> Option<&'static str> {
    match compaction_api_error(error).and_then(ApiErrorKind::non_http_error_class) {
        Some(kcoder_api::NonHttpErrorClass::StreamIdleTimeout) => Some("token_idle"),
        Some(kcoder_api::NonHttpErrorClass::TransportTimeout) => Some("transport_timeout"),
        _ => None,
    }
}

#[cfg(test)]
#[path = "compact/tests.rs"]
mod tests;
