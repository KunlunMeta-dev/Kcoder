//! Synchronous metadata at the original Engine-to-Provider dispatch boundary.
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_types::MessagesRequest;
use std::{cell::Cell, sync::Arc};

thread_local! {
    static RETRY_ATTEMPT: Cell<usize> = const { Cell::new(0) };
}

struct RestoreRetry(usize);
impl Drop for RestoreRetry {
    fn drop(&mut self) {
        RETRY_ATTEMPT.with(|value| value.set(self.0));
    }
}

pub(super) fn current_retry_attempt() -> usize {
    RETRY_ATTEMPT.with(Cell::get)
}

/// Provider stream construction is synchronous. Restore the thread-local value
/// before returning the stream, so polling, awaits, unrelated tasks and nested
/// calls never inherit the caller's retry ordinal. This supplies no authority.
pub(crate) fn stream_with_retry_observation(
    provider: &Arc<dyn Provider>,
    request: MessagesRequest,
    attempt: usize,
) -> Result<ProviderStream, ApiErrorKind> {
    let _restore = RestoreRetry(RETRY_ATTEMPT.with(|value| value.replace(attempt)));
    provider.stream_messages(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Capture(Arc<Mutex<Vec<usize>>>);
    impl Provider for Capture {
        fn name(&self) -> &'static str {
            "retry-observation-test"
        }
        fn stream_messages(&self, _: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
            self.0.lock().unwrap().push(current_retry_attempt());
            Ok(Box::pin(futures::stream::empty()))
        }
    }

    #[test]
    fn retry_metadata_is_local_to_stream_construction_and_does_not_change_payload() {
        let values = Arc::new(Mutex::new(vec![]));
        let provider: Arc<dyn Provider> = Arc::new(Capture(values.clone()));
        let request = MessagesRequest::new("owned-model", vec![]);
        let before = serde_json::to_value(&request).unwrap();
        drop(stream_with_retry_observation(&provider, request.clone(), 2).unwrap());
        drop(provider.stream_messages(request.clone()).unwrap());
        assert_eq!(*values.lock().unwrap(), [2, 0]);
        assert_eq!(serde_json::to_value(&request).unwrap(), before);
        assert_eq!(current_retry_attempt(), 0);
    }

    #[test]
    fn nested_scopes_restore_on_unwind_and_other_threads_start_without_retry() {
        let previous = RETRY_ATTEMPT.with(|value| value.replace(3));
        let _outer = RestoreRetry(previous);
        let result = std::panic::catch_unwind(|| {
            let _nested = RestoreRetry(RETRY_ATTEMPT.with(|value| value.replace(7)));
            assert_eq!(current_retry_attempt(), 7);
            panic!("owned unwind");
        });
        assert!(result.is_err());
        assert_eq!(current_retry_attempt(), 3);
        assert_eq!(std::thread::spawn(current_retry_attempt).join().unwrap(), 0);
    }
}
