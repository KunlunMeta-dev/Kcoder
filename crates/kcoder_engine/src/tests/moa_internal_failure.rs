use super::*;
use std::sync::atomic::Ordering;

use crate::test_support::internal_provider_failure_fixture as internal_failure_fixture;

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

// Test-only facade retains the existing root test call path without runtime helpers.
pub(crate) async fn run_moa_references(
    settings: Settings,
    preset: MoaPresetConfig,
    messages: &SharedMessages,
    session_id: String,
    cancel_token: CancellationToken,
    max_workers: usize,
    source: Option<Arc<dyn crate::ClientModelConfiguration>>,
) -> Result<Vec<MoaReferenceOutput>> {
    run_moa_references_observed(
        settings,
        preset,
        messages,
        session_id,
        cancel_token,
        max_workers,
        source,
        None,
    )
    .await
}
