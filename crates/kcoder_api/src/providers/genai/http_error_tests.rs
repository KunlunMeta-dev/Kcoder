use super::*;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::instrument::WithSubscriber;

const PRIVATE: &str = "SYNTHETIC_PRIVATE_SDK_HTTP_ERROR";

struct SdkLogs(Arc<Mutex<String>>);

impl tracing::Subscriber for SdkLogs {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        metadata.target().starts_with("genai::")
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
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
        let mut request = [0_u8; 16384];
        assert!(socket.read(&mut request).await.unwrap() > 0);
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
            .with_subscriber(SdkLogs(Arc::clone(&logs))),
    )
    .await
    .unwrap();
    server.await.unwrap();
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
