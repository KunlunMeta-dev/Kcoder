//! The Wiki worker uses the target's existing Provider and credential resolver.
use anyhow::{Result, ensure};
use async_trait::async_trait;
use futures::StreamExt;
use kcoder_api::Provider;
use kcoder_knowledge::{WikiModel, WikiModelRequest, WikiOutputTruncated};
use kcoder_types::{ContentBlock, ContentDelta, Message, MessagesRequest, StreamEvent};
use std::sync::Arc;

#[derive(Clone)]
pub(super) struct ProviderWikiModel {
    pub provider: Arc<dyn Provider>,
    pub model: String,
    pub max_output_tokens: Option<u32>,
    pub reasoning: Option<kcoder_types::ReasoningEffort>,
}

#[derive(Debug)]
pub(super) struct WikiReportedUsage(pub Option<kcoder_knowledge::WikiTokenUsage>);
impl std::fmt::Display for WikiReportedUsage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Wiki model request failed")
    }
}

#[async_trait]
impl WikiModel for ProviderWikiModel {
    fn output_token_budget(&self, suggested: u32) -> Result<u32> {
        self.stage_output_limit(suggested)
    }

    async fn complete(&self, input: WikiModelRequest) -> Result<String> {
        Ok(self.complete_measured(input).await?.0)
    }
    async fn complete_with_output_limit(
        &self,
        input: WikiModelRequest,
        limit: u32,
    ) -> Result<String> {
        Ok(self.complete_measured_with_limit(input, limit).await?.0)
    }
}
impl ProviderWikiModel {
    pub(super) async fn complete_measured_with_limit(
        &self,
        input: WikiModelRequest,
        limit: u32,
    ) -> Result<(String, Option<kcoder_knowledge::WikiTokenUsage>)> {
        let mut bounded = self.clone();
        bounded.max_output_tokens = Some(
            self.max_output_tokens
                .unwrap_or(kcoder_knowledge::WIKI_MAX_OUTPUT_TOKENS)
                .min(limit),
        );
        bounded.complete_measured(input).await
    }
    // Thinking shares the output allowance with JSON on Anthropic-compatible APIs.
    // Reserve room in both the request and the caller's context preflight; never
    // change the user's configured effort just to make a small stage fit.
    pub(super) fn reasoning_headroom(&self) -> u32 {
        use kcoder_types::ReasoningEffort;
        match self.reasoning.as_ref() {
            None | Some(ReasoningEffort::None) => 0,
            Some(ReasoningEffort::Minimal | ReasoningEffort::Low) => 1024,
            Some(ReasoningEffort::Medium) => 2048,
            Some(ReasoningEffort::High) => 3072,
            Some(ReasoningEffort::XHigh) => 4096,
            Some(ReasoningEffort::Custom(value)) => {
                value.trim().parse::<u32>().unwrap_or(3072).max(1024)
            }
        }
    }
    fn stage_output_limit(&self, text_budget: u32) -> Result<u32> {
        let reasoning = self.reasoning_headroom();
        // Wiki's own ceiling includes thinking and JSON. Respect a lower model
        // limit without changing the user's provider configuration.
        let allowed = self
            .max_output_tokens
            .unwrap_or(kcoder_knowledge::WIKI_MAX_OUTPUT_TOKENS)
            .min(kcoder_knowledge::WIKI_MAX_OUTPUT_TOKENS);
        ensure!(
            allowed.saturating_sub(reasoning) >= text_budget.min(1024),
            "Wiki output budget cannot fit reasoning and structured text"
        );
        Ok(allowed)
    }
    pub(super) async fn complete_measured(
        &self,
        input: WikiModelRequest,
    ) -> Result<(String, Option<kcoder_knowledge::WikiTokenUsage>)> {
        self.complete_with_image(input, None).await
    }
    pub(super) async fn complete_with_image(
        &self,
        input: WikiModelRequest,
        image: Option<kcoder_types::ImageSource>,
    ) -> Result<(String, Option<kcoder_knowledge::WikiTokenUsage>)> {
        let mut usage: Option<kcoder_knowledge::WikiTokenUsage> = None;
        let result: Result<String> = async {
            let mut content = vec![ContentBlock::Text { text: input.user }];
            if let Some(source) = image {
                content.push(ContentBlock::Image { source });
            }
            let requested_tokens = self.stage_output_limit(input.max_output_tokens)?;
            let request = MessagesRequest::new(&self.model, vec![Message::user_content(content)])
                .with_system(input.system)
                .with_max_tokens(requested_tokens)
                .with_reasoning_effort(self.reasoning.clone());
            let mut stream = self.provider.stream_messages(request)?;
            let mut text = String::new();
            let mut stopped = false;
            let mut reasoning_bytes = 0usize;

            while let Some(event) = stream.next().await {
                let event = event?;
                let reported = match &event {
                    StreamEvent::MessageStart { message } => message.usage.as_ref(),
                    StreamEvent::MessageDelta { delta } => delta.usage.as_ref(),
                    _ => None,
                };
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
                match event {
                    StreamEvent::ContentBlockStart {
                        content_block: ContentBlock::Text { text: initial, .. },
                        ..
                    } => text.push_str(&initial),
                    StreamEvent::ContentBlockDelta {
                        delta: ContentDelta::TextDelta { text: delta },
                        ..
                    } => text.push_str(&delta),
                    StreamEvent::ContentBlockDelta {
                        delta: ContentDelta::ThinkingDelta { thinking },
                        ..
                    } => {
                        reasoning_bytes = reasoning_bytes.saturating_add(thinking.len());
                    }
                    StreamEvent::MessageDelta { delta } => {
                        if matches!(
                            delta.stop_reason.as_deref(),
                            Some("max_tokens" | "length" | "max_output_tokens")
                        ) {
                            return Err(WikiOutputTruncated {
                                stage: input.stage,
                                text_bytes: text.len(),
                                reasoning_bytes,
                                requested_tokens,
                                reported_output_tokens: usage
                                    .as_ref()
                                    .map(|value| value.output_tokens),
                                stop_reason: delta.stop_reason.unwrap(),
                            }
                            .into());
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
                ensure!(
                    text.len() <= kcoder_knowledge::WIKI_MAX_OUTPUT_BYTES,
                    "Wiki model output is too large"
                );
            }
            ensure!(stopped, "Wiki model stream ended before completion");
            ensure!(!text.trim().is_empty(), "Wiki model returned no content");
            Ok(text)
        }
        .await;
        match result {
            Ok(text) => Ok((text, usage)),
            Err(error) => Err(error.context(WikiReportedUsage(usage))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_api::{ApiErrorKind, ProviderStream};
    struct Fixture {
        finished: bool,
    }
    impl Provider for Fixture {
        fn name(&self) -> &'static str {
            "wiki-fixture"
        }
        fn stream_messages(
            &self,
            request: MessagesRequest,
        ) -> Result<ProviderStream, ApiErrorKind> {
            assert_eq!(request.model, "target-model");
            assert!(request.tools.is_empty());
            let mut events = vec![
                Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::ThinkingDelta {
                        thinking: "private reasoning".into(),
                    },
                }),
                Ok(StreamEvent::ContentBlockDelta {
                    index: 1,
                    delta: ContentDelta::TextDelta {
                        text: "{\"summary\":\"source-backed\"}".into(),
                    },
                }),
            ];
            if self.finished {
                events.push(Ok(StreamEvent::MessageStop));
            }
            Ok(Box::pin(futures::stream::iter(events)))
        }
    }
    fn request() -> WikiModelRequest {
        WikiModelRequest {
            stage: "analysis",
            system: "Analyze evidence".into(),
            user: "source".into(),
            max_output_tokens: 1024,
        }
    }
    #[tokio::test]
    async fn expanded_output_stream_accepts_old_limit_plus_one_but_rejects_new_limit_plus_one() {
        struct Large {
            bytes: usize,
            expected_limit: u32,
        }
        impl Provider for Large {
            fn name(&self) -> &'static str {
                "large-output-fixture"
            }
            fn stream_messages(
                &self,
                request: MessagesRequest,
            ) -> Result<ProviderStream, ApiErrorKind> {
                assert_eq!(request.max_tokens, self.expected_limit);
                Ok(Box::pin(futures::stream::iter(vec![
                    Ok(StreamEvent::ContentBlockDelta {
                        index: 0,
                        delta: ContentDelta::TextDelta {
                            text: "a".repeat(self.bytes),
                        },
                    }),
                    Ok(StreamEvent::MessageStop),
                ])))
            }
        }
        for bytes in [1024 * 1024 + 1, kcoder_knowledge::WIKI_MAX_OUTPUT_BYTES + 1] {
            let model = ProviderWikiModel {
                provider: Arc::new(Large {
                    bytes,
                    expected_limit: 1_048_576,
                }),
                model: "fixture".into(),
                max_output_tokens: Some(2_000_000),
                reasoning: None,
            };
            let result = model.complete(request()).await;
            if bytes > kcoder_knowledge::WIKI_MAX_OUTPUT_BYTES {
                assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("Wiki model request failed")
                );
            } else {
                assert_eq!(result.unwrap().len(), bytes);
            }
        }
        let bounded = ProviderWikiModel {
            provider: Arc::new(Large {
                bytes: 10,
                expected_limit: 4096,
            }),
            model: "fixture".into(),
            max_output_tokens: Some(2_000_000),
            reasoning: None,
        };
        assert_eq!(
            bounded
                .complete_with_output_limit(request(), 4096)
                .await
                .unwrap()
                .len(),
            10
        );
    }
    #[test]
    fn reasoning_does_not_consume_the_entire_analysis_allowance() {
        let mut model = ProviderWikiModel {
            provider: Arc::new(Fixture { finished: true }),
            model: "target-model".into(),
            max_output_tokens: Some(81920),
            reasoning: Some(kcoder_types::ReasoningEffort::High),
        };
        assert_eq!(model.stage_output_limit(2048).unwrap(), 81920);
        assert_eq!(model.stage_output_limit(8192).unwrap(), 81920);
        model.reasoning = None;
        model.max_output_tokens = Some(65536);
        assert_eq!(model.stage_output_limit(32768).unwrap(), 65536);
        assert_eq!(model.stage_output_limit(8192).unwrap(), 65536);
        model.max_output_tokens = None;
        assert_eq!(model.stage_output_limit(8192).unwrap(), 1048576);
        model.max_output_tokens = Some(100000);
        assert_eq!(model.stage_output_limit(8192).unwrap(), 100000);
        model.max_output_tokens = Some(300000);
        assert_eq!(model.stage_output_limit(8192).unwrap(), 300000);
        model.max_output_tokens = Some(2_000_000);
        assert_eq!(model.stage_output_limit(8192).unwrap(), 1048576);
        model.reasoning = Some(kcoder_types::ReasoningEffort::High);
        model.max_output_tokens = Some(2048);
        assert!(model.stage_output_limit(2048).is_err());
    }

    #[tokio::test]
    async fn uses_target_provider_and_does_not_mix_reasoning_into_json() -> Result<()> {
        let model = ProviderWikiModel {
            provider: Arc::new(Fixture { finished: true }),
            model: "target-model".into(),
            max_output_tokens: None,
            reasoning: None,
        };
        assert_eq!(
            model.complete(request()).await?,
            "{\"summary\":\"source-backed\"}"
        );
        let interrupted = ProviderWikiModel {
            provider: Arc::new(Fixture { finished: false }),
            model: "target-model".into(),
            max_output_tokens: None,
            reasoning: None,
        };
        assert!(interrupted.complete(request()).await.is_err());
        Ok(())
    }
    #[tokio::test]
    async fn image_import_sends_native_image_without_tools() -> Result<()> {
        struct Vision;
        impl Provider for Vision {
            fn name(&self) -> &'static str {
                "vision-fixture"
            }
            fn stream_messages(
                &self,
                request: MessagesRequest,
            ) -> Result<ProviderStream, ApiErrorKind> {
                let Message::User { content, .. } = &request.messages[0] else {
                    panic!("expected user content")
                };
                assert!(
                    matches!(&content[1], ContentBlock::Image { source } if source.media_type == "image/png" && source.data == "aW1hZ2U=")
                );
                assert!(request.tools.is_empty());
                Fixture { finished: true }.stream_messages(request)
            }
        }
        let model = ProviderWikiModel {
            provider: Arc::new(Vision),
            model: "target-model".into(),
            max_output_tokens: Some(8192),
            reasoning: None,
        };
        let (text, _) = model
            .complete_with_image(
                WikiModelRequest {
                    stage: "image_import",
                    system: "Describe visible evidence".into(),
                    user: "Read image".into(),
                    max_output_tokens: 8192,
                },
                Some(kcoder_types::ImageSource::base64("image/png", "aW1hZ2U=")),
            )
            .await?;
        assert!(!text.contains("private reasoning"));
        Ok(())
    }
}
