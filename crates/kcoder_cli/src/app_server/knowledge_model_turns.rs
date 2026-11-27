//! Multi-turn Wiki file-contract requests. The worker offers only its own
//! virtual-tree `read`/`edit`/`write` tools; no Engine tool, permission or Hook
//! is involved. Complete assistant content, including thinking signatures and
//! redacted thinking, is kept verbatim so the next turn replays it exactly.
use super::ProviderWikiModel;
use anyhow::{Result, ensure};
use futures::StreamExt;
use kcoder_knowledge::{WikiOutputTruncated, WikiToolsRejected, WikiTurnRequest, WikiTurnResponse};
use kcoder_types::{ContentBlock, ContentDelta, MessagesRequest, StreamEvent};
use std::collections::BTreeMap;

pub(super) const MAX_TOOL_INPUT_BYTES: usize = 1024 * 1024;
pub(super) const MAX_TURN_TOOL_INPUT_BYTES: usize = 4 * 1024 * 1024;

enum Partial {
    Text(String),
    Thinking {
        thinking: String,
        signature: String,
    },
    Redacted(String),
    Tool {
        id: String,
        name: String,
        initial: serde_json::Value,
        json: String,
        deltas: bool,
    },
}

/// Assembles normalized provider events into complete content blocks. A tool
/// input comes either complete in its start block (Gemini) or as JSON deltas
/// (Anthropic, OpenAI chat/Responses, genai); deltas win when present.
#[derive(Default)]
pub(super) struct TurnAccumulator {
    blocks: BTreeMap<usize, Partial>,
    tool_bytes: usize,
    pub(super) text_bytes: usize,
    pub(super) reasoning_bytes: usize,
}

impl TurnAccumulator {
    pub(super) fn has_content(&self) -> bool {
        !self.blocks.is_empty()
    }

    pub(super) fn observe(&mut self, event: &StreamEvent) -> Result<()> {
        match event {
            StreamEvent::ContentBlockStart {
                index,
                content_block,
            } => {
                let partial = match content_block {
                    ContentBlock::Text { text } => {
                        self.text_bytes += text.len();
                        Partial::Text(text.clone())
                    }
                    ContentBlock::Thinking {
                        thinking,
                        signature,
                    } => {
                        self.reasoning_bytes += thinking.len();
                        Partial::Thinking {
                            thinking: thinking.clone(),
                            signature: signature.clone(),
                        }
                    }
                    ContentBlock::RedactedThinking { data } => Partial::Redacted(data.clone()),
                    ContentBlock::ToolUse { id, name, input } => {
                        self.add_tool_bytes(input.to_string().len())?;
                        Partial::Tool {
                            id: id.clone(),
                            name: name.clone(),
                            initial: input.clone(),
                            json: String::new(),
                            deltas: false,
                        }
                    }
                    // Providers never stream user-side blocks.
                    _ => return Ok(()),
                };
                self.blocks.insert(*index, partial);
            }
            StreamEvent::ContentBlockDelta { index, delta } => match delta {
                ContentDelta::TextDelta { text } => {
                    self.text_bytes += text.len();
                    match self
                        .blocks
                        .entry(*index)
                        .or_insert_with(|| Partial::Text(String::new()))
                    {
                        Partial::Text(current) => current.push_str(text),
                        _ => anyhow::bail!("Wiki model stream mixed block types"),
                    }
                }
                ContentDelta::ThinkingDelta { thinking } => {
                    self.reasoning_bytes += thinking.len();
                    match self
                        .blocks
                        .entry(*index)
                        .or_insert_with(|| Partial::Thinking {
                            thinking: String::new(),
                            signature: String::new(),
                        }) {
                        Partial::Thinking {
                            thinking: current, ..
                        } => current.push_str(thinking),
                        _ => anyhow::bail!("Wiki model stream mixed block types"),
                    }
                }
                ContentDelta::SignatureDelta { signature } => {
                    match self
                        .blocks
                        .entry(*index)
                        .or_insert_with(|| Partial::Thinking {
                            thinking: String::new(),
                            signature: String::new(),
                        }) {
                        Partial::Thinking {
                            signature: current, ..
                        } => current.push_str(signature),
                        _ => anyhow::bail!("Wiki model stream mixed block types"),
                    }
                }
                ContentDelta::InputJsonDelta { partial_json } => {
                    self.add_tool_bytes(partial_json.len())?;
                    match self.blocks.get_mut(index) {
                        Some(Partial::Tool { json, deltas, .. }) => {
                            json.push_str(partial_json);
                            *deltas = true;
                            ensure!(
                                json.len() <= MAX_TOOL_INPUT_BYTES,
                                "Wiki tool arguments exceed 1 MiB"
                            );
                        }
                        _ => anyhow::bail!("Wiki model stream sent tool arguments without a tool"),
                    }
                }
            },
            _ => {}
        }
        Ok(())
    }

