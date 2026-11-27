use super::*;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;
use tracing::instrument::WithSubscriber;

const PRIVATE: &str = "SYNTHETIC_PRIVATE_SDK_HTTP_ERROR";

struct SdkLogs(Arc<Mutex<String>>, bool);

impl tracing::Subscriber for SdkLogs {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        self.1 || metadata.target().starts_with("genai::")
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
            tracing::span::Id::from_u64(NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
        }
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
    fn max_level_hint(&self) -> Option<tracing::metadata::LevelFilter> {
        Some(tracing::metadata::LevelFilter::TRACE)
    }
    fn event(&self, event: &tracing::Event<'_>) {
        struct Fields<'a>(&'a mut String);
        impl tracing::field::Visit for Fields<'_> {
            fn record_debug(&mut self, _: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                use std::fmt::Write;
                writeln!(self.0, "{value:?}").unwrap();
            }
        }
        event.record(&mut Fields(&mut self.0.lock().unwrap()));
    }
}

async fn request(status: u16, body: String) -> (ApiErrorKind, String) {
    request_with_retry_after(status, body, None).await
}

async fn request_with_retry_after(
    status: u16,
    body: String,
    retry_after: Option<String>,
) -> (ApiErrorKind, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        crate::providers::http_fixture::read_request(&mut socket).await;
        let retry_after = retry_after
            .map(|value| format!("Retry-After: {value}\r\n"))
            .unwrap_or_default();
        let response = format!(
            "HTTP/1.1 {status} Fixture Failure\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{retry_after}Connection: close\r\n\r\n{body}",
            body.len()
        );
        // The bounded reader may close before the final chunk reaches the socket.
        let _ = socket.write_all(response.as_bytes()).await;
    });
    let provider = GenAiProvider::new("fixture")
        .unwrap()
        .with_base_url(format!("http://{address}/v1"))
        .with_no_proxy(true)
        .unwrap();
    let logs = Arc::new(Mutex::new(String::new()));
    let events = tokio::time::timeout(
        Duration::from_secs(3),
        provider
            .stream_messages(MessagesRequest::new(
                "gpt-4o",
                vec![Message::user_text("fixture")],
            ))
            .unwrap()
            .collect::<Vec<_>>()
            .with_subscriber(SdkLogs(Arc::clone(&logs), false)),
    )
    .await
    .unwrap();
    crate::providers::http_fixture::join(server).await;
    assert_eq!(
        events.len(),
        1,
        "HTTP failure must precede synthetic model output"
    );
    let error = events.into_iter().next().unwrap().unwrap_err();
    let logs = logs.lock().unwrap().clone();
    assert!(!format!("{error} {error:?} {logs}").contains(PRIVATE));
    (error, logs)
}

#[tokio::test]
async fn invalid_usage_observation_is_terminal_without_a_raw_error_or_trace_canary() {
    for (inline, previous) in [
        (false, Value::Null),
        (
            false,
            serde_json::json!({"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}),
        ),
        (true, Value::String(PRIVATE.into())),
        (true, serde_json::json!({"completion_tokens":PRIVATE})),
    ] {
        let prefix = serde_json::json!({"choices":[{"index":0,"delta":{"content":"owned answer"},"finish_reason":"stop"}],"usage":previous});
        let invalid = serde_json::json!({"choices":[],"usage":PRIVATE});
        let body = if inline {
            format!("data: {prefix}\n\ndata: [DONE]\n\n")
        } else {
            format!("data: {prefix}\n\ndata: {invalid}\n\ndata: [DONE]\n\n")
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            crate::providers::http_fixture::read_request(&mut socket).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        });
        let provider = GenAiProvider::new("owned-fixture")
            .unwrap()
            .with_base_url(format!("http://{address}/v1"))
            .with_no_proxy(true)
            .unwrap();
        let logs = Arc::new(Mutex::new(String::new()));
        let events = tokio::time::timeout(
            Duration::from_secs(3),
            provider
                .stream_messages(MessagesRequest::new(
                    "gpt-4o",
                    vec![Message::user_text("owned request")],
                ))
                .unwrap()
                .collect::<Vec<_>>()
                .with_subscriber(SdkLogs(Arc::clone(&logs), true)),
        )
        .await
        .unwrap();
        crate::providers::http_fixture::join(server).await;
        let captured = logs.lock().unwrap().clone();
        assert!(
            !captured.contains(PRIVATE),
            "invalid usage must not reach the SDK raw serde-error logger"
        );
        let failure = events
            .iter()
            .position(Result::is_err)
            .expect("invalid usage is a protocol failure");
        assert_eq!(
            failure + 1,
            events.len(),
            "the first error is the final event"
        );
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, Ok(StreamEvent::MessageStop)))
        );
        let error = events.last().unwrap().as_ref().unwrap_err();
        assert!(!format!("{error:?} {error}").contains(PRIVATE));
        assert_eq!(
            error.non_http_error_class(),
            Some(crate::NonHttpErrorClass::Permanent)
        );
    }
}

