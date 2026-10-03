use kcoder_types::{ContentBlock, ContentDelta, StreamEvent};

mod error_metadata;
pub mod provider_factory;
pub mod providers;
pub use error_metadata::{
    HttpErrorMetadata, NonHttpErrorClass, RejectedReasoningParameter, SseErrorKind,
};

pub use provider_factory::{
    MissingApiKeyError, ProviderBuildOverrides, ProviderFactory, ProviderKind, first_non_empty,
    missing_api_key_message,
};
pub use providers::{
    AnthropicProvider, GeminiProvider, GenAiProvider, GrokProvider, ModelDiscoveryOptions,
    OpenAiProvider, Provider, ProviderModelDiscovery, ProviderStream, ProviderTokenCount,
};

pub enum ApiErrorKind {
    Network(reqwest::Error),
    EventSource(Box<reqwest_eventsource::Error>),
    CannotCloneRequest(reqwest_eventsource::CannotCloneRequestError),
    JsonParse(serde_json::Error, String),
    Api {
        error_type: String,
        message: String,
    },
    SseStream {
        error_type: String,
        message: String,
        kind: SseErrorKind,
    },
    Http {
        error_type: String,
        message: String,
        metadata: HttpErrorMetadata,
    },
    InvalidHeader(reqwest::header::InvalidHeaderValue),
}

impl std::fmt::Display for ApiErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.safe_summary())?;
        if let Self::JsonParse(error, _) = self {
            write!(f, " line={}, column={}", error.line(), error.column())?;
        }
        Ok(())
    }
}

impl std::fmt::Debug for ApiErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}

impl ApiErrorKind {
    pub fn safe_summary(&self) -> kcoder_types::ProviderErrorSummary {
        let (kind, status) = match self {
            Self::Http {
                error_type,
                metadata,
                ..
            } => (
                metadata.provider_type.as_deref().unwrap_or(error_type),
                Some(metadata.status),
            ),
            Self::Api { error_type, .. } => (error_type.as_str(), None),
            Self::Network(error) if error.is_builder() => ("request_build_error", None),
            Self::Network(error) if error.is_decode() => ("response_parse_error", None),
            Self::Network(_) => ("network_error", None),
            Self::SseStream { .. } | Self::EventSource(_) => ("sse_stream_error", None),
            Self::JsonParse(_, _) => ("response_parse_error", None),
            Self::CannotCloneRequest(_) | Self::InvalidHeader(_) => ("request_build_error", None),
        };
        kcoder_types::ProviderErrorSummary::new(kind, status)
    }
}

// Keep this typed error downcastable through anyhow, but do not expose unsafe
// transport source formatting (URLs and credentials). Raw sources remain in variants.
impl std::error::Error for ApiErrorKind {}

impl From<reqwest::Error> for ApiErrorKind {
    fn from(error: reqwest::Error) -> Self {
        Self::Network(error)
    }
}
impl From<reqwest_eventsource::CannotCloneRequestError> for ApiErrorKind {
    fn from(error: reqwest_eventsource::CannotCloneRequestError) -> Self {
        Self::CannotCloneRequest(error)
    }
}
impl From<reqwest::header::InvalidHeaderValue> for ApiErrorKind {
    fn from(error: reqwest::header::InvalidHeaderValue) -> Self {
        Self::InvalidHeader(error)
    }
}

impl From<reqwest_eventsource::Error> for ApiErrorKind {
    fn from(err: reqwest_eventsource::Error) -> Self {
        Self::EventSource(Box::new(err))
    }
}

/// Convenience: accumulate text deltas from a stream of events into a single assistant message.
pub fn accumulate_assistant_text(events: &[StreamEvent]) -> Option<ContentBlock> {
    let mut text = String::new();
    for ev in events {
        if let StreamEvent::ContentBlockDelta {
            delta: ContentDelta::TextDelta { text: delta },
            ..
        } = ev
        {
            text.push_str(delta);
        }
    }
    if text.is_empty() {
        None
    } else {
        Some(ContentBlock::Text { text })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_error_summary_hides_raw_fields_and_bounds_all_formats() {
        let secret = "SENTINEL_PRIVATE Bearer multi word https://host/path?key=secret";
        let error = ApiErrorKind::Http {
            error_type: secret.repeat(1000),
            message: secret.repeat(1000),
            metadata: HttpErrorMetadata::from_response(
                401,
                &serde_json::json!({
                    "error": { "code": secret, "type": secret, "param": secret }
                })
                .to_string(),
                Some("3"),
            ),
        };
        for rendered in [error.to_string(), format!("{error:?}")] {
            assert!(!rendered.contains("SENTINEL_PRIVATE"));
            assert!(rendered.len() <= 512);
            assert!(rendered.contains("401"));
        }
        let wrapped = anyhow::Error::new(error).context("provider request failed");
        assert!(wrapped.downcast_ref::<ApiErrorKind>().is_some());
        assert!(!format!("{wrapped:#}").contains("SENTINEL_PRIVATE"));
    }

    #[test]
    fn provider_error_summary_hides_json_payload_and_transport_url_sources() {
        let raw = "SENTINEL_PRIVATE".repeat(1000);
        let error = ApiErrorKind::JsonParse(
            serde_json::from_str::<serde_json::Value>(&raw).unwrap_err(),
            raw,
        );
        assert!(!format!("{error} {error:?}").contains("SENTINEL_PRIVATE"));
        let source = reqwest::Client::new()
            .get("https://SENTINEL_PRIVATE.invalid/?token=SENTINEL_PRIVATE")
            .header("bad\nheader", "value")
            .build()
            .unwrap_err()
            .with_url(
                "https://host.invalid/?token=SENTINEL_PRIVATE"
                    .parse()
                    .unwrap(),
            );
        assert!(source.to_string().contains("SENTINEL_PRIVATE"));
        let wrapped =
            anyhow::Error::new(ApiErrorKind::Network(source)).context("provider request failed");
        assert!(
            matches!(wrapped.downcast_ref::<ApiErrorKind>(), Some(ApiErrorKind::Network(error)) if error.is_builder() && error.url().unwrap().query().unwrap().contains("SENTINEL_PRIVATE"))
        );
        assert!(!format!("{wrapped:#} {wrapped:?}").contains("SENTINEL_PRIVATE"));
    }

    #[test]
    fn accumulate_text() {
        let events = vec![
            StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "hello ".into(),
                },
            },
            StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "world".into(),
                },
            },
        ];
        let block = accumulate_assistant_text(&events).unwrap();
        assert!(matches!(block, ContentBlock::Text { text } if text == "hello world"));
    }
}
