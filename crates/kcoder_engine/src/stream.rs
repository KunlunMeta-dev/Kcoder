use async_stream::stream;
use futures::{Stream, StreamExt};
use kcoder_api::ApiErrorKind;
use kcoder_types::StreamEvent;
use std::pin::Pin;
use std::time::Duration;
use tokio::time::Instant;

pub const DEFAULT_STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(180);
pub const DEFAULT_STREAM_PREFILL_TIMEOUT: Duration = Duration::from_secs(1800);

/// Prefill can take much longer than the interval between generated tokens.
/// Invalid values retain the default and do not alter the streaming watchdog.
pub(crate) fn prefill_timeout(configured_seconds: Option<&str>) -> Duration {
    configured_seconds
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|seconds| (1..=86_400).contains(seconds))
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_STREAM_PREFILL_TIMEOUT)
}

pub(crate) fn configured_prefill_timeout(idle_timeout: Duration) -> Duration {
    effective_prefill_timeout(
        std::env::var("KCODER_STREAM_PREFILL_TIMEOUT_S")
            .ok()
            .as_deref(),
        idle_timeout,
    )
}

fn effective_prefill_timeout(configured_seconds: Option<&str>, idle_timeout: Duration) -> Duration {
    prefill_timeout(configured_seconds).max(idle_timeout)
}

fn content_block_has_progress(content: &kcoder_types::ContentBlock) -> bool {
    use kcoder_types::ContentBlock;
    match content {
        ContentBlock::Text { text } => !text.is_empty(),
        ContentBlock::Thinking {
            thinking,
            signature,
        } => !thinking.is_empty() || !signature.is_empty(),
        ContentBlock::ToolUse { id, name, input } => {
            !id.is_empty()
                || !name.is_empty()
                || match input {
                    serde_json::Value::Null => false,
                    serde_json::Value::Object(map) => !map.is_empty(),
                    _ => true,
                }
        }
        ContentBlock::ToolResult { content, .. } => content.iter().any(content_block_has_progress),
        ContentBlock::Image { source } => !source.data.is_empty(),
        ContentBlock::RedactedThinking { data } => !data.is_empty(),
    }
}

pub(crate) fn initial_model_progress(event: &StreamEvent) -> bool {
    use kcoder_types::ContentDelta;
    match event {
        StreamEvent::MessageStart { message } => {
            message.content.iter().any(content_block_has_progress)
        }
        StreamEvent::ContentBlockStart { content_block, .. } => {
            content_block_has_progress(content_block)
        }
        StreamEvent::ContentBlockDelta { delta, .. } => match delta {
            ContentDelta::TextDelta { text } => !text.is_empty(),
            ContentDelta::ThinkingDelta { thinking } => !thinking.is_empty(),
            ContentDelta::SignatureDelta { signature } => !signature.is_empty(),
            ContentDelta::InputJsonDelta { partial_json } => !partial_json.is_empty(),
        },
        StreamEvent::ToolCallProgress => true,
        _ => false,
    }
}

/// Slime returns a complete sampled turn only after inference has finished.
/// Its training sessions therefore need an explicit, longer idle allowance.
/// Keep the ordinary interactive watchdog unchanged.
pub(crate) fn training_stream_idle_timeout(
    training_mode: bool,
    configured_seconds: Option<&str>,
) -> Duration {
    if training_mode
        && let Some(seconds) = configured_seconds
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|seconds| *seconds > 0 && *seconds <= 86_400)
    {
        return Duration::from_secs(seconds);
    }
    DEFAULT_STREAM_IDLE_TIMEOUT
}

/// Graded idle tolerance for streaming retries. Long provider "thinking"
/// bursts (e.g. one huge generation) can legitimately go quiet beyond the
/// base window; when a retry has already happened we give the next attempt
/// more room instead of killing it at the same threshold again.
///
/// Ladder: attempt 0 -> base (180s), attempt 1 -> 5/3x (300s), attempt 2+ -> 8/3x (480s).
pub fn graded_idle_timeout(base: Duration, attempt: usize) -> Duration {
    match attempt {
        0 => base,
        1 => base * 5 / 3,
        _ => base * 8 / 3,
    }
}