#[tokio::test]
async fn oversized_sdk_http_errors_keep_original_status_without_body_or_log_leaks() {
    for status in [401, 429, 529] {
        let (error, logs) = request(status, format!("{PRIVATE}{}", "x".repeat(64 * 1024))).await;
        assert!(
            matches!(error, ApiErrorKind::Http { ref metadata, .. } if metadata.status == status)
        );
        assert_eq!(
            error.non_http_error_class(),
            None,
            "HTTP recovery must retain its typed status"
        );
        assert!(
            logs.contains("Provider stream failed"),
            "SDK error log must be captured and safe"
        );
    }
}

#[tokio::test]
async fn small_sdk_http_error_keeps_business_type_and_private_text_out_of_sdk_logs() {
    let body =
        serde_json::json!({"error":{"type":"rate_limit_error","message":PRIVATE}}).to_string();
    let (error, logs) = request(429, body).await;
    assert!(matches!(error, ApiErrorKind::Http { ref metadata, .. }
        if metadata.status == 429 && metadata.provider_type.as_deref() == Some("rate_limit_error")));
    assert!(logs.contains("Provider stream failed"));
}

#[tokio::test]
async fn streaming_retry_after_seconds_and_http_date_survive_boxed_http_errors() {
    for status in [401, 429, 529] {
        let body = if status == 429 {
            format!("{PRIVATE}{}", "x".repeat(64 * 1024))
        } else {
            serde_json::json!({"error":{"message":PRIVATE}}).to_string()
        };
        let (error, logs) = request_with_retry_after(status, body, Some("2.5".into())).await;
        let ApiErrorKind::Http { metadata, .. } = error else {
            panic!("lost HTTP classification")
        };
        assert_eq!(metadata.status, status);
        assert_eq!(metadata.retry_after, Some(Duration::from_millis(2500)));
        assert!(logs.contains("Provider stream failed"));
    }
    let date = (chrono::Utc::now() + chrono::Duration::seconds(30))
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let (error, _) = request_with_retry_after(529, "{}".into(), Some(date)).await;
    let ApiErrorKind::Http { metadata, .. } = error else {
        panic!("lost date HTTP error")
    };
    assert_eq!(metadata.status, 529);
    assert!(
        metadata.retry_after.is_some_and(
            |delay| delay >= Duration::from_secs(25) && delay <= Duration::from_secs(30)
        )
    );
}

#[tokio::test]
async fn streaming_retry_after_invalid_values_do_not_escape_into_diagnostics() {
    for hint in [None, Some("0"), Some("-1"), Some("7200"), Some(PRIVATE)] {
        let body = serde_json::json!({"error":{"type":"authentication_error","message":PRIVATE}})
            .to_string();
        let (error, _) = request_with_retry_after(401, body, hint.map(str::to_owned)).await;
        assert_eq!(
            error.non_http_error_class(),
            None,
            "HTTP authentication stays status-classified"
        );
        let ApiErrorKind::Http { metadata, .. } = error else {
            panic!("lost HTTP error")
        };
        assert_eq!(metadata.status, 401);
        assert_eq!(
            metadata.provider_type.as_deref(),
            Some("authentication_error")
        );
        assert_eq!(metadata.retry_after, None);
    }
}
