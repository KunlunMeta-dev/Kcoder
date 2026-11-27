//! Passive ownership uses the original connection queue and ThreadManager.
use super::*;

impl NativeRuntimePump {
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
            manager.prune_revoked_background_lifetimes();
            self.task_owner_validation_at = Instant::now() + Duration::from_secs(1);
        }
        self.observe(event, outbound, manager).await
    }
}