/// Wrap a provider stream with an idle watchdog.
///
/// If no event is received within `idle_timeout`, the stream yields an
/// `ApiErrorKind::Api { error_type: "stream_idle_timeout" }` and terminates.
/// This mirrors KCoder's streaming idle watchdog (default 180s).
pub fn timed_stream<S>(
    inner: S,
    idle_timeout: Duration,
) -> Pin<Box<dyn Stream<Item = Result<StreamEvent, ApiErrorKind>> + Send>>
where
    S: Stream<Item = Result<StreamEvent, ApiErrorKind>> + Send + 'static,
{
    timed_stream_impl(inner, idle_timeout, None)
}

/// Give a bounded prefill window before model output, then enforce the normal
/// per-event watchdog. Headers, empty starts and pings do not extend prefill.
pub(crate) fn timed_stream_with_prefill<S>(
    inner: S,
    prefill_timeout: Duration,
    idle_timeout: Duration,
) -> Pin<Box<dyn Stream<Item = Result<StreamEvent, ApiErrorKind>> + Send>>
where
    S: Stream<Item = Result<StreamEvent, ApiErrorKind>> + Send + 'static,
{
    timed_stream_impl(inner, idle_timeout, Some(prefill_timeout))
}

fn timed_stream_impl<S>(
    inner: S,
    idle_timeout: Duration,
    prefill_timeout: Option<Duration>,
) -> Pin<Box<dyn Stream<Item = Result<StreamEvent, ApiErrorKind>> + Send>>
where
    S: Stream<Item = Result<StreamEvent, ApiErrorKind>> + Send + 'static,
{
    Box::pin(stream! {
        let mut last_event = Instant::now();
        let mut waiting_for_progress = prefill_timeout.is_some();
        let mut inner = Box::pin(inner);
        let mut completed = false;
        loop {
            let timeout_window = if waiting_for_progress { prefill_timeout.unwrap_or(idle_timeout) } else { idle_timeout };
            let deadline = last_event + timeout_window;
            if Instant::now() >= deadline {
                if !completed {
                    yield Err(ApiErrorKind::Api {
                        error_type: "stream_idle_timeout".to_string(),
                        message: format!("stream idle for more than {:?}", timeout_window),
                    });
                }
                break;
            }
            let timeout = tokio::time::sleep_until(deadline);
            tokio::pin!(timeout);
            tokio::select! {
                biased;
                item = inner.next() => {
                    match item {
                        Some(Ok(event)) => {
                            if matches!(event, StreamEvent::MessageStop) {
                                completed = true;
                                waiting_for_progress = false;
                                last_event = Instant::now();
                            } else if waiting_for_progress {
                                if initial_model_progress(&event) {
                                    waiting_for_progress = false;
                                    last_event = Instant::now();
                                }
                            } else if !matches!(event, StreamEvent::Ping) {
                                last_event = Instant::now();
                            }
                            yield Ok(event);
                        }
                        Some(Err(error)) => { yield Err(error); break; }
                        None => {
                            if !completed {
                                yield Err(ApiErrorKind::Api {
                                    error_type: "stream_incomplete".to_string(),
                                    message: "provider stream closed before a terminal message_stop".to_string(),
                                });
                            }
                            break;
                        }
                    }
                }
                _ = timeout => {
                    if !completed {
                        yield Err(ApiErrorKind::Api {
                            error_type: "stream_idle_timeout".to_string(),
                            message: format!("stream idle for more than {:?}", timeout_window),
                        });
                    }
                    break;
                }
            }
        }
    })
}

