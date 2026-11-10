//! Internal turn admission receipts for durable async-question delivery.

use tokio::sync::mpsc;

pub(crate) async fn receive_admission_receipt<T, E, V>(
    dispatch_result: Result<T, E>,
    sender: mpsc::Sender<V>,
    receiver: &mut mpsc::Receiver<V>,
) -> Option<V> {
    // Dispatch has finished using this sender. Retaining it would prevent a
    // missing receipt from closing the channel after all workers have exited.
    drop(sender);
    // A dispatch failure is already an uncertain admission. A worker may still
    // hold a notification sender, so waiting for its receipt could never finish.
    if dispatch_result.is_err() {
        return None;
    }
    receiver.recv().await
}

#[cfg(test)]
mod tests {
    use super::receive_admission_receipt;
    use tokio::{
        sync::mpsc,
        time::{Duration, timeout},
    };

    #[tokio::test]
    async fn failed_dispatch_does_not_wait_for_a_live_notification_sender() {
        let (sender, mut receiver) = mpsc::channel::<u8>(4);
        let notification_sender = sender.clone();
        let receipt = timeout(
            Duration::from_millis(50),
            receive_admission_receipt(Err::<(), _>("dispatch failed"), sender, &mut receiver),
        )
        .await
        .expect("failed dispatch must settle without waiting for a receipt");
        assert_eq!(receipt, None);
        assert!(!notification_sender.is_closed());
    }

    #[tokio::test]
    async fn failed_dispatch_does_not_treat_a_buffered_frame_as_acceptance() {
        let (sender, mut receiver) = mpsc::channel(4);
        sender.send(1u8).await.unwrap();
        assert_eq!(
            receive_admission_receipt(Err::<(), _>("dispatch failed"), sender, &mut receiver).await,
            None
        );
    }

    #[tokio::test]
    async fn completed_dispatch_without_a_receipt_releases_its_own_sender() {
        let (sender, mut receiver) = mpsc::channel::<u8>(4);
        let receipt = timeout(
            Duration::from_millis(50),
            receive_admission_receipt(Ok::<_, ()>(()), sender, &mut receiver),
        )
        .await
        .expect("missing receipt must be observable after dispatch releases its sender");
        assert_eq!(receipt, None);
    }

    #[tokio::test]
    async fn confirmed_admission_preserves_the_notification_stream() {
        let (sender, mut receiver) = mpsc::channel(4);
        let notification_sender = sender.clone();
        sender.send(1u8).await.unwrap();
        assert_eq!(
            receive_admission_receipt(Ok::<_, ()>(()), sender, &mut receiver).await,
            Some(1)
        );
        notification_sender.send(2).await.unwrap();
        assert_eq!(receiver.recv().await, Some(2));
    }

    #[tokio::test]
    async fn successful_dispatch_waits_for_its_delayed_authoritative_receipt() {
        let (sender, mut receiver) = mpsc::channel(4);
        let notification_sender = sender.clone();
        let receipt = receive_admission_receipt(Ok::<_, ()>(()), sender, &mut receiver);
        tokio::pin!(receipt);
        assert!(
            timeout(Duration::from_millis(10), &mut receipt)
                .await
                .is_err()
        );
        notification_sender.send(1u8).await.unwrap();
        assert_eq!(receipt.await, Some(1));
    }
}