    fn add_tool_bytes(&mut self, bytes: usize) -> Result<()> {
        self.tool_bytes = self.tool_bytes.saturating_add(bytes);
        ensure!(
            self.tool_bytes <= MAX_TURN_TOOL_INPUT_BYTES,
            "Wiki tool arguments exceed 4 MiB in one turn"
        );
        Ok(())
    }

    /// Invalid argument JSON is reported, never repaired or executed. The
    /// replayed block carries an empty object so the transcript stays valid.
    pub(super) fn finish(self, stop_reason: Option<String>) -> WikiTurnResponse {
        let mut response = WikiTurnResponse {
            content: Vec::new(),
            invalid_tool_inputs: Vec::new(),
            stop_reason,
        };
        for (_, partial) in self.blocks {
            response.content.push(match partial {
                Partial::Text(text) => {
                    if text.is_empty() {
                        continue;
                    }
                    ContentBlock::Text { text }
                }
                Partial::Thinking {
                    thinking,
                    signature,
                } => ContentBlock::Thinking {
                    thinking,
                    signature,
                },
                Partial::Redacted(data) => ContentBlock::RedactedThinking { data },
                Partial::Tool {
                    id,
                    name,
                    initial,
                    json,
                    deltas,
                } => {
                    let parsed = if deltas {
                        if json.trim().is_empty() {
                            Some(serde_json::json!({}))
                        } else {
                            serde_json::from_str::<serde_json::Value>(&json).ok()
                        }
                    } else {
                        Some(initial)
                    };
                    let input = match parsed.filter(serde_json::Value::is_object) {
                        Some(input) => input,
                        None => {
                            response.invalid_tool_inputs.push(id.clone());
                            serde_json::json!({})
                        }
                    };
                    ContentBlock::ToolUse { id, name, input }
                }
            });
        }
        response
    }
}

fn rejected_before_content(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<kcoder_api::ApiErrorKind>()
            .is_some_and(|kind| match kind {
                kcoder_api::ApiErrorKind::Http { metadata, .. } => {
                    matches!(metadata.status, 400 | 404 | 422)
                }
                kcoder_api::ApiErrorKind::Api { error_type, .. }
                | kcoder_api::ApiErrorKind::SseStream { error_type, .. } => {
                    error_type.contains("invalid_request")
                }
                _ => false,
            })
    })
}

impl ProviderWikiModel {
    pub(super) fn turn_messages_request(
        &self,
        input: &WikiTurnRequest,
        max_tokens: u32,
    ) -> MessagesRequest {
        MessagesRequest::new(&self.model, input.messages.clone())
            .with_system(input.system.clone())
            .with_tools(input.tools.clone())
            .with_max_tokens(max_tokens)
            .with_reasoning_effort(self.reasoning.clone())
            // genai maps this local identity to a stable prompt-cache key.
            .with_debug_session_id(input.cache_key.clone())
    }

    /// The shared request estimator, including tool definitions.
    pub(super) fn estimate_turn(&self, input: &WikiTurnRequest) -> usize {
        let request = self.turn_messages_request(input, input.max_output_tokens);
        kcoder_api::token_counter::TokenCounter::count_request(&request, true).tokens
    }

