//! Connect desktop recovery to the owning resident turn and connection.
use super::*;
#[cfg(test)]
use kcoder_app_protocol::ComputerUseCleanupState as Cleanup;
use kcoder_app_protocol::{
    ComputerUseRecoverParams, ComputerUseRecoverResult, ComputerUseRevokeParams,
};
use kcoder_desktop_recovery::RecoveryPreparation;
#[cfg(test)]
use kcoder_desktop_recovery::SharedGrant;
pub(super) use kcoder_desktop_recovery::{DesktopGrantState, RecoveryTicket};
#[cfg(any(windows, test))]
use kcoder_types::computer_use::DesktopOwner;

#[cfg(windows)]
pub(super) async fn publish_startup_failure(
    grant: &kcoder_desktop_recovery::SharedGrant,
    owner: &DesktopOwner,
    sequence: &Arc<AtomicU64>,
    tx: &mpsc::Sender<Value>,
) {
    let payload = kcoder_desktop_recovery::startup_failure(grant);
    if let Ok(payload) = serde_json::to_value(payload) {
        let _ = send(
            tx,
            notification(
                method::COMPUTER_USE_STATE_CHANGED,
                with_event_context(
                    &owner.client_instance,
                    &owner.thread_id,
                    Some(&owner.turn_id),
                    sequence,
                    payload,
                ),
            ),
        )
        .await;
    }
}

fn claim_recovery(
    thread_manager: &ThreadManager,
    params: &ComputerUseRecoverParams,
    owner: &str,
) -> Result<RecoveryPreparation> {
    anyhow::ensure!(cfg!(windows), "Computer Use recovery requires Windows");
    anyhow::ensure!(
        thread_manager.owns(&params.thread_id),
        "Desktop recovery thread does not belong to this connection"
    );
    let state = thread_manager
        .turn_state(&params.thread_id)
        .context("Desktop recovery runtime is unavailable")?;
    kcoder_desktop_recovery::claim_recovery(&state.desktop_grant, params, owner)
}

pub(super) struct ReadyRecovery {
    pub(super) id: Value,
    pub(super) params: ComputerUseRecoverParams,
    pub(super) ticket: RecoveryTicket,
}

impl std::fmt::Debug for ReadyRecovery {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ReadyRecovery")
            .field("id", &self.id)
            .field("params", &self.params)
            .finish_non_exhaustive()
    }
}

pub(super) fn launch(
    thread_manager: &ThreadManager,
    params: ComputerUseRecoverParams,
    owner: &str,
    id: Value,
    outbound: mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<Option<ComputerUseRecoverResult>> {
    anyhow::ensure!(
        state.desktop_recovery_tasks.len() + state.desktop_recovery_ready.len() < 4,
        "Desktop recovery capacity reached"
    );
    match claim_recovery(thread_manager, &params, owner)? {
        RecoveryPreparation::Existing(receipt) => Ok(Some(receipt)),
        RecoveryPreparation::New(ticket) => {
            let turn_state = thread_manager
                .turn_state(&params.thread_id)
                .context("Desktop runtime disappeared")?;
            state.desktop_recovery_tasks.spawn(async move {
                match wait_for_cleanup(turn_state, ticket).await {
                    Ok(ticket) => Some(ReadyRecovery { id, params, ticket }),
                    Err(error) => {
                        let _ =
                            send(&outbound, error_response(id, -32076, &error.to_string())).await;
                        None
                    }
                }
            });
            Ok(None)
        }
    }
}

async fn wait_for_cleanup(
    state: ResidentTurnState,
    ticket: RecoveryTicket,
) -> Result<RecoveryTicket> {
    let previous_turn_id = ticket.previous_turn_id().to_owned();
    // Cancel through the existing foreground ownership. Do not remove its handle.
    // Revoke invalidates the grant using its independent short-held state lock.
    {
        let active = state.active_turn.lock().await;
        if let Some(active) = active
            .as_ref()
            .filter(|active| active.turn_id == previous_turn_id)
        {
            active.cancel.cancel();
        }
    }
    #[cfg(windows)]
    ticket.stop_previous_host().await?;
    // Poll the existing task handle without retaining its ownership lock.
    // The main request loop remains able to process interrupt and revoke.
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut interval = tokio::time::interval(Duration::from_millis(50));
        loop {
            interval.tick().await;
            ticket.validate_current()?;
            let active = state.active_turn.lock().await;
            if active
                .as_ref()
                .filter(|active| active.turn_id == previous_turn_id)
                .is_none_or(|active| active.handle.is_finished())
            {
                break Ok::<_, anyhow::Error>(());
            }
        }
    })
    .await
    .context("Old desktop turn has not finished cleanup")??;
    ticket.validate_cleanup_confirmed()?;
    Ok(ticket)
}

