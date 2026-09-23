use async_stream::stream;
use futures::{Stream, StreamExt};
use kcoder_api::ApiErrorKind;
use kcoder_types::StreamEvent;
use std::pin::Pin;
use std::time::Duration;
use tokio::time::Instant;

pub const DEFAULT_STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(180);

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
    Box::pin(stream! {
        let mut last_event = Instant::now();
        let mut inner = Box::pin(inner);
        let mut completed = false;
        loop {
            let deadline = last_event + idle_timeout;
            if Instant::now() >= deadline {
                if !completed {
                    yield Err(ApiErrorKind::Api {
                        error_type: "stream_idle_timeout".to_string(),
                        message: format!("stream idle for more than {:?}", idle_timeout),
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
                        Some(Ok(StreamEvent::MessageStop)) => {
                            completed = true;
                            last_event = Instant::now();
                            yield Ok(StreamEvent::MessageStop);
                        }
                        Some(Ok(StreamEvent::Ping)) => {
                            // Transport keepalives prove that the connection is open, not that
                            // the model is making progress. Keeping the content deadline intact
                            // prevents an upstream that emits only pings from hanging forever.
                            yield Ok(StreamEvent::Ping);
                        }
                        Some(Ok(event)) => {
                            last_event = Instant::now();
                            yield Ok(event);
                        }
                        Some(Err(error)) => {
                            yield Err(error);
                            break;
                        }
                        None => {
                            if !completed {
                                yield Err(ApiErrorKind::Api {
                                    error_type: "stream_incomplete".to_string(),
                                    message: "provider stream closed before a terminal message_stop"
                                        .to_string(),
                                });
                            }
                            break;
                        }
                    }
                }
                _ = timeout => {
                    if completed {
                        break;
                    }
                    yield Err(ApiErrorKind::Api {
                        error_type: "stream_idle_timeout".to_string(),
                        message: format!("stream idle for more than {:?}", idle_timeout),
                    });
                    break;
                }
            }
        }
    })
}

/// Convenience wrapper with the default 180s idle timeout.
pub fn default_timed_stream<S>(
    inner: S,
) -> Pin<Box<dyn Stream<Item = Result<StreamEvent, ApiErrorKind>> + Send>>
where
    S: Stream<Item = Result<StreamEvent, ApiErrorKind>> + Send + 'static,
{
    timed_stream(inner, DEFAULT_STREAM_IDLE_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_stream::stream;
    use futures::StreamExt;

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
