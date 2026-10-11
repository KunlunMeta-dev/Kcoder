#[cfg(test)]
use kcoder_types::Usage;
use kcoder_types::{ContentDelta, StreamEvent};
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub(super) enum Protocol {
    Chat,
    Responses,
    Anthropic,
}

impl Protocol {
    fn label(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Responses => "responses",
            Self::Anthropic => "anthropic",
        }
    }
}

#[derive(Clone, Default)]
pub(super) struct ObservedUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_input_tokens: Option<u64>,
    pub cache_creation_input_tokens: Option<u64>,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum Outcome {
    Dropped,
    UpstreamCompleted,
    NetworkError,
    HttpError,
    ResponseError,
    StreamError,
    Incomplete,
}

/// Numeric-only per-attempt observations, with no request or response payload retention.
pub(super) struct TransportMetrics {
    protocol: Protocol,
    started: Instant,
    prepared: Duration,
    request_body_bytes: usize,
    status: Option<u16>,
    first_sse: Option<Duration>,
    first_text: Option<Duration>,
    usage: Option<ObservedUsage>,
    outcome: Outcome,
}

impl TransportMetrics {
    pub(super) fn new(protocol: Protocol, prepared: Duration, request_body_bytes: usize) -> Self {
        Self {
            protocol,
            started: Instant::now(),
            prepared,
            request_body_bytes,
            status: None,
            first_sse: None,
            first_text: None,
            usage: None,
            outcome: Outcome::Dropped,
        }
    }
    pub(super) fn status(&mut self, status: u16) {
        self.status = Some(status);
    }
    pub(super) fn sse(&mut self) {
        self.first_sse.get_or_insert(self.started.elapsed());
    }
    pub(super) fn event(&mut self, event: &StreamEvent) {
        self.event_at(event, self.started.elapsed());
    }
    fn event_at(&mut self, event: &StreamEvent, elapsed: Duration) {
        match event {
            StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            } if !text.is_empty() => {
                self.first_text.get_or_insert(elapsed);
            }
            StreamEvent::MessageDelta { delta }
                if !matches!(self.protocol, Protocol::Anthropic) =>
            {
                if let Some(usage) = &delta.usage {
                    self.usage = Some(ObservedUsage {
                        input_tokens: Some(u64::from(usage.input_tokens)),
                        output_tokens: Some(u64::from(usage.output_tokens)),
                        cache_read_input_tokens: usage.cache_read_input_tokens.map(u64::from),
                        cache_creation_input_tokens: usage
                            .cache_creation_input_tokens
                            .map(u64::from),
                    });
                }
            }
            _ => {}
        }
    }
    pub(super) fn outcome(&mut self, outcome: Outcome) {
        self.outcome = outcome;
    }

    pub(super) fn anthropic_usage(&mut self, payload: &serde_json::Map<String, serde_json::Value>) {
        use serde_json::Value;
        let usage = match payload.get("type").and_then(Value::as_str) {
            Some("message_start") => payload
                .get("message")
                .and_then(|message| message.get("usage")),
            Some("message_delta") => payload
                .get("usage")
                .or_else(|| payload.get("delta").and_then(|delta| delta.get("usage"))),
            _ => None,
        }
        .and_then(Value::as_object);
        let Some(usage) = usage else {
            return;
        };
        let observed = self.usage.get_or_insert_with(ObservedUsage::default);
        // These are cumulative observations, not increments. Missing fields keep prior values.
        for (name, target) in [
            ("input_tokens", &mut observed.input_tokens),
            ("output_tokens", &mut observed.output_tokens),
            (
                "cache_read_input_tokens",
                &mut observed.cache_read_input_tokens,
            ),
            (
                "cache_creation_input_tokens",
                &mut observed.cache_creation_input_tokens,
            ),
        ] {
            if let Some(value) = usage.get(name).and_then(Value::as_u64) {
                *target = Some(value);
            }
        }
    }
}

impl Drop for TransportMetrics {
    fn drop(&mut self) {
        #[cfg(test)]
        LAST_OBSERVATION.with(|slot| {
            *slot.borrow_mut() = Some(Observation {
                protocol: self.protocol.label(),
                outcome: self.outcome,
                bytes: self.request_body_bytes,
                status: self.status,
                first_text: self.first_text,
                usage: self.usage.clone(),
            });
        });
        tracing::debug!(
            target: "kcoder::transport_metrics",
            protocol = self.protocol.label(),
            request_body_bytes = self.request_body_bytes,
            request_prepare_us = self.prepared.as_micros() as u64,
            elapsed_us = self.started.elapsed().as_micros() as u64,
            first_sse_us = ?self.first_sse.map(|value| value.as_micros() as u64),
            first_text_us = ?self.first_text.map(|value| value.as_micros() as u64),
            status = ?self.status,
            outcome = ?self.outcome,
            input_tokens = ?self.usage.as_ref().and_then(|value| value.input_tokens),
            output_tokens = ?self.usage.as_ref().and_then(|value| value.output_tokens),
            cache_read_tokens = ?self.usage.as_ref().and_then(|value| value.cache_read_input_tokens),
            cache_creation_tokens = ?self.usage.as_ref().and_then(|value| value.cache_creation_input_tokens),
            "provider transport attempt"
        );
    }
}

