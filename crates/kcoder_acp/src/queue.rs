//! Count and byte bounded wire queues. Backpressure never silently drops frames.
use crate::framing::MAX_FRAME_BYTES;
use anyhow::{Result, ensure};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

pub(crate) const QUEUE_BYTES: usize = 4 * 1024 * 1024;
pub(crate) struct QueuedFrame {
    pub(crate) bytes: Vec<u8>,
    _permit: OwnedSemaphorePermit,
}

#[derive(Clone)]
pub(crate) struct WireSender {
    sender: mpsc::Sender<QueuedFrame>,
    budget: Arc<Semaphore>,
    closed: CancellationToken,
}

pub(crate) fn wire_queue() -> (WireSender, mpsc::Receiver<QueuedFrame>) {
    let (sender, receiver) = mpsc::channel(256);
    (
        WireSender {
            sender,
            budget: Arc::new(Semaphore::new(QUEUE_BYTES)),
            closed: CancellationToken::new(),
        },
        receiver,
    )
}

impl WireSender {
    pub(crate) fn close(&self) {
        self.closed.cancel();
    }

    pub(crate) async fn send(&self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value)?;
        ensure!(
            bytes.len() <= MAX_FRAME_BYTES,
            "Protocol output frame exceeds 2 MiB"
        );
        bytes.push(b'\n');
        let send = async {
            let permit = self
                .budget
                .clone()
                .acquire_many_owned(bytes.len() as u32)
                .await?;
            self.sender
                .send(QueuedFrame {
                    bytes,
                    _permit: permit,
                })
                .await
                .map_err(|_| anyhow::anyhow!("Protocol output is closed"))
        };
        tokio::select! {
            biased;
            _ = self.closed.cancelled() => Err(anyhow::anyhow!("Protocol output is closed")),
            result = send => result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    #[tokio::test]
    async fn disconnect_releases_a_sender_blocked_by_a_full_output_queue() {
        let (sender, receiver) = wire_queue();
        for _ in 0..256 {
            sender.send(json!({"result":"queued"})).await.unwrap();
        }
        let blocked = sender.send(json!({"result":"must not hang after disconnect"}));
        tokio::pin!(blocked);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut blocked)
                .await
                .is_err()
        );
        sender.close();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), blocked)
                .await
                .unwrap()
                .is_err()
        );
        assert_eq!(receiver.len(), 256);
    }

    #[tokio::test]
    async fn byte_budget_stops_large_frames_before_the_message_count_limit() {
        let (sender, receiver) = wire_queue();
        let payload = "x".repeat(1_500_000);
        for _ in 0..2 {
            sender.send(json!({"text":payload})).await.unwrap();
        }
        assert!(
            tokio::time::timeout(
                Duration::from_millis(10),
                sender.send(json!({"text":payload}))
            )
            .await
            .is_err()
        );
        assert_eq!(receiver.len(), 2);
    }
}