    pub(crate) async fn complete_turn_observed(
        &self,
        input: WikiTurnRequest,
        limit: u32,
        progress: Option<&(dyn Fn(usize, usize) -> Result<()> + Send + Sync)>,
        admission: Option<&dyn super::super::knowledge_model_admission::WikiRequestAdmission>,
    ) -> Result<(WikiTurnResponse, Option<kcoder_knowledge::WikiTokenUsage>)> {
        let bounded = self.with_output_limit(
            &kcoder_knowledge::WikiModelRequest {
                stage: input.stage,
                system: String::new(),
                user: String::new(),
                max_output_tokens: input.max_output_tokens,
            },
            limit,
        )?;
        let mut usage: Option<kcoder_knowledge::WikiTokenUsage> = None;
        let mut final_usage_reported = false;
        let mut observed = None;
        let mut content_seen = false;
        let first_turn = input.first_turn;
        let result: Result<WikiTurnResponse> = async {
            let requested_tokens = bounded.stage_output_limit(input.max_output_tokens)?;
            let request = bounded.turn_messages_request(&input, requested_tokens);
            observed = super::super::knowledge_model_admission::ObservedWikiRequest::reserve(
                admission, &bounded, &request,
            )?;
            if let Some(observed) = observed.as_mut() {
                observed.dispatch()?;
            }
            let mut stream = bounded.provider.stream_messages(request)?;
            let mut accumulator = TurnAccumulator::default();
            let mut stop_reason = None;
            let mut stopped = false;
            let mut last_progress = std::time::Instant::now();
            let mut check = tokio::time::interval(std::time::Duration::from_millis(250));
            loop {
                let event = if let Some(observed) = observed.as_mut() {
                    tokio::select! {
                        biased;
                        _ = check.tick() => {
                            observed.check_current()?;
                            continue;
                        }
                        event = stream.next() => event,
                    }
                } else {
                    stream.next().await
                };
                let Some(event) = event else { break };
                let event = event?;
                if let Some(observed) = observed.as_mut() {
                    observed.observe(&event)?;
                    observed.check_current()?;
                }
                let reported = match &event {
                    StreamEvent::MessageStart { message } => message.usage.as_ref(),
                    StreamEvent::MessageDelta { delta } => delta.usage.as_ref(),
                    _ => None,
                };
                if matches!(&event, StreamEvent::MessageDelta { delta } if delta.usage.is_some()) {
                    final_usage_reported = true;
                }
                if let Some(reported) = reported {
                    let current = usage.get_or_insert(kcoder_knowledge::WikiTokenUsage {
                        input_tokens: 0,
                        output_tokens: 0,
                    });
                    current.input_tokens =
                        current.input_tokens.max(u64::from(reported.input_tokens));
                    current.output_tokens =
                        current.output_tokens.max(u64::from(reported.output_tokens));
                }
                accumulator.observe(&event)?;
                content_seen |= accumulator.has_content();
                match event {
                    StreamEvent::MessageDelta { delta } => {
                        if matches!(
                            delta.stop_reason.as_deref(),
                            Some("max_tokens" | "length" | "max_output_tokens")
                        ) {
                            // A truncated turn may hold an incomplete tool call:
                            // none of its calls are executed.
                            if let Some(progress) = progress {
                                progress(accumulator.text_bytes, accumulator.reasoning_bytes)?;
                            }
                            return Err(WikiOutputTruncated {
                                stage: input.stage,
                                text_bytes: accumulator.text_bytes,
                                reasoning_bytes: accumulator.reasoning_bytes,
                                requested_tokens,
                                reported_output_tokens: usage
                                    .as_ref()
                                    .map(|value| value.output_tokens),
                                stop_reason: delta.stop_reason.unwrap(),
                            }
                            .into());
                        }
                        if delta.stop_reason.is_some() {
                            stop_reason = delta.stop_reason;
                        }
                    }
                    StreamEvent::MessageStop => {
                        stopped = true;
                        break;
                    }
                    StreamEvent::Error { error } => {
                        return Err(kcoder_api::ApiErrorKind::Api {
                            error_type: error.error_type,
                            message: String::new(),
                        }
                        .into());
                    }
                    _ => {}
                }
                if last_progress.elapsed() >= std::time::Duration::from_secs(1) {
                    if let Some(progress) = progress {
                        progress(accumulator.text_bytes, accumulator.reasoning_bytes)?;
                    }
                    last_progress = std::time::Instant::now();
                }
                ensure!(
                    accumulator.text_bytes <= kcoder_knowledge::WIKI_MAX_OUTPUT_BYTES,
                    "Wiki model output is too large"
                );
            }
            if let Some(progress) = progress {
                progress(accumulator.text_bytes, accumulator.reasoning_bytes)?;
            }
            ensure!(stopped, "Wiki model stream ended before completion");
            Ok(accumulator.finish(stop_reason))
        }
        .await;
        let accounting = observed.map(|observed| observed.finish()).transpose();
        if !final_usage_reported {
            usage = None;
        }
        let result = match (result, accounting) {
            (Ok(response), Ok(_)) => Ok(response),
            (Err(error), _) | (_, Err(error)) => Err(error),
        };
        match result {
            Ok(response) => Ok((response, usage)),
            Err(error) => {
                // A first tool-bearing request refused before any content is a
                // model capability problem. Never retry it without tools.
                let error = if first_turn && !content_seen && rejected_before_content(&error) {
                    error.context(WikiToolsRejected)
                } else {
                    error
                };
                Err(error.context(super::WikiReportedUsage(usage)))
            }
        }
    }
}

#[cfg(test)]
#[path = "knowledge_model_turns_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "knowledge_model_turns_provider_tests.rs"]
mod provider_tests;
