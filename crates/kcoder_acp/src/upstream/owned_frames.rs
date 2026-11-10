//! Keep the ordinary pending calls/events over a Native-owned frame lane.
use super::*;
use crate::outbound::OwnedNativeFrameTransport;

impl Upstream {
    pub(crate) fn from_owned_native_frames(
        transport: Arc<dyn OwnedNativeFrameTransport>,
    ) -> Result<Self> {
        transport.verify_owner()?;
        let endpoint = transport.endpoint_instance_id().to_owned();
        let (sender, mut outgoing) = crate::queue::wire_queue();
        let (event_sender, events) = crate::queue::wire_queue();
        let pending: Pending = Arc::default();
        let waiting = pending.clone();
        let closed = CancellationToken::new();
        let shutdown = closed.clone();
        let lifecycle = crate::diagnostics::Lifecycle::default();
        let cleanup_confirmed = Arc::new(AtomicBool::new(false));
        let cleanup = cleanup_confirmed.clone();
        let worker_endpoint = endpoint.clone();
        let worker_sender = sender.clone();
        let worker = tokio::spawn(async move {
            let verify = || -> Result<()> {
                transport.verify_owner()?;
                ensure!(
                    transport.endpoint_instance_id() == worker_endpoint,
                    "Owned Native endpoint changed"
                );
                Ok(())
            };
            let reader = async {
                loop {
                    verify()?;
                    let Some(value) = transport.receive().await? else {
                        return Ok::<(), anyhow::Error>(());
                    };
                    verify()?;
                    ensure!(
                        serde_json::to_vec(&value)?.len() <= crate::framing::MAX_FRAME_BYTES
                            && value.is_object()
                            && value["jsonrpc"] == "2.0",
                        "Invalid owned Native ACP frame"
                    );
                    if value.get("method").is_none() {
                        if let Some(id) = value["id"].as_u64()
                            && let Some(reply) = waiting
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .remove(&id)
                        {
                            let _ = reply.send(value);
                        }
                    } else {
                        event_sender.send(value).await?;
                    }
                }
            };
            let writer = async {
                while let Some(frame) = outgoing.recv().await {
                    verify()?;
                    let value: Value = serde_json::from_slice(&frame.bytes)?;
                    transport.send(value).await?;
                    verify()?;
                }
                Ok::<(), anyhow::Error>(())
            };
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => {},
                _ = reader => {},
                _ = writer => {},
            }
            shutdown.cancel();
            worker_sender.close();
            waiting.lock().unwrap_or_else(|p| p.into_inner()).clear();
            transport.begin_close();
            // Retained cleanup is independently bounded and never retries an
            // ACP prompt, model call or external effect after loss of authority.
            if matches!(
                tokio::time::timeout(Duration::from_secs(5), transport.close()).await,
                Ok(Ok(true))
            ) {
                cleanup.store(true, Ordering::SeqCst);
            }
        });
        Ok(Self {
            sender,
            pending,
            next_id: Arc::new(AtomicU64::new(1)),
            owned_pid: 0,
            native_endpoint: Some(endpoint),
            cleanup_confirmed,
            owned_exit: Arc::new(AtomicBool::new(false)),
            #[cfg(target_os = "linux")]
            owner_control: None,
            closed,
            worker: Some(worker),
            lifecycle,
            events,
        })
    }
}
