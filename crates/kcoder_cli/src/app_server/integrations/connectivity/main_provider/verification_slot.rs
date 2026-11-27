//! Bounded Native verification capacity; the caller retains its existing deadline.
use anyhow::{Context, Result};
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
pub(in crate::app_server::integrations::connectivity) async fn acquire(
    pool: Arc<Semaphore>,
    cancel: &CancellationToken,
) -> Result<OwnedSemaphorePermit> {
    tokio::select! {biased;
        _=cancel.cancelled()=>anyhow::bail!("APPLICATION_INVENTORY_CANCELLED"),
        permit=pool.acquire_owned()=>permit.context("APPLICATION_INVENTORY_UNAVAILABLE"),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn saturated_verification_waits_for_original_capacity_without_expanding_pool() {
        let pool = Arc::new(Semaphore::new(2));
        let first = pool.clone().acquire_owned().await.unwrap();
        let second = pool.clone().acquire_owned().await.unwrap();
        let cancel = CancellationToken::new();
        let pending = tokio::spawn({
            let pool = pool.clone();
            async move { acquire(pool, &cancel).await }
        });
        tokio::task::yield_now().await;
        assert!(!pending.is_finished());
        assert_eq!(pool.available_permits(), 0);
        drop(first);
        let observed = pending.await.unwrap().unwrap();
        assert_eq!(pool.available_permits(), 0);
        drop(observed);
        drop(second);
        assert_eq!(pool.available_permits(), 2);
    }
    #[tokio::test]
    async fn cancelled_verification_waiter_never_acquires_authority_or_retains_a_slot() {
        let pool = Arc::new(Semaphore::new(2));
        let held = pool.clone().acquire_many_owned(2).await.unwrap();
        let cancel = CancellationToken::new();
        let pending = tokio::spawn({
            let pool = pool.clone();
            let cancel = cancel.clone();
            async move { acquire(pool, &cancel).await }
        });
        tokio::task::yield_now().await;
        cancel.cancel();
        assert!(pending.await.unwrap().is_err());
        drop(held);
        assert_eq!(pool.available_permits(), 2);
    }
    #[tokio::test]
    async fn caller_deadline_drop_releases_waiter_without_changing_native_capacity() {
        let pool = Arc::new(Semaphore::new(2));
        let held = pool.clone().acquire_many_owned(2).await.unwrap();
        let cancel = CancellationToken::new();
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(10),
                acquire(pool.clone(), &cancel)
            )
            .await
            .is_err()
        );
        drop(held);
        assert_eq!(pool.available_permits(), 2);
        let slot = acquire(pool.clone(), &cancel).await.unwrap();
        drop(slot);
        assert_eq!(pool.available_permits(), 2);
    }
}
