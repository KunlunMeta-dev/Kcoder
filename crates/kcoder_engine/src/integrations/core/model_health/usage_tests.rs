//! Provider-event observations do not manufacture billing completeness or a second budget ledger.
use super::tests::{request, settings};
use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use futures::StreamExt;
use kcoder_api::{Provider, ProviderStream};
use kcoder_types::{MessageDeltaFields, StreamEvent, StreamingMessage, Usage};
struct Reported {
    events: Vec<StreamEvent>,
    fail: bool,
}
impl Provider for Reported {
    fn name(&self) -> &'static str {
        "reported-usage-protocol"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        let mut events: Vec<_> = self.events.clone().into_iter().map(Ok).collect();
        if self.fail {
            events.push(Err(kcoder_api::ApiErrorKind::Api {
                error_type: "overloaded_error".into(),
                message: String::new(),
            }));
        }
        Ok(Box::pin(futures::stream::iter(events)))
    }
}
fn usage(input: u32, output: u32, total: Option<u32>, cache: Option<u32>) -> Usage {
    Usage {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        cache_creation_input_tokens: None,
        cache_read_input_tokens: cache,
        iterations: None,
    }
}
fn delta(usage: Usage) -> StreamEvent {
    StreamEvent::MessageDelta {
        delta: MessageDeltaFields {
            stop_reason: None,
            stop_sequence: None,
            usage: Some(usage),
        },
    }
}
#[tokio::test]
async fn actual_positive_reports_and_explicit_optional_zero_are_preserved_without_guessing_completeness()
 {
    let root = tempfile::tempdir().unwrap();
    let events = vec![
        StreamEvent::MessageStart {
            message: StreamingMessage {
                id: "owned-response".into(),
                role: "assistant".into(),
                content: vec![],
                model: "one".into(),
                stop_reason: None,
                stop_sequence: None,
                usage: Some(usage(100, 0, None, Some(0))),
            },
        },
        delta(usage(0, 7, Some(107), None)),
        StreamEvent::MessageStop,
    ];
    let engine = TestEngineBuilder::new(root.path())
        .settings(settings())
        .provider(Arc::new(Reported {
            events,
            fail: false,
        }))
        .build_with_profile_directory();
    let model = engine.active_model_configuration_summary().unwrap();
    let events = engine
        .current_provider()
        .stream_messages(request())
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert_eq!(events.len(), 3);
    let observed = engine.integration_model_usage(&model);
    assert_eq!(observed.reported_input_tokens, Some(100));
    assert_eq!(observed.reported_output_tokens, Some(7));
    assert_eq!(observed.reported_total_tokens, Some(107));
    assert_eq!(observed.reported_cache_read_input_tokens, Some(0));
    assert!(!observed.complete);
    assert!(observed.last_observed_at.is_some());
}
#[tokio::test]
async fn missing_usage_and_normalized_zero_are_unknown_but_optional_explicit_zero_is_not_dropped() {
    for optional in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let events = vec![
            delta(usage(0, 0, optional.then_some(0), optional.then_some(0))),
            StreamEvent::MessageStop,
        ];
        let engine = TestEngineBuilder::new(root.path())
            .settings(settings())
            .provider(Arc::new(Reported {
                events,
                fail: false,
            }))
            .build_with_profile_directory();
        let model = engine.active_model_configuration_summary().unwrap();
        let _ = engine
            .current_provider()
            .stream_messages(request())
            .unwrap()
            .collect::<Vec<_>>()
            .await;
        let observed = engine.integration_model_usage(&model);
        assert_eq!(observed.reported_input_tokens, None);
        assert_eq!(observed.reported_output_tokens, None);
        assert_eq!(observed.reported_total_tokens, optional.then_some(0));
        assert_eq!(
            observed.reported_cache_read_input_tokens,
            optional.then_some(0)
        );
        assert!(!observed.complete);
    }
}
#[tokio::test]
async fn interrupted_report_keeps_actual_partial_values_and_never_turns_into_a_complete_response() {
    let root = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(root.path())
        .settings(settings())
        .provider(Arc::new(Reported {
            events: vec![delta(usage(42, 3, None, None))],
            fail: true,
        }))
        .build_with_profile_directory();
    let model = engine.active_model_configuration_summary().unwrap();
    let events = engine
        .current_provider()
        .stream_messages(request())
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert!(events.last().unwrap().is_err());
    let observed = engine.integration_model_usage(&model);
    assert_eq!(observed.reported_input_tokens, Some(42));
    assert_eq!(observed.reported_output_tokens, Some(3));
    assert!(!observed.complete);
    assert_eq!(
        engine.integration_model_health(&model).state,
        IntegrationModelHealthState::CoolingDown
    );
}