#[cfg(test)]
pub(super) struct Observation {
    pub protocol: &'static str,
    pub outcome: Outcome,
    pub bytes: usize,
    pub status: Option<u16>,
    pub first_text: Option<Duration>,
    pub usage: Option<ObservedUsage>,
}

#[cfg(test)]
thread_local! {
    static LAST_OBSERVATION: std::cell::RefCell<Option<Observation>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(super) fn take_observation() -> Option<Observation> {
    LAST_OBSERVATION.with(|slot| slot.borrow_mut().take())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn anthropic_partial_usage_preserves_presence_and_cumulative_values() {
        let mut metrics = TransportMetrics::new(Protocol::Anthropic, Duration::ZERO, 123);
        let events = [
            (
                "message_start",
                r#"{"type":"message_start","message":{"id":"fixture","role":"assistant","model":"fixture","content":[],"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":20,"cache_creation_input_tokens":3}}}"#,
            ),
            (
                "message_delta",
                r#"{"type":"message_delta","delta":{},"usage":{"output_tokens":5}}"#,
            ),
            (
                "message_delta",
                r#"{"type":"message_delta","delta":{},"usage":{"output_tokens":8,"cache_read_input_tokens":0}}"#,
            ),
        ];
        for (kind, data) in events {
            let event = crate::providers::parse_anthropic_event_observed(kind, data, |payload| {
                metrics.anthropic_usage(payload)
            })
            .unwrap();
            metrics.event(&event);
        }
        let usage = metrics.usage.as_ref().unwrap();
        assert_eq!(usage.input_tokens, Some(10));
        assert_eq!(usage.output_tokens, Some(8));
        assert_eq!(usage.cache_read_input_tokens, Some(0));
        assert_eq!(usage.cache_creation_input_tokens, Some(3));
    }

    #[test]
    fn anthropic_missing_input_stays_unknown_and_mismatched_type_is_not_observed() {
        let mut metrics = TransportMetrics::new(Protocol::Anthropic, Duration::ZERO, 0);
        let data = r#"{"type":"message_delta","delta":{},"usage":{"output_tokens":0}}"#;
        assert!(
            crate::providers::parse_anthropic_event_observed("message_start", data, |payload| {
                metrics.anthropic_usage(payload)
            })
            .is_err()
        );
        assert!(metrics.usage.is_none());
        let event =
            crate::providers::parse_anthropic_event_observed("message_delta", data, |payload| {
                metrics.anthropic_usage(payload)
            })
            .unwrap();
        metrics.event(&event);
        assert_eq!(metrics.usage.as_ref().unwrap().input_tokens, None);
        assert_eq!(metrics.usage.as_ref().unwrap().output_tokens, Some(0));
    }
    #[test]
    fn zero_usage_is_distinct_from_missing_usage() {
        let mut metrics = TransportMetrics::new(Protocol::Responses, Duration::ZERO, 0);
        assert!(metrics.usage.is_none());
        metrics.event(&StreamEvent::MessageDelta {
            delta: kcoder_types::MessageDeltaFields {
                stop_reason: None,
                stop_sequence: None,
                usage: Some(Usage {
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: Some(0),
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: Some(0),
                    iterations: None,
                }),
            },
        });
        assert_eq!(
            metrics.usage.as_ref().unwrap().cache_read_input_tokens,
            Some(0)
        );
        metrics.status(200);
        metrics.outcome(Outcome::UpstreamCompleted);
        assert_eq!(metrics.status, Some(200));
        assert!(matches!(metrics.outcome, Outcome::UpstreamCompleted));
    }
    #[test]
    fn only_first_nonempty_text_counts_as_first_text() {
        let mut metrics = TransportMetrics::new(Protocol::Chat, Duration::from_millis(2), 123);
        for delta in [
            ContentDelta::ThinkingDelta {
                thinking: "private".into(),
            },
            ContentDelta::TextDelta { text: "".into() },
        ] {
            metrics.event_at(
                &StreamEvent::ContentBlockDelta { index: 0, delta },
                Duration::from_millis(3),
            );
        }
        assert!(metrics.first_text.is_none());
        for ms in [7, 9] {
            metrics.event_at(
                &StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: "visible".into(),
                    },
                },
                Duration::from_millis(ms),
            );
        }
        assert_eq!(metrics.first_text, Some(Duration::from_millis(7)));
        assert!(metrics.usage.is_none());
        assert!(metrics.status.is_none());
        metrics.sse();
        let first = metrics.first_sse;
        metrics.sse();
        assert_eq!(metrics.first_sse, first);
    }
}
