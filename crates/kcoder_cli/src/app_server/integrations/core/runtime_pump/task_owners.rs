//! Passive ownership uses the original connection queue and ThreadManager.
use super::*;
use crate::app_server::thread_runtime::{PreparedThreadOwner, TaskOwnerPresence};
use std::sync::atomic::{AtomicBool, Ordering};

pub(in crate::app_server) trait NativeTaskOwnerAuthority:
    Send + Sync
{
    fn verify(&self) -> Result<()>;
    fn thread_id(&self) -> &str;
    fn prepare(&self) -> Result<PreparedThreadOwner>;
    /// A signed background source may retain the existing resident's lifetime.
    /// Returning false never authorizes another source or acquires its lease.
    fn retain_resident_background(&self, _manager: &mut ThreadManager) -> Result<bool> {
        Ok(false)
    }
}
pub(in crate::app_server) struct TaskOwnerRequest {
    pub authority: Arc<dyn NativeTaskOwnerAuthority>,
    pub reply: oneshot::Sender<Result<TaskOwnerPresence>>,
    pub prepare: bool,
}
/// The original queue explicitly rejected preparation, or never accepted it.
/// A closed response or timeout cannot construct this determinate outcome.
#[derive(Debug)]
pub(in crate::app_server) struct NativeTaskOwnerRejection;
impl std::fmt::Display for NativeTaskOwnerRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TASK_OWNER_PREPARATION_REJECTED")
    }
}
impl std::error::Error for NativeTaskOwnerRejection {}
impl NativeRuntimeClient {
    pub(crate) fn task_owner_preparation_supported(&self) -> bool {
        self.task_owners.load(Ordering::Acquire)
    }
    pub(in crate::app_server) async fn read_task_owner(
        &self,
        authority: Arc<dyn NativeTaskOwnerAuthority>,
        timeout: Duration,
    ) -> Result<TaskOwnerPresence> {
        authority.verify()?;
        let (reply, response) = oneshot::channel();
        self.sender
            .try_send(Control::TaskOwner(Box::new(TaskOwnerRequest {
                authority,
                reply,
                prepare: false,
            })))
            .map_err(|_| anyhow::anyhow!("TASK_OWNER_QUEUE_UNAVAILABLE"))?;
        tokio::time::timeout(timeout.min(Duration::from_secs(60)), response)
            .await
            .map_err(|_| anyhow::anyhow!("TASK_OWNER_RESULT_UNCONFIRMED"))?
            .map_err(|_| anyhow::anyhow!("TASK_OWNER_RESULT_UNCONFIRMED"))?
    }
    pub(in crate::app_server) async fn prepare_task_owner(
        &self,
        authority: Arc<dyn NativeTaskOwnerAuthority>,
        timeout: Duration,
    ) -> Result<TaskOwnerPresence> {
        ensure!(
            self.task_owner_preparation_supported(),
            "TASK_OWNER_CONTROL_UNAVAILABLE"
        );
        ensure!(
            timeout <= Duration::from_secs(60),
            "TASK_OWNER_TIMEOUT_INVALID"
        );
        authority
            .verify()
            .map_err(|error| error.context(NativeTaskOwnerRejection))?;
        let (reply, response) = oneshot::channel();
        self.sender
            .try_send(Control::TaskOwner(Box::new(TaskOwnerRequest {
                authority,
                reply,
                prepare: true,
            })))
            .map_err(|_| anyhow::Error::new(NativeTaskOwnerRejection))?;
        tokio::time::timeout(timeout, response)
            .await
            .map_err(|_| anyhow::anyhow!("TASK_OWNER_RESULT_UNCONFIRMED"))?
            .map_err(|_| anyhow::anyhow!("TASK_OWNER_RESULT_UNCONFIRMED"))?
            .map_err(|error| error.context(NativeTaskOwnerRejection))
    }
}
impl NativeRuntimePump {
    pub(crate) fn enable_task_owners(&mut self) {
        self.task_owners.store(true, Ordering::Release);
    }
    pub(crate) async fn observe_with_task_owners(
        &mut self,
        event: RuntimePumpEvent,
        outbound: &mpsc::Sender<Value>,
        manager: &mut ThreadManager,
    ) -> Result<()> {
        if let RuntimePumpEvent::Control(Control::RpcConnection(request)) = event {
            if self.rpc_requests.len() < CAPACITY {
                // Resources move exclusively to the dispatcher. Queue residence
                // must not require SQLite's connection-local caches to be Sync.
                self.rpc_requests.push_back(std::sync::Mutex::new(request));
            } else {
                crate::app_server::rpc_connection::unavailable(*request);
            }
            return Ok(());
        }
        if Instant::now() >= self.task_owner_validation_at {
            manager.prune_prepared_owners();
            self.task_owner_validation_at = Instant::now() + Duration::from_secs(1);
        }
        if let RuntimePumpEvent::Control(Control::UiTaskTurn(request)) = event {
            if self.ui_task_turns.len() < CAPACITY {
                self.ui_task_turns.push_back(request);
            } else {
                super::ui_task_turn::unavailable(*request);
            }
            return Ok(());
        }
        if let RuntimePumpEvent::Control(Control::UiTaskStart(request)) = event {
            if self.ui_task_starts.len() < CAPACITY {
                self.ui_task_starts.push_back(request);
            } else {
                super::ui_task_start::unavailable(*request);
            }
            return Ok(());
        }
        if let RuntimePumpEvent::Control(Control::UiTaskResume(request)) = event {
            if self.ui_task_resumes.len() < CAPACITY {
                self.ui_task_resumes.push_back(request);
            } else {
                super::ui_task_resume::unavailable(*request);
            }
            return Ok(());
        }
        if let RuntimePumpEvent::Control(Control::UiTaskRead(request)) = event {
            if self.ui_task_reads.len() < CAPACITY {
                self.ui_task_reads.push_back(request);
            } else {
                super::ui_task_read::unavailable(*request);
            }
            return Ok(());
        }
        if let RuntimePumpEvent::Control(Control::TaskOwner(request)) = event {
            manager.prune_prepared_owners();
            let result = (|| {
                request.authority.verify()?;
                if request.prepare && manager.owns(request.authority.thread_id()) {
                    request.authority.retain_resident_background(manager)?;
                }
                if request.prepare
                    && matches!(
                        manager.task_owner_presence(request.authority.thread_id()),
                        TaskOwnerPresence::Unowned
                    )
                {
                    let owner = request.authority.prepare()?;
                    request.authority.verify()?;
                    manager.retain_prepared_owner(owner)?;
                }
                request.authority.verify()?;
                Ok(manager.task_owner_presence(request.authority.thread_id()))
            })();
            // Invalidation can race the retain step. Never strand that lease
            // merely because the final authority check rejected this request.
            manager.prune_prepared_owners();
            let _ = request.reply.send(result);
            return Ok(());
        }
        self.observe(event, outbound, manager).await
    }
}
pub(super) fn unavailable(request: TaskOwnerRequest) {
    let _ = request
        .reply
        .send(Err(anyhow::anyhow!("TASK_OWNER_CONTROL_UNAVAILABLE")));
}
pub(super) fn availability() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct RejectedSource;
    impl NativeTaskOwnerAuthority for RejectedSource {
        fn verify(&self) -> Result<()> {
            Ok(())
        }
        fn thread_id(&self) -> &str {
            "controlled-source-task"
        }
        fn prepare(&self) -> Result<PreparedThreadOwner> {
            anyhow::bail!("controlled preparation rejection")
        }
    }

    #[tokio::test]
    async fn original_queue_rejection_is_determinate_and_creates_no_owner() -> Result<()> {
        let (mut pump, client) = NativeRuntimePump::new();
        pump.enable_task_owners();
        let work = tokio::spawn(async move {
            client
                .prepare_task_owner(Arc::new(RejectedSource), Duration::from_secs(1))
                .await
        });
        let mut manager = ThreadManager::default();
        let (outbound, _frames) = mpsc::channel(8);
        // The first interval tick may precede the actual queued request.
        while !work.is_finished() {
            let event = pump.receive().await;
            pump.observe_with_task_owners(event, &outbound, &mut manager)
                .await?;
        }
        let error = work.await?.err().context("REJECTION_REQUIRED")?;
        assert!(error.is::<NativeTaskOwnerRejection>());
        assert!(manager.is_empty());
        pump.close().await;
        Ok(())
    }

    #[tokio::test]
    async fn accepted_queue_without_a_response_keeps_the_result_unconfirmed() -> Result<()> {
        let (mut pump, client) = NativeRuntimePump::new();
        pump.enable_task_owners();
        let work = tokio::spawn(async move {
            client
                .prepare_task_owner(Arc::new(RejectedSource), Duration::from_millis(20))
                .await
        });
        let queued = loop {
            let event = pump.receive().await;
            if matches!(&event, RuntimePumpEvent::Control(Control::TaskOwner(_))) {
                break event;
            }
        };
        // The actual queue accepted this command. A caller timeout cannot prove
        // whether it was observed, so it must never turn into a known rejection.
        let error = work.await?.err().context("UNKNOWN_RESULT_REQUIRED")?;
        assert!(!error.is::<NativeTaskOwnerRejection>());
        assert_eq!(error.to_string(), "TASK_OWNER_RESULT_UNCONFIRMED");
        drop(queued);
        pump.close().await;
        Ok(())
    }
}