pub(super) async fn revoke(
    thread_manager: &ThreadManager,
    params: ComputerUseRevokeParams,
    owner: &str,
) -> Result<Value> {
    anyhow::ensure!(
        thread_manager.owns(&params.thread_id),
        "Desktop revoke thread does not belong to this connection"
    );
    let state = thread_manager
        .turn_state(&params.thread_id)
        .context("Desktop runtime is unavailable")?;
    let session = {
        let mut grant = state
            .desktop_grant
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        grant.revoke_for_owner(owner)?
    };
    // Revoke authority before cancelling its accepted desktop intent, including
    // startup. A plain turn is unrelated to this desktop permission cleanup.
    if let Ok(active) = state.active_turn.try_lock()
        && let Some(active) = active.as_ref()
        && active.desktop_owner.as_ref().is_some_and(|desktop| {
            desktop.client_instance == owner
                && desktop.thread_id == params.thread_id
                && active.matches(Some(&desktop.thread_id), Some(&desktop.turn_id))
        })
    {
        active.cancel.cancel();
    }
    if let Some(session) = session {
        tokio::spawn(async move {
            let _ = session.stop().await;
        });
    }
    Ok(json!({"revoked":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owner(turn: &str) -> DesktopOwner {
        DesktopOwner {
            client_instance: "client".into(),
            thread_id: "thread".into(),
            turn_id: turn.into(),
        }
    }
    fn authorized() -> SharedGrant {
        let grant = Arc::new(StdMutex::new(DesktopGrantState::default()));
        let generation = grant
            .lock()
            .unwrap()
            .begin_turn(&owner("old"), None)
            .unwrap();
        assert_eq!(generation, 1);
        grant
    }
    fn claim(grant: &SharedGrant) -> Result<RecoveryPreparation> {
        kcoder_desktop_recovery::claim_recovery(
            grant,
            &ComputerUseRecoverParams {
                thread_id: "thread".into(),
                previous_turn_id: "old".into(),
            },
            "client",
        )
    }
    fn ticket(grant: &SharedGrant) -> RecoveryTicket {
        let RecoveryPreparation::New(ticket) = claim(grant).unwrap() else {
            panic!("expected a new recovery claim")
        };
        ticket
    }
    fn runtime_state(grant: SharedGrant) -> ResidentTurnState {
        let (tx, _) = mpsc::channel(8);
        let mut state = ResidentTurnState::new(
            tx,
            kcoder_config::PermissionMode::Bypass,
            Arc::new(AtomicU64::new(1)),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );
        state.desktop_grant = grant;
        state
    }
    #[tokio::test]
    async fn desktop_revoke_only_cancels_its_own_desktop_turn() -> Result<()> {
        for (desktop_turn, active_turn, desktop_client, caller, expected_cancel, expected_error) in [
            (None, "ordinary", None, "client", false, false),
            (
                Some("desktop-old"),
                "ordinary",
                None,
                "client",
                false,
                false,
            ),
            (
                Some("desktop-live"),
                "desktop-live",
                Some("client"),
                "client",
                true,
                false,
            ),
            (
                None,
                "desktop-pending",
                Some("client"),
                "client",
                true,
                false,
            ),
            (
                Some("desktop-live"),
                "desktop-live",
                Some("client"),
                "foreign",
                false,
                true,
            ),
            (
                None,
                "desktop-pending",
                Some("client"),
                "foreign",
                false,
                false,
            ),
        ] {
            let root = tempfile::tempdir()?;
            let runtime = thread_runtime::test_support::test_runtime(
                "desktop-revocation",
                &root.path().join("history.jsonl"),
            );
            let thread = runtime.engine().session_id();
            let mut manager = ThreadManager::default();
            assert!(manager.insert(runtime).is_ok());
            let state = manager.turn_state(&thread).unwrap();
            if let Some(turn) = desktop_turn {
                let mut grant = state.desktop_grant.lock().unwrap();
                grant.begin_turn(
                    &DesktopOwner {
                        client_instance: "client".into(),
                        thread_id: thread.clone(),
                        turn_id: turn.into(),
                    },
                    None,
                )?;
                if turn != active_turn {
                    grant.confirm_cleanup(turn, Cleanup::Confirmed, true);
                }
            }
            let cancel = CancellationToken::new();
            let waiting = cancel.clone();
            *state.active_turn.lock().await = Some(ActiveTurn {
                desktop_owner: desktop_client.map(|client| DesktopOwner {
                    client_instance: client.into(),
                    thread_id: thread.clone(),
                    turn_id: active_turn.into(),
                }),
                input_owner: None,
                handle: tokio::spawn(async move { waiting.cancelled().await }),
                cancel: cancel.clone(),
                thread_id: thread.clone(),
                turn_id: active_turn.into(),
                attempt: None,
                origin: request_origin::RequestOrigin::ClientFrame,
            });
            let result = revoke(
                &manager,
                ComputerUseRevokeParams { thread_id: thread },
                caller,
            )
            .await;
            assert_eq!(result.is_err(), expected_error);
            assert_eq!(
                cancel.is_cancelled(),
                expected_cancel,
                "desktop={desktop_turn:?}, active={active_turn}"
            );
            cancel.cancel();
            state
                .active_turn
                .lock()
                .await
                .take()
                .unwrap()
                .handle
                .await?;
            for runtime in manager.drain() {
                runtime.shutdown().await;
            }
        }
        Ok(())
    }
    #[tokio::test]
    async fn recovery_wait_leaves_revoke_and_interrupt_accessible() {
        let grant = authorized();
        let ticket = ticket(&grant);
        let state = runtime_state(grant.clone());
        let cancellation = CancellationToken::new();
        let cleanup_started = Arc::new(tokio::sync::Notify::new());
        let finish = Arc::new(tokio::sync::Notify::new());
        let handle = tokio::spawn({
            let cancel = cancellation.clone();
            let started = cleanup_started.clone();
            let finish = finish.clone();
            let grant = grant.clone();
            async move {
                cancel.cancelled().await;
                started.notify_one();
                finish.notified().await;
                grant
                    .lock()
                    .unwrap()
                    .confirm_cleanup("old", Cleanup::Confirmed, true);
            }
        });
        *state.active_turn.lock().await = Some(ActiveTurn {
            desktop_owner: None,
            input_owner: None,
            handle,
            cancel: cancellation,
            thread_id: "thread".into(),
            turn_id: "old".into(),
            attempt: None,
            origin: request_origin::RequestOrigin::DesktopRecovery,
        });
        let waiting = tokio::spawn(wait_for_cleanup(state.clone(), ticket));
        cleanup_started.notified().await;
        assert!(state.active_turn.try_lock().is_ok());
        grant.lock().unwrap().revoke();
        let result = tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_err());
        assert!(claim(&grant).is_err());
        finish.notify_one();
        let active = state.active_turn.lock().await.take().unwrap();
        active.handle.await.unwrap();
    }
    #[tokio::test]
    async fn terminal_task_without_cleanup_receipt_cannot_replace_lease() {
        let grant = authorized();
        let ticket = ticket(&grant);
        grant
            .lock()
            .unwrap()
            .confirm_cleanup("old", Cleanup::Failed, true);
        let state = runtime_state(grant.clone());
        let result = wait_for_cleanup(state, ticket).await;
        assert!(result.is_err());
        assert!(matches!(
            claim(&grant).unwrap(),
            RecoveryPreparation::New(_)
        ));
        assert!(
            grant
                .lock()
                .unwrap()
                .begin_turn(&owner("new"), None)
                .is_err()
        );
    }
}