/// Convenience wrapper with bounded prefill and the default 180s streaming idle timeout.
pub fn default_timed_stream<S>(
    inner: S,
) -> Pin<Box<dyn Stream<Item = Result<StreamEvent, ApiErrorKind>> + Send>>
where
    S: Stream<Item = Result<StreamEvent, ApiErrorKind>> + Send + 'static,
{
    timed_stream_with_prefill(
        inner,
        configured_prefill_timeout(DEFAULT_STREAM_IDLE_TIMEOUT),
        DEFAULT_STREAM_IDLE_TIMEOUT,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_stream::stream;
    use futures::StreamExt;

    #[test]
    fn prefill_timeout_defaults_to_thirty_minutes_and_accepts_a_bounded_override() {
        assert_eq!(prefill_timeout(None), Duration::from_secs(1800));
        assert_eq!(prefill_timeout(Some("900")), Duration::from_secs(900));
        assert_eq!(prefill_timeout(Some("86400")), Duration::from_secs(86_400));
        for value in ["", "0", "-1", "86401", "invalid"] {
            assert_eq!(prefill_timeout(Some(value)), DEFAULT_STREAM_PREFILL_TIMEOUT);
        }
        assert_eq!(
            effective_prefill_timeout(None, Duration::from_secs(3600)),
            Duration::from_secs(3600)
        );
        assert_eq!(
            effective_prefill_timeout(Some("120"), Duration::from_secs(180)),
            Duration::from_secs(180)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn long_prefill_accepts_real_output_then_restores_the_shorter_idle_watchdog() {
        let inner = stream! {
            yield Ok(StreamEvent::MessageStart { message: kcoder_types::StreamingMessage {
                id: String::new(), role: "assistant".into(), content: Vec::new(), model: "fixture".into(),
                stop_reason: None, stop_sequence: None, usage: None,
            }});
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0, content_block: kcoder_types::ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::Ping);
            tokio::time::sleep(Duration::from_secs(200)).await;
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0, delta: kcoder_types::ContentDelta::TextDelta { text: "actual output".into() },
            });
            tokio::time::sleep(Duration::from_secs(200)).await;
            yield Ok(StreamEvent::MessageStop);
        };
        let started = Instant::now();
        let events =
            timed_stream_with_prefill(inner, Duration::from_secs(900), Duration::from_secs(180))
                .collect::<Vec<_>>()
                .await;
        assert!(
            events
                .iter()
                .any(|event| matches!(event, Ok(StreamEvent::ContentBlockDelta { .. })))
        );
        assert!(
            matches!(events.last(), Some(Err(ApiErrorKind::Api { error_type, .. })) if error_type == "stream_idle_timeout")
        );
        assert_eq!(started.elapsed(), Duration::from_secs(380));
    }

    #[tokio::test(start_paused = true)]
    async fn prefill_keepalives_and_empty_starts_do_not_extend_its_deadline() {
        let inner = stream! {
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0, content_block: kcoder_types::ContentBlock::Text { text: String::new() },
            });
            loop {
                tokio::time::sleep(Duration::from_secs(20)).await;
                yield Ok(StreamEvent::Ping);
            }
        };
        let started = Instant::now();
        let events =
            timed_stream_with_prefill(inner, Duration::from_secs(100), Duration::from_secs(10))
                .collect::<Vec<_>>()
                .await;
        assert!(
            matches!(events.last(), Some(Err(ApiErrorKind::Api { error_type, .. })) if error_type == "stream_idle_timeout")
        );
        assert_eq!(started.elapsed(), Duration::from_secs(100));
    }

    #[tokio::test(start_paused = true)]
    async fn cancelling_during_prefill_drops_the_original_provider_stream() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        struct DropMarker(Arc<AtomicBool>);
        impl Drop for DropMarker {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicBool::new(false));
        let marker = DropMarker(dropped.clone());
        let inner = stream! {
            let _marker = marker;
            std::future::pending::<()>().await;
            yield Ok(StreamEvent::MessageStop);
        };
        let mut stream =
            timed_stream_with_prefill(inner, Duration::from_secs(1800), Duration::from_secs(180));
        assert!(
            tokio::time::timeout(Duration::from_secs(1), stream.next())
                .await
                .is_err()
        );
        drop(stream);
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[test]
    fn training_idle_override_keeps_the_interactive_default() {
        assert_eq!(
            training_stream_idle_timeout(true, Some("900")),
            Duration::from_secs(900)
        );
        assert_eq!(
            training_stream_idle_timeout(false, Some("900")),
            DEFAULT_STREAM_IDLE_TIMEOUT
        );
        for value in [
            None,
            Some(""),
            Some("invalid"),
            Some("0"),
            Some("-1"),
            Some("86401"),
        ] {
            assert_eq!(
                training_stream_idle_timeout(true, value),
                DEFAULT_STREAM_IDLE_TIMEOUT
            );
        }
    }

    #[test]
    fn graded_idle_timeout_escalates_later_attempts() {
        let base = Duration::from_secs(180);
        assert_eq!(graded_idle_timeout(base, 0), Duration::from_secs(180));
        assert_eq!(graded_idle_timeout(base, 1), Duration::from_secs(300));
        assert_eq!(graded_idle_timeout(base, 2), Duration::from_secs(480));
        assert_eq!(graded_idle_timeout(base, 7), Duration::from_secs(480));
    }

    #[tokio::test]
    async fn times_out_on_idle() {
        let inner = stream! {
            tokio::time::sleep(Duration::from_secs(10)).await;
            yield Ok(StreamEvent::Ping);
        };
        let mut timed = timed_stream(inner, Duration::from_millis(50));
        let result = timed.next().await;
        assert!(result.is_some());
        assert!(
            matches!(result.unwrap(), Err(ApiErrorKind::Api { error_type, .. }) if error_type == "stream_idle_timeout")
        );
    }

    #[tokio::test]
    async fn passes_through_events() {
        let inner = stream! {
            yield Ok(StreamEvent::Ping);
        };
        let mut timed = timed_stream(inner, Duration::from_secs(1));
        let result = timed.next().await;
        assert!(matches!(result, Some(Ok(StreamEvent::Ping))));
    }

    #[tokio::test]
    async fn reports_streams_that_close_without_message_stop() {
        let inner = stream! {
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: kcoder_types::ContentDelta::ThinkingDelta {
                    thinking: "partial reasoning".to_string(),
                },
            });
        };
        let mut timed = timed_stream(inner, Duration::from_secs(1));

        assert!(matches!(
            timed.next().await,
            Some(Ok(StreamEvent::ContentBlockDelta { .. }))
        ));
        assert!(matches!(
            timed.next().await,
            Some(Err(ApiErrorKind::Api { error_type, .. }))
                if error_type == "stream_incomplete"
        ));
    }

    #[tokio::test]
    async fn accepts_streams_with_a_real_message_stop() {
        let inner = stream! {
            yield Ok(StreamEvent::MessageStop);
        };
        let mut timed = timed_stream(inner, Duration::from_secs(1));

        assert!(matches!(
            timed.next().await,
            Some(Ok(StreamEvent::MessageStop))
        ));
        assert!(timed.next().await.is_none());
    }

    #[tokio::test]
    async fn active_stream_can_outlive_one_idle_timeout_window() {
        let inner = stream! {
            for _ in 0..4 {
                tokio::time::sleep(Duration::from_millis(20)).await;
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: kcoder_types::ContentDelta::TextDelta {
                        text: "progress".to_string(),
                    },
                });
            }
            yield Ok(StreamEvent::MessageStop);
        };
        let mut timed = timed_stream(inner, Duration::from_millis(35));
        let mut delta_count = 0;

        while let Some(event) = timed.next().await {
            match event.unwrap() {
                StreamEvent::ContentBlockDelta { .. } => delta_count += 1,
                StreamEvent::MessageStop => break,
                _ => {}
            }
        }

        assert_eq!(delta_count, 4);
    }

    #[tokio::test]
    async fn keepalive_pings_do_not_mask_model_idle_timeout() {
        let inner = stream! {
            loop {
                tokio::time::sleep(Duration::from_millis(10)).await;
                yield Ok(StreamEvent::Ping);
            }
        };
        let mut timed = timed_stream(inner, Duration::from_millis(35));
        let saw_timeout = tokio::time::timeout(Duration::from_millis(100), async {
            while let Some(event) = timed.next().await {
                if matches!(
                    event,
                    Err(ApiErrorKind::Api { ref error_type, .. })
                        if error_type == "stream_idle_timeout"
                ) {
                    return true;
                }
            }
            false
        })
        .await;

        assert!(matches!(saw_timeout, Ok(true)));
    }
}

#[cfg(test)]
#[path = "stream/genai_progress_tests.rs"]
mod genai_progress_tests;

#[cfg(test)]
#[path = "stream/prefill_tests.rs"]
mod prefill_tests;

#[cfg(test)]
#[path = "stream/reasoning_replay_tests.rs"]
mod reasoning_replay_tests;
