use super::*;
use std::sync::atomic::Ordering;

#[path = "internal_provider_failure_fixture.rs"]
mod internal_failure_fixture;

#[tokio::test]
async fn internal_provider_failure_moa_retains_source_without_retry() {
    for boundary in 0..3 {
        let provider = Arc::new(internal_failure_fixture::FailureProvider::new(boundary));
        let request = MessagesRequest::new("test", vec![Message::user_text("hello")]);
        let error = collect_provider_text(provider.clone(), request, CancellationToken::new())
            .await
            .unwrap_err();
        internal_failure_fixture::assert_source(&error, boundary);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    }
}
