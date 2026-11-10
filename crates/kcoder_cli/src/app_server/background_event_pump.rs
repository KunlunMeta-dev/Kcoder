//! Connection-owned lifetime for the background event pump.

use super::*;

impl BackgroundEventPump {
    pub(super) fn spawn(
        engine: &QueryEngine,
        state: Arc<Mutex<BackgroundProjectionState>>,
        followups: Arc<BackgroundFollowupState>,
        outbound_tx: mpsc::Sender<Value>,
    ) -> Self {
        let cancel = CancellationToken::new();
        let receiver = engine.subscribe_background_jobs();
        let pump = run_background_event_pump(
            engine.clone(),
            receiver,
            state,
            Arc::clone(&followups.delivery),
            outbound_tx,
            cancel.clone(),
            continuous_work_admission::record_terminal_background_result,
        );
        let handle = crate::app_server::task_spawn::spawn(async move {
            pump.await;
            // Keep the connection's full follow-up state alive until the pump exits.
            drop(followups);
        });
        Self { cancel, handle }
    }

    pub(super) async fn stop(mut self) {
        self.cancel.cancel();
        if tokio::time::timeout(BACKGROUND_PUMP_SHUTDOWN_TIMEOUT, &mut self.handle)
            .await
            .is_err()
        {
            self.handle.abort();
            let _ = self.handle.await;
        }
    }
}

pub(super) async fn project_managed_background_event(
    engine: &QueryEngine,
    state: &Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: &mpsc::Sender<Value>,
    event: EngineEvent,
) -> Result<()> {
    background_delivery::project_managed_background_event(
        engine,
        state,
        outbound_tx,
        event,
        continuous_work_admission::record_terminal_background_result,
    )
    .await
}
