use super::super::usage::*;
use kcoder_state::AppState;
use kcoder_types::{StreamEvent, Usage};

#[test]
fn aggregates_stream_updates_once_and_records_failed_attempts_without_usage() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(dir.path());
    state.set_usage_history_root(Some(dir.path()));
    {
        let mut attempt = UsageAttempt::new(Some(&state), "summary-model");
        for output in [0, 20] {
            attempt.observe(&StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: None,
                    stop_sequence: None,
                    usage: Some(Usage {
                        input_tokens: 100,
                        output_tokens: output,
                        total_tokens: Some(100 + output),
                        cache_read_input_tokens: Some(80),
                        cache_creation_input_tokens: None,
                        iterations: None,
                    }),
                },
            });
        }
    }
    drop(UsageAttempt::new(Some(&state), "summary-model"));
    let history = kcoder_state::usage_history::read_usage(dir.path())
        .unwrap()
        .unwrap();
    let usage = &history.days.values().next().unwrap()["summary-model"];
    assert_eq!(usage.requests, 2);
    assert_eq!(usage.unreported_requests, 1);
    assert_eq!(usage.total_tokens, 120);
    assert_eq!(usage.cache_read_tokens, 80);
}
