//! Keep cancellation and EOF observable when response output is backpressured.
use crate::framing::{Frame, FrameReader};
use crate::permissions::Permissions;
use crate::queue::QUEUE_BYTES;
use agent_client_protocol::schema::v1::CancelNotification;
use anyhow::{Result, bail};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncBufRead;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
pub(crate) struct Controls {
    active: Arc<Mutex<BTreeMap<String, CancellationToken>>>,
    pub(crate) lifecycle: crate::diagnostics::Lifecycle,
}

impl Controls {
    pub(crate) fn register(&self, session: &str, token: CancellationToken) {
        self.active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(session.into(), token);
    }

    pub(crate) fn remove(&self, session: &str) {
        self.active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(session);
    }

    pub(crate) fn cancel(&self, session: &str, source: &'static str) {
        if let Some(token) = self
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(session)
            && !token.is_cancelled()
        {
            self.lifecycle
                .session(session)
                .record("cancel", source, "requested");
            token.cancel();
        }
    }

    fn observe(&self, value: &serde_json::Value, permissions: &Permissions) {
        if value["jsonrpc"] != "2.0" || !value.is_object() {
            return;
        }
        if value.get("method").is_none() {
            permissions.receive(value);
        } else if value["method"] == "session/cancel"
            && value.get("id").is_none()
            && let Ok(cancel) =
                serde_json::from_value::<CancelNotification>(value["params"].clone())
        {
            self.cancel(&cancel.session_id.to_string(), "client_cancel");
        }
    }
}

pub(crate) struct ReceivedFrame {
    pub(crate) frame: Frame,
    _budget: OwnedSemaphorePermit,
}

pub(crate) fn channel() -> (mpsc::Sender<ReceivedFrame>, mpsc::Receiver<ReceivedFrame>) {
    mpsc::channel(256)
}

pub(crate) async fn receive<R: AsyncBufRead + Unpin>(
    reader: R,
    sender: mpsc::Sender<ReceivedFrame>,
    controls: Controls,
    permissions: Permissions,
    closed: CancellationToken,
) -> Result<()> {
    let result = receive_frames(
        reader,
        sender,
        controls.clone(),
        permissions,
        closed.clone(),
    )
    .await;
    controls.lifecycle.record(
        "input_closed",
        if result.is_ok() {
            "input_eof"
        } else {
            "input_failure"
        },
        "parent_cancellation",
    );
    closed.cancel();
    result
}

async fn receive_frames<R: AsyncBufRead + Unpin>(
    reader: R,
    sender: mpsc::Sender<ReceivedFrame>,
    controls: Controls,
    permissions: Permissions,
    closed: CancellationToken,
) -> Result<()> {
    let _closed = closed.drop_guard();
    let mut reader = FrameReader::new(reader);
    let budget = Arc::new(Semaphore::new(QUEUE_BYTES));
    while let Some(frame) = reader.next().await? {
        let size = match &frame {
            Frame::Json(value) => {
                // This fast path does not replace ordered notification dispatch:
                // a prompt still queued before its cancel has no registered token yet.
                controls.observe(value, &permissions);
                serde_json::to_vec(value)?.len().max(1)
            }
            _ => 1,
        };
        let permit = budget
            .clone()
            .try_acquire_many_owned(size as u32)
            .map_err(|_| {
                anyhow::anyhow!("ACP input queue byte limit exceeded; connection closed")
            })?;
        if sender
            .try_send(ReceivedFrame {
                frame,
                _budget: permit,
            })
            .is_err()
        {
            // Do not wait here and strand subsequent EOF/cancel behind a full queue.
            // A flooding connection loses only its own sessions and pending authority.
            bail!("ACP input queue capacity exceeded; connection closed");
        }
        tokio::task::yield_now().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::BufReader;

    fn permissions() -> Permissions {
        let (sender, _receiver) = crate::queue::wire_queue();
        Permissions::new(sender)
    }

    #[tokio::test]
    async fn cancel_is_session_scoped_even_when_dispatch_does_not_drain_input() {
        let controls = Controls::default();
        let first = CancellationToken::new();
        let peer = CancellationToken::new();
        controls.register("first", first.clone());
        controls.register("peer", peer.clone());
        let mut lines = Vec::new();
        for frame in [
            json!({"jsonrpc":"2.0","id":1,"method":"unhandled"}),
            json!({"jsonrpc":"wrong","method":"session/cancel","params":{"sessionId":"peer"}}),
            json!({"jsonrpc":"2.0","id":2,"method":"session/cancel","params":{"sessionId":"peer"}}),
            json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"first"}}),
        ] {
            serde_json::to_writer(&mut lines, &frame).unwrap();
            lines.push(b'\n');
        }
        let (sender, mut receiver) = channel();
        let closed = CancellationToken::new();
        receive(
            BufReader::new(lines.as_slice()),
            sender,
            controls,
            permissions(),
            closed.clone(),
        )
        .await
        .unwrap();
        assert!(first.is_cancelled());
        assert!(!peer.is_cancelled());
        assert!(closed.is_cancelled());
        // Fast control delivery preserves the original dispatch order as well.
        assert_eq!(receiver.len(), 4);
        let first = receiver.recv().await.unwrap();
        let Frame::Json(value) = first.frame else {
            panic!("lost queued request")
        };
        assert_eq!(value["id"], 1);
    }

    #[tokio::test]
    async fn input_byte_overflow_closes_instead_of_waiting_for_dispatch() {
        let (sender, receiver) = channel();
        let mut bytes = Vec::new();
        for _ in 0..3 {
            serde_json::to_writer(&mut bytes, &json!({"payload":"x".repeat(1_500_000)})).unwrap();
            bytes.push(b'\n');
        }
        let closed = CancellationToken::new();
        let failure = receive(
            BufReader::new(bytes.as_slice()),
            sender,
            Controls::default(),
            permissions(),
            closed.clone(),
        )
        .await
        .unwrap_err();
        assert!(failure.to_string().contains("byte limit"));
        assert!(closed.is_cancelled());
        assert_eq!(receiver.len(), 2);
    }

    #[tokio::test]
    async fn small_frames_also_respect_the_input_count_limit() {
        let (sender, receiver) = channel();
        let bytes = b"{}\n".repeat(257);
        let closed = CancellationToken::new();
        let failure = receive(
            BufReader::new(bytes.as_slice()),
            sender,
            Controls::default(),
            permissions(),
            closed.clone(),
        )
        .await
        .unwrap_err();
        assert!(failure.to_string().contains("capacity exceeded"));
        assert_eq!(receiver.len(), 256);
        assert!(closed.is_cancelled());
    }
}
