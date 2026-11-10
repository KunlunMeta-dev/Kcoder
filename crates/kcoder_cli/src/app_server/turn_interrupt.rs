//! Owned turn interruption leaves Native private-response routing live.
use super::*;
use crate::app_server::task_spawn::JoinSetExt as _;
#[cfg(target_os = "linux")]
use std::collections::BTreeSet;

pub(super) struct Interruption {
    pub(super) active: ActiveTurn,
    pub(super) turn_state: ResidentTurnState,
    pub(super) projection: Arc<Mutex<BackgroundProjectionState>>,
    pub(super) followups: Arc<BackgroundFollowupState>,
    pub(super) engine: Option<QueryEngine>,
    pub(super) outbound: mpsc::Sender<Value>,
    pub(super) server_id: String,
    pub(super) sequence: Arc<AtomicU64>,
}

pub(super) struct SettledInterruption {
    outbound: mpsc::Sender<Value>,
    notification: Option<Value>,
}

impl SettledInterruption {
    pub(super) async fn publish(self) -> Result<()> {
        if let Some(notification) = self.notification {
            send(&self.outbound, notification).await?;
        }
        Ok(())
    }
}

/// Suspend the matching goal and signal its original turn before waiting for
/// any outbound notification or response. The gate also fences registration
/// of a new turn while the goal scheduler is being suspended.
pub(super) async fn pause_goal_and_cancel(
    turn_state: &ResidentTurnState,
    followups: Option<&BackgroundFollowupState>,
    engine: Option<&QueryEngine>,
    cancel: &CancellationToken,
) -> bool {
    let _gate = turn_state.activity_gate.lock().await;
    if let Some(followups) = followups {
        followups.goals.lock().unwrap().suspend();
    }
    cancel.cancel();
    if let Some(engine) = engine
        && engine
            .state
            .goal()
            .is_some_and(|goal| goal.status.is_active())
    {
        engine.state.update_goal_status(GoalStatus::Paused);
        return true;
    }
    false
}

impl Interruption {
    /// Settle the original handle independently of outbound backpressure. The
    /// caller publishes a forced-completion notice after its response is queued.
    pub(super) async fn settle(self) -> SettledInterruption {
        let thread_id = self.active.thread_id.clone();
        let turn_id = self.active.turn_id.clone();
        let forced = cancel_active_turn_bounded(
            self.active,
            &self.turn_state,
            &self.projection,
            &self.followups,
        )
        .await;
        let notification = if forced {
            let reason = "cancelled by user (forced shutdown)";
            if let Some(engine) = &self.engine
                && let Err(error) = save_turn_outcome(
                    engine,
                    &thread_id,
                    &turn_id,
                    "interrupted",
                    Some(reason),
                    None,
                )
            {
                tracing::warn!(%error, "failed to persist forced turn interruption");
            }
            Some(notification(
                "turn/completed",
                with_event_context(
                    &self.server_id,
                    &thread_id,
                    Some(&turn_id),
                    &self.sequence,
                    json!({"turn":{"id":turn_id,"threadId":thread_id,"status":"interrupted"},"error":{"message":reason}}),
                ),
            ))
        } else {
            None
        };
        SettledInterruption {
            outbound: self.outbound,
            notification,
        }
    }
}

#[cfg(target_os = "linux")]
#[derive(Default)]
pub(super) struct NativeInterruptJobs {
    jobs: tokio::task::JoinSet<()>,
    pending: Arc<StdMutex<BTreeSet<(String, String)>>>,
}
#[cfg(target_os = "linux")]
impl std::fmt::Debug for NativeInterruptJobs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeInterruptJobs { original_owned_turns }")
    }
}
#[cfg(target_os = "linux")]
struct PendingInterrupt {
    pending: Arc<StdMutex<BTreeSet<(String, String)>>>,
    identity: (String, String),
    abort: tokio::task::AbortHandle,
}
#[cfg(target_os = "linux")]
impl Drop for PendingInterrupt {
    fn drop(&mut self) {
        self.abort.abort();
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.identity);
    }
}
#[cfg(target_os = "linux")]
impl NativeInterruptJobs {
    pub(super) fn is_pending(&self, thread: Option<&str>, turn: Option<&str>) -> bool {
        match (thread, turn) {
            (Some(thread), Some(turn)) => self
                .pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .contains(&(thread.into(), turn.into())),
            _ => false,
        }
    }
    #[cfg(test)]
    pub(super) fn spawn(&mut self, interruption: Interruption) -> Result<()> {
        self.spawn_inner(interruption, None)
    }

    pub(super) fn spawn_after_response(
        &mut self,
        interruption: Interruption,
        response_enqueued: tokio::sync::oneshot::Receiver<()>,
    ) -> Result<()> {
        self.spawn_inner(interruption, Some(response_enqueued))
    }

