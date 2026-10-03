use std::future::Future;
use std::time::Duration;

/// Wait for an asynchronous condition within an explicit deadline, preventing unbounded test polling.
pub(crate) async fn wait_until<F, Fut>(timeout: Duration, mut condition: F) -> bool
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    tokio::time::timeout(timeout, async {
        loop {
            if condition().await {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[tokio::test]
    async fn wait_until_stops_when_condition_is_satisfied() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);

        assert!(
            wait_until(Duration::from_secs(1), move || {
                let observed = Arc::clone(&observed);
                async move { observed.fetch_add(1, Ordering::SeqCst) >= 1 }
            })
            .await
        );
        assert!(calls.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn wait_until_returns_false_at_deadline() {
        assert!(!wait_until(Duration::from_millis(1), || async { false }).await);
    }
}
