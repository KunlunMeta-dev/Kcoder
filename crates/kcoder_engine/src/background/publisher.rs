use super::*;
use kcoder_state::AppState;
use kcoder_types::{BackgroundEventIdentity, BackgroundRunKey};

/// Each worker owns its immutable run identity, even after the public ID is reused.
#[derive(Clone)]
pub(super) struct ScopedPublisher {
    sender: broadcast::Sender<BackgroundJobEvent>,
    state: AppState,
    run: BackgroundRunKey,
    sequence: Arc<AtomicU64>,
    pending: Arc<Mutex<Option<BackgroundJobEvent>>>,
    retry_after: Arc<Mutex<Option<std::time::Instant>>>,
}

impl ScopedPublisher {
    pub(super) fn new(
        sender: broadcast::Sender<BackgroundJobEvent>,
        state: AppState,
        run: BackgroundRunKey,
    ) -> Self {
        Self {
            sender,
            state,
            run,
            sequence: Arc::new(AtomicU64::new(0)),
            pending: Arc::new(Mutex::new(None)),
            retry_after: Arc::new(Mutex::new(None)),
        }
    }
    pub(super) fn retry_pending(&self) {
        if self
            .retry_after
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_some_and(|deadline| deadline > std::time::Instant::now())
        {
            return;
        }
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(event) = pending {
            let _ = self.send(event);
        }
    }
    /// Display-only retirement after the task was explicitly removed by its owner.
    pub(super) fn send_retired(&self, event: BackgroundJobEvent) {
        let _ = self.sender.send(BackgroundJobEvent::Scoped {
            identity: BackgroundEventIdentity::terminal(self.run.clone()),
            event: Box::new(event),
        });
    }
    pub(super) fn send(&self, event: BackgroundJobEvent) -> anyhow::Result<()> {
        let terminal_status = match event.payload() {
            BackgroundJobEvent::Completed { .. } => Some(TaskStatus::Completed),
            BackgroundJobEvent::Failed { .. } => Some(TaskStatus::Failed),
            BackgroundJobEvent::Cancelled { .. } => Some(TaskStatus::Cancelled),
            BackgroundJobEvent::Halted { .. } => Some(TaskStatus::Halted),
            _ => None,
        };
        let identity = if let Some(status) = terminal_status {
            let identity = BackgroundEventIdentity::terminal(self.run.clone());
            let output_path = self
                .state
                .task_for_background_run(&self.run)
                .and_then(|task| task.output_path);
            if let Err(error) =
                self.state
                    .commit_background_terminal(&identity, status, output_path)
            {
                if self
                    .state
                    .background_run_record(&self.run)
                    .is_some_and(|record| record.terminal.is_some())
                {
                    tracing::warn!(run_id = %self.run.run_id, %error, "discarded conflicting terminal publication");
                    self.pending
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .take();
                    self.retry_after
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .take();
                    return Ok(());
                }
                let mut pending = self
                    .pending
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if pending.is_none() {
                    tracing::warn!(run_id = %self.run.run_id, %error, "terminal publication remains pending");
                }
                pending.get_or_insert(event);
                *self
                    .retry_after
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) =
                    Some(std::time::Instant::now() + std::time::Duration::from_secs(2));
                return Err(error);
            }
            self.pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            self.retry_after
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            identity
        } else {
            let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
            BackgroundEventIdentity {
                run: self.run.clone(),
                event_id: format!("{}:{sequence}", self.run.run_id),
                run_sequence: sequence,
            }
        };
        // No receiver is not a persistence failure: terminal recovery reads State.
        let _ = self.sender.send(BackgroundJobEvent::Scoped {
            identity,
            event: Box::new(event),
        });
        Ok(())
    }
}