    fn spawn_inner(
        &mut self,
        interruption: Interruption,
        response_enqueued: Option<tokio::sync::oneshot::Receiver<()>>,
    ) -> Result<()> {
        let identity = (
            interruption.active.thread_id.clone(),
            interruption.active.turn_id.clone(),
        );
        ensure!(
            self.pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(identity.clone()),
            "NATIVE_ORIGINAL_INTERRUPT_PENDING"
        );
        let guard = PendingInterrupt {
            pending: self.pending.clone(),
            identity,
            abort: interruption.active.handle.abort_handle(),
        };
        self.jobs.spawn_shared(async move {
            let _owned = guard;
            let settled = interruption.settle().await;
            if let Some(response_enqueued) = response_enqueued {
                let _ = response_enqueued.await;
            }
            if settled.publish().await.is_err() {
                tracing::warn!(
                    code = "NATIVE_INTERRUPT_DELIVERY_UNKNOWN",
                    "Original Native interruption receipt was not delivered"
                );
            }
        });
        Ok(())
    }
    pub(super) fn reap(&mut self) {
        while let Some(result) = self.jobs.try_join_next() {
            if result.is_err() {
                tracing::warn!(
                    code = "NATIVE_INTERRUPT_JOB_UNKNOWN",
                    "Owned Native interruption did not settle"
                );
            }
        }
    }
    /// Receiver authority is revoked first, releasing synchronous private
    /// reply waiters. Await every original handle before its runtime is drained.
    pub(super) async fn drain(&mut self) {
        while let Some(result) = self.jobs.join_next().await {
            if result.is_err() {
                tracing::warn!(
                    code = "NATIVE_INTERRUPT_JOB_UNKNOWN",
                    "Owned Native interruption did not settle"
                );
            }
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn native_interrupt_job_keeps_original_busy_while_the_loop_routes_its_pending_reply() {
        let (outbound, _receiver) = mpsc::channel(8);
        let turn_state = ResidentTurnState::new(
            outbound.clone(),
            kcoder_config::PermissionMode::Ask,
            Arc::new(AtomicU64::new(1)),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );
        turn_state.running.store(true, Ordering::SeqCst);
        let cancel = CancellationToken::new();
        let (reply, waiting) = tokio::sync::oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            waiting.await.unwrap();
        });
        let interruption = Interruption {
            active: ActiveTurn {
                desktop_owner: None,
                input_owner: None,
                handle,
                cancel: cancel.clone(),
                thread_id: "original-thread".into(),
                turn_id: "original-turn".into(),
                attempt: None,
                origin: request_origin::RequestOrigin::Unverified,
            },
            turn_state: turn_state.clone(),
            projection: Arc::new(Mutex::new(BackgroundProjectionState::default())),
            followups: Arc::new(BackgroundFollowupState::default()),
            engine: None,
            outbound,
            server_id: "owned-server".into(),
            sequence: Arc::new(AtomicU64::new(1)),
        };
        let mut jobs = NativeInterruptJobs::default();
        jobs.spawn(interruption).unwrap();
        tokio::task::yield_now().await;
        assert!(cancel.is_cancelled());
        assert!(turn_state.running.load(Ordering::SeqCst));
        assert!(
            !turn_state.try_claim_turn(),
            "A cancelled handle still waiting for its original reply remains busy"
        );
        assert!(jobs.is_pending(Some("original-thread"), Some("original-turn")));
        assert!(!jobs.is_pending(Some("another-thread"), Some("original-turn")));
        // This models the next frame in the same connection dispatcher. Awaiting
        // interruption inline would prevent the reply from ever being delivered.
        reply.send(()).unwrap();
        jobs.drain().await;
        assert!(!turn_state.running.load(Ordering::SeqCst));
        assert!(!jobs.is_pending(Some("original-thread"), Some("original-turn")));
    }

    #[tokio::test]
    async fn native_interrupt_settles_before_response_and_publishes_terminal_after_it() {
        let (outbound, mut receiver) = mpsc::channel(2);
        let turn_state = ResidentTurnState::new(
            outbound.clone(),
            kcoder_config::PermissionMode::Ask,
            Arc::new(AtomicU64::new(1)),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );
        turn_state.running.store(true, Ordering::SeqCst);
        let handle = tokio::spawn(std::future::pending::<()>());
        handle.abort();
        let interruption = Interruption {
            active: ActiveTurn {
                desktop_owner: None,
                input_owner: None,
                handle,
                cancel: CancellationToken::new(),
                thread_id: "original-thread".into(),
                turn_id: "original-turn".into(),
                attempt: None,
                origin: request_origin::RequestOrigin::Unverified,
            },
            turn_state: turn_state.clone(),
            projection: Arc::new(Mutex::new(BackgroundProjectionState::default())),
            followups: Arc::new(BackgroundFollowupState::default()),
            engine: None,
            outbound: outbound.clone(),
            server_id: "owned-server".into(),
            sequence: Arc::new(AtomicU64::new(1)),
        };
        let (response_enqueued, after_response) = oneshot::channel();
        let mut jobs = NativeInterruptJobs::default();
        jobs.spawn_after_response(interruption, after_response)
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while turn_state.running.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("turn did not settle while its response was pending");
        assert!(jobs.is_pending(Some("original-thread"), Some("original-turn")));
        assert!(receiver.try_recv().is_err());
        outbound.try_send(json!({"response": true})).unwrap();
        response_enqueued.send(()).unwrap();
        jobs.drain().await;
        assert_eq!(receiver.recv().await.unwrap()["response"], true);
        assert_eq!(receiver.recv().await.unwrap()["method"], "turn/completed");
        assert!(!jobs.is_pending(Some("original-thread"), Some("original-turn")));
    }
}
