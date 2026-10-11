//! Recovery reuses the resident turn's authorization and owned cleanup path.
//! A recovery ticket is never a new grant and cannot contain model input.
use super::*;
#[cfg(any(windows, test))]
use kcoder_app_protocol::{
    ComputerUseAuthorizationState as Authorization, ComputerUseChannelState as Channel,
    ComputerUseDiagnostic,
};
use kcoder_app_protocol::{
    ComputerUseCleanupState as Cleanup, ComputerUseRecoverParams, ComputerUseRecoverResult,
    ComputerUseRevokeParams,
};
use kcoder_computer_use::session::DesktopSession;
#[cfg(any(windows, test))]
use kcoder_types::computer_use::DesktopOwner;
use kcoder_types::computer_use::DesktopSessionState;

type SharedGrant = Arc<StdMutex<DesktopGrantState>>;
#[derive(Default)]
pub(super) struct DesktopGrantState {
    owner: Option<String>,
    thread_id: Option<String>,
    generation: u64,
    valid: bool,
    conversation_authorization: bool,
    #[cfg(any(windows, test))]
    policy_generation: Option<u64>,
    current: Option<DesktopReceipt>,
    recovery: Option<(u64, String)>,
}
struct DesktopReceipt {
    turn_id: String,
    recovered_from: Option<String>,
    cleanup: Cleanup,
    terminal: bool,
    session: Option<Arc<DesktopSession>>,
    #[cfg(windows)]
    host: Option<Arc<kcoder_mcp::desktop_host::LocalDesktopHost>>,
}
pub(super) struct RecoveryTicket {
    grant: SharedGrant,
    generation: u64,
    previous_turn_id: String,
    owner: String,
    thread_id: String,
}
impl RecoveryTicket {
    pub(super) fn previous_turn_id(&self) -> &str {
        &self.previous_turn_id
    }
    pub(super) fn validate_ready(&self) -> Result<()> {
        let grant = self.grant.lock().unwrap_or_else(|error| error.into_inner());
        grant.validate_ticket(self)?;
        anyhow::ensure!(
            grant
                .current
                .as_ref()
                .is_some_and(|receipt| receipt.cleanup == Cleanup::Confirmed && receipt.terminal),
            "Old desktop cleanup receipt is not confirmed"
        );
        Ok(())
    }
}
impl Drop for RecoveryTicket {
    fn drop(&mut self) {
        let mut grant = self.grant.lock().unwrap_or_else(|error| error.into_inner());
        if grant.recovery.as_ref() == Some(&(self.generation, self.previous_turn_id.clone())) {
            grant.recovery = None;
        }
    }
}
pub(super) enum RecoveryPreparation {
    Existing(ComputerUseRecoverResult),
    New(RecoveryTicket),
}
impl DesktopGrantState {
    pub(super) fn revoke(&mut self) {
        self.valid = false;
        self.generation = self.generation.saturating_add(1);
        self.recovery = None;
    }
    #[cfg(any(windows, test))]
    pub(super) fn capture_policy_generation(&mut self, generation: u64) {
        self.policy_generation = Some(generation);
    }
    #[cfg(any(windows, test))]
    pub(super) fn check_policy_generation(&mut self, generation: u64) -> Result<()> {
        if self.policy_generation != Some(generation) {
            self.revoke();
            anyhow::bail!("Desktop plugin policy changed; a fresh explicit approval is required");
        }
        Ok(())
    }
    #[cfg(any(windows, test))]
    pub(super) fn valid_for(&self, owner: &DesktopOwner, generation: u64) -> bool {
        self.valid
            && self.generation == generation
            && self.owner.as_deref() == Some(&owner.client_instance)
            && self.thread_id.as_deref() == Some(&owner.thread_id)
            && self
                .current
                .as_ref()
                .is_some_and(|receipt| receipt.turn_id == owner.turn_id)
    }
    #[cfg(test)]
    pub(super) fn begin_turn(
        &mut self,
        owner: &DesktopOwner,
        ticket: Option<&RecoveryTicket>,
    ) -> Result<u64> {
        self.begin_turn_with_session(owner, ticket, false, true)
    }
    #[cfg(any(windows, test))]
    pub(super) fn begin_turn_with_session(
        &mut self,
        owner: &DesktopOwner,
        ticket: Option<&RecoveryTicket>,
        session_continuation: bool,
        conversation_authorization: bool,
    ) -> Result<u64> {
        anyhow::ensure!(
            self.current
                .as_ref()
                .is_none_or(|receipt| receipt.cleanup == Cleanup::Confirmed && receipt.terminal),
            "Old desktop worker, input and resource cleanup must be confirmed first"
        );
        if let Some(ticket) = ticket {
            self.validate_ticket(ticket)?;
        } else if session_continuation {
            anyhow::ensure!(
                self.valid
                    && self.conversation_authorization
                    && self.owner.as_deref() == Some(&owner.client_instance)
                    && self.thread_id.as_deref() == Some(&owner.thread_id),
                "Desktop session authorization was revoked or belongs to another owner"
            );
            anyhow::ensure!(
                self.recovery.is_none(),
                "Desktop recovery is already in progress"
            );
        } else {
            anyhow::ensure!(
                self.recovery.is_none(),
                "Desktop recovery is already in progress"
            );
            self.generation = self
                .generation
                .checked_add(1)
                .context("Desktop grant generation exhausted")?;
            self.owner = Some(owner.client_instance.clone());
            self.thread_id = Some(owner.thread_id.clone());
            self.valid = true;
            self.conversation_authorization = conversation_authorization;
        }
        self.current = Some(DesktopReceipt {
            turn_id: owner.turn_id.clone(),
            recovered_from: ticket.map(|ticket| ticket.previous_turn_id.clone()),
            cleanup: Cleanup::Unknown,
            terminal: false,
            session: None,
            #[cfg(windows)]
            host: None,
        });
        self.recovery = None;
        Ok(self.generation)
    }
    fn validate_ticket(&self, ticket: &RecoveryTicket) -> Result<()> {
        anyhow::ensure!(
            self.valid
                && self.conversation_authorization
                && self.generation == ticket.generation
                && self.owner.as_deref() == Some(&ticket.owner)
                && self.thread_id.as_deref() == Some(&ticket.thread_id),
            "Desktop session authorization was revoked or belongs to another owner"
        );
        anyhow::ensure!(
            self.current
                .as_ref()
                .is_some_and(|receipt| receipt.turn_id == ticket.previous_turn_id),
            "Desktop recovery refers to a stale control turn"
        );
        anyhow::ensure!(
            self.recovery.as_ref() == Some(&(ticket.generation, ticket.previous_turn_id.clone())),
            "Desktop recovery claim is no longer current"
        );
        Ok(())
    }
    #[cfg(any(windows, test))]
    pub(super) fn expire_per_turn_grant(&mut self, turn_id: &str) {
        if !self.conversation_authorization
            && self
                .current
                .as_ref()
                .is_some_and(|receipt| receipt.turn_id == turn_id)
        {
            self.revoke();
        }
    }
    #[cfg(test)]
    pub(super) fn confirm_cleanup(&mut self, turn_id: &str, cleanup: Cleanup, terminal: bool) {
        self.set_cleanup(turn_id, cleanup, terminal);
    }
    #[cfg(any(windows, test))]
    pub(super) fn confirm_cleanup_for_session(
        &mut self,
        session: &Arc<DesktopSession>,
        cleanup: Cleanup,
        terminal: bool,
    ) -> bool {
        if !self
            .current
            .as_ref()
            .and_then(|receipt| receipt.session.as_ref())
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            return false;
        }
        self.set_cleanup(&session.owner().turn_id, cleanup, terminal);
        true
    }
    #[cfg(any(windows, test))]
    fn set_cleanup(&mut self, turn_id: &str, cleanup: Cleanup, terminal: bool) {
        if let Some(receipt) = self
            .current
            .as_mut()
            .filter(|receipt| receipt.turn_id == turn_id)
        {
            receipt.cleanup = cleanup;
            receipt.terminal |= terminal;
            #[cfg(windows)]
            if cleanup == Cleanup::Confirmed {
                receipt.host = None;
            }
        }
    }
    #[cfg(any(windows, test))]
    pub(super) fn attach_session(
        &mut self,
        owner: &DesktopOwner,
        generation: u64,
        session: Arc<DesktopSession>,
    ) -> Result<()> {
        anyhow::ensure!(
            self.valid_for(owner, generation),
            "Desktop authorization changed during worker startup"
        );
        self.current
            .as_mut()
            .context("Desktop receipt is unavailable")?
            .session = Some(session);
        Ok(())
    }
    #[cfg(windows)]
    pub(super) fn attach_host(
        &mut self,
        owner: &DesktopOwner,
        generation: u64,
        host: Arc<kcoder_mcp::desktop_host::LocalDesktopHost>,
    ) -> Result<()> {
        anyhow::ensure!(
            self.valid_for(owner, generation),
            "Desktop authorization changed during worker startup"
        );
        self.attach_session(owner, generation, host.session.clone())?;
        self.current
            .as_mut()
            .context("Desktop receipt is unavailable")?
            .host = Some(host);
        Ok(())
    }
    #[cfg(any(windows, test))]
    pub(super) fn diagnostic(
        &self,
        turn_id: &str,
        state: DesktopSessionState,
    ) -> (ComputerUseDiagnostic, bool) {
        let receipt = self
            .current
            .as_ref()
            .filter(|receipt| receipt.turn_id == turn_id);
        let authorization = if self.valid {
            Authorization::Valid
        } else {
            Authorization::Revoked
        };
        let operation = receipt
            .and_then(|receipt| receipt.session.as_ref())
            .and_then(|session| session.subscribe_diagnostics().borrow().clone());
        let cleanup = match state {
            DesktopSessionState::Stopping => Cleanup::Pending,
            DesktopSessionState::Stopped => Cleanup::Confirmed,
            DesktopSessionState::StopFailed => {
                receipt.map_or(Cleanup::Unknown, |receipt| receipt.cleanup)
            }
            _ => Cleanup::Unknown,
        };
        let channel = if state == DesktopSessionState::Active {
            Channel::Available
        } else {
            Channel::Unavailable
        };
        let recovery = self.valid
            && self.conversation_authorization
            && receipt.is_some()
            && channel != Channel::Available;
        (
            ComputerUseDiagnostic {
                authorization,
                channel,
                cleanup,
                failure_code: operation
                    .as_ref()
                    .and_then(|operation| operation.failure_code.clone()),
                operation_id: operation
                    .as_ref()
                    .map(|operation| format!("operation-{}", operation.sequence)),
                tool: operation.as_ref().map(|operation| operation.tool.clone()),
                elapsed_ms: operation.as_ref().map(|operation| operation.elapsed_ms),
                host_pid: operation.as_ref().and_then(|operation| operation.host_pid),
                worker_pid: operation
                    .as_ref()
                    .and_then(|operation| operation.worker_pid),
            },
            recovery,
        )
    }
}

#[cfg(windows)]
pub(super) async fn publish_startup_failure(
    grant: &SharedGrant,
    owner: &DesktopOwner,
    sequence: &Arc<AtomicU64>,
    tx: &mpsc::Sender<Value>,
) {
    let payload = {
        let grant = grant.lock().unwrap_or_else(|error| error.into_inner());
        let state = if grant
            .current
            .as_ref()
            .is_none_or(|receipt| receipt.cleanup == Cleanup::Confirmed)
        {
            DesktopSessionState::Stopped
        } else {
            DesktopSessionState::StopFailed
        };
        let last_turn = grant
            .current
            .as_ref()
            .map_or("", |receipt| receipt.turn_id.as_str());
        let (mut diagnostic, _) = grant.diagnostic(last_turn, state);
        if grant.owner.is_none() {
            diagnostic.authorization = Authorization::Unknown;
        }
        if diagnostic.authorization == Authorization::Revoked {
            diagnostic.failure_code = Some("lease_revoked".into());
        }
        kcoder_app_protocol::ComputerUseStateChanged {
            state,
            target: kcoder_app_protocol::ComputerUseTarget::LocalWindowsDesktop,
            diagnostic: Some(diagnostic),
            recovery_available: Some(false),
        }
    };
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
    let shared = state.desktop_grant.clone();
    let ticket = {
        let mut grant = shared.lock().unwrap_or_else(|error| error.into_inner());
        anyhow::ensure!(
            grant.valid
                && grant.conversation_authorization
                && grant.owner.as_deref() == Some(owner),
            "Desktop session authorization is not valid for this owner"
        );
        let receipt = grant
            .current
            .as_ref()
            .context("No desktop control turn is available to recover")?;
        if receipt.recovered_from.as_deref() == Some(&params.previous_turn_id) {
            return Ok(RecoveryPreparation::Existing(ComputerUseRecoverResult {
                thread_id: params.thread_id.clone(),
                previous_turn_id: params.previous_turn_id.clone(),
                turn_id: receipt.turn_id.clone(),
                status: if receipt.terminal {
                    kcoder_app_protocol::ComputerUseRecoveryStatus::Completed
                } else {
                    kcoder_app_protocol::ComputerUseRecoveryStatus::Running
                },
            }));
        }
        anyhow::ensure!(
            receipt.turn_id == params.previous_turn_id,
            "Desktop recovery refers to a stale control turn"
        );
        anyhow::ensure!(
            receipt.session.as_ref().is_none_or(
                |session| *session.subscribe_state().borrow() != DesktopSessionState::Active
            ),
            "The desktop channel is still active"
        );
        anyhow::ensure!(
            grant.recovery.is_none(),
            "Desktop recovery is already in progress"
        );
        let generation = grant.generation;
        grant.recovery = Some((generation, params.previous_turn_id.clone()));
        RecoveryTicket {
            grant: shared.clone(),
            generation,
            previous_turn_id: params.previous_turn_id.clone(),
            owner: owner.into(),
            thread_id: params.thread_id.clone(),
        }
    };
    Ok(RecoveryPreparation::New(ticket))
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
    let shared = ticket.grant.clone();
    let previous_turn_id = ticket.previous_turn_id.clone();
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
    {
        let host = shared
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .current
            .as_ref()
            .and_then(|receipt| receipt.host.clone());
        if let Some(host) = host {
            let cleaned = host.stop().await.is_ok();
            shared
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .confirm_cleanup_for_session(
                    &host.session,
                    if cleaned {
                        Cleanup::Confirmed
                    } else {
                        Cleanup::Failed
                    },
                    false,
                );
            anyhow::ensure!(
                cleaned,
                "Old desktop worker or input cleanup was not confirmed"
            );
        }
    }
    // Poll the existing task handle without retaining its ownership lock.
    // The main request loop remains able to process interrupt and revoke.
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut interval = tokio::time::interval(Duration::from_millis(50));
        loop {
            interval.tick().await;
            {
                let grant = shared.lock().unwrap_or_else(|error| error.into_inner());
                grant.validate_ticket(&ticket)?;
            }
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
    {
        let grant = shared.lock().unwrap_or_else(|error| error.into_inner());
        grant.validate_ticket(&ticket)?;
        anyhow::ensure!(
            grant
                .current
                .as_ref()
                .is_some_and(|receipt| receipt.cleanup == Cleanup::Confirmed && receipt.terminal),
            "Old desktop worker, input and resources are not confirmed released"
        );
    }
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
        anyhow::ensure!(
            grant
                .owner
                .as_deref()
                .is_none_or(|existing| existing == owner),
            "Desktop grant belongs to another owner"
        );
        grant.revoke();
        grant
            .current
            .as_ref()
            .and_then(|receipt| receipt.session.clone())
    };
    // A recovery may be awaiting the active handle. It has already requested
    // cancellation; generation revocation above never waits for that handle.
    if let Ok(active) = state.active_turn.try_lock()
        && let Some(active) = active.as_ref()
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
    fn ticket(grant: &SharedGrant) -> RecoveryTicket {
        grant.lock().unwrap().recovery = Some((1, "old".into()));
        RecoveryTicket {
            grant: grant.clone(),
            generation: 1,
            previous_turn_id: "old".into(),
            owner: "client".into(),
            thread_id: "thread".into(),
        }
    }
    #[test]
    fn replacement_requires_old_cleanup_and_terminal_receipt() {
        let grant = authorized();
        let ticket = ticket(&grant);
        assert!(
            grant
                .lock()
                .unwrap()
                .begin_turn(&owner("new"), Some(&ticket))
                .is_err()
        );
        grant
            .lock()
            .unwrap()
            .confirm_cleanup("old", Cleanup::Confirmed, false);
        assert!(
            grant
                .lock()
                .unwrap()
                .begin_turn(&owner("new"), Some(&ticket))
                .is_err()
        );
        grant
            .lock()
            .unwrap()
            .confirm_cleanup("old", Cleanup::Confirmed, true);
        assert_eq!(
            grant
                .lock()
                .unwrap()
                .begin_turn(&owner("new"), Some(&ticket))
                .unwrap(),
            1
        );
        assert!(grant.lock().unwrap().valid_for(&owner("new"), 1));
        assert!(!grant.lock().unwrap().valid_for(&owner("old"), 1));
    }
    #[test]
    fn revoke_during_cleanup_and_stale_receipts_cannot_regrant() {
        let grant = authorized();
        let ticket = ticket(&grant);
        grant.lock().unwrap().revoke();
        grant
            .lock()
            .unwrap()
            .confirm_cleanup("old", Cleanup::Confirmed, true);
        assert!(
            grant
                .lock()
                .unwrap()
                .begin_turn(&owner("new"), Some(&ticket))
                .is_err()
        );
        assert!(!grant.lock().unwrap().valid);
        grant
            .lock()
            .unwrap()
            .begin_turn(&owner("explicit"), None)
            .unwrap();
        grant
            .lock()
            .unwrap()
            .confirm_cleanup("old", Cleanup::Confirmed, true);
        assert!(
            grant
                .lock()
                .unwrap()
                .begin_turn(&owner("overlap"), None)
                .is_err()
        );
    }
    #[test]
    fn failed_recovery_ticket_releases_only_its_own_claim() {
        let grant = authorized();
        {
            let _ticket = ticket(&grant);
        }
        assert!(grant.lock().unwrap().recovery.is_none());
        let old = ticket(&grant);
        grant.lock().unwrap().revoke();
        grant.lock().unwrap().recovery = Some((2, "other".into()));
        drop(old);
        assert_eq!(grant.lock().unwrap().recovery, Some((2, "other".into())));
    }
    #[test]
    fn automatic_session_turn_cannot_create_or_renew_revoked_authorization() {
        let mut missing = DesktopGrantState::default();
        assert!(
            missing
                .begin_turn_with_session(&owner("new"), None, true, false)
                .is_err()
        );
        let grant = authorized();
        grant
            .lock()
            .unwrap()
            .confirm_cleanup("old", Cleanup::Confirmed, true);
        let mut foreign = owner("foreign");
        foreign.thread_id = "other".into();
        assert!(
            grant
                .lock()
                .unwrap()
                .begin_turn_with_session(&foreign, None, true, false)
                .is_err()
        );
        assert_eq!(
            grant
                .lock()
                .unwrap()
                .begin_turn_with_session(&owner("next"), None, true, false)
                .unwrap(),
            1
        );
        grant
            .lock()
            .unwrap()
            .confirm_cleanup("next", Cleanup::Confirmed, true);
        grant.lock().unwrap().revoke();
        assert!(
            grant
                .lock()
                .unwrap()
                .begin_turn_with_session(&owner("automatic"), None, true, false)
                .is_err()
        );
        assert!(!grant.lock().unwrap().valid);
        grant
            .lock()
            .unwrap()
            .begin_turn_with_session(&owner("explicit"), None, false, true)
            .unwrap();
        assert!(grant.lock().unwrap().valid);
    }
    #[test]
    fn legacy_per_turn_approval_expires_and_cannot_become_conversation_grant() {
        let mut grant = DesktopGrantState::default();
        grant
            .begin_turn_with_session(&owner("legacy"), None, false, false)
            .unwrap();
        assert!(grant.valid);
        assert!(!grant.conversation_authorization);
        let (_, recovery) = grant.diagnostic("legacy", DesktopSessionState::Stopped);
        assert!(!recovery);
        grant.confirm_cleanup("legacy", Cleanup::Confirmed, true);
        grant.expire_per_turn_grant("legacy");
        assert!(!grant.valid);
        assert!(
            grant
                .begin_turn_with_session(&owner("next"), None, true, false)
                .is_err()
        );
        grant
            .begin_turn_with_session(&owner("fresh"), None, false, true)
            .unwrap();
        assert!(grant.valid && grant.conversation_authorization);
    }
    #[test]
    fn persistent_plugin_generation_changes_cannot_reactivate_old_grant() {
        let grant = authorized();
        grant.lock().unwrap().capture_policy_generation(10);
        let ticket = ticket(&grant);
        grant
            .lock()
            .unwrap()
            .confirm_cleanup("old", Cleanup::Confirmed, true);
        assert!(grant.lock().unwrap().check_policy_generation(12).is_err());
        assert!(
            grant
                .lock()
                .unwrap()
                .begin_turn(&owner("automatic"), Some(&ticket))
                .is_err()
        );
        assert!(!grant.lock().unwrap().valid);
        // The enabled flag may be true again, but the durable profile generation
        // proves this is not the policy under which the old grant was approved.
        assert!(grant.lock().unwrap().check_policy_generation(12).is_err());
        grant.lock().unwrap().capture_policy_generation(12);
        grant
            .lock()
            .unwrap()
            .begin_turn(&owner("explicit"), None)
            .unwrap();
        assert!(grant.lock().unwrap().check_policy_generation(12).is_ok());
    }
    #[tokio::test]
    async fn cleanup_receipt_is_bound_to_the_control_session_when_retry_reuses_turn_id() {
        use kcoder_computer_use::{
            client::DesktopClient,
            framing::{MAX_REPLY_BYTES, read_frame, write_frame},
        };
        async fn session(owner: DesktopOwner) -> Arc<DesktopSession> {
            let (client, mut peer) = tokio::io::duplex(4096);
            tokio::spawn(async move {
                let bytes = read_frame(&mut peer, kcoder_computer_use::policy::MAX_REQUEST_BYTES)
                    .await
                    .unwrap();
                let request: Value = serde_json::from_slice(&bytes).unwrap();
                write_frame(&mut peer, &serde_json::to_vec(&json!({"requestId":request["requestId"],"result":{"lease":{"id":uuid::Uuid::new_v4().to_string(),"generation":1}}})).unwrap(), MAX_REPLY_BYTES).await.unwrap();
            });
            Arc::new(
                DesktopSession::acquire(DesktopClient::from_authenticated(client), owner)
                    .await
                    .unwrap(),
            )
        }
        let grant = authorized();
        let old = session(owner("old")).await;
        grant
            .lock()
            .unwrap()
            .attach_session(&owner("old"), 1, old.clone())
            .unwrap();
        assert!(
            grant
                .lock()
                .unwrap()
                .confirm_cleanup_for_session(&old, Cleanup::Confirmed, true)
        );
        grant
            .lock()
            .unwrap()
            .begin_turn_with_session(&owner("old"), None, true, false)
            .unwrap();
        let current = session(owner("old")).await;
        grant
            .lock()
            .unwrap()
            .attach_session(&owner("old"), 1, current.clone())
            .unwrap();
        assert!(
            !grant
                .lock()
                .unwrap()
                .confirm_cleanup_for_session(&old, Cleanup::Confirmed, true)
        );
        assert_eq!(
            grant.lock().unwrap().current.as_ref().unwrap().cleanup,
            Cleanup::Unknown
        );
        assert!(grant.lock().unwrap().confirm_cleanup_for_session(
            &current,
            Cleanup::Confirmed,
            true
        ));
    }
    fn runtime_state(grant: SharedGrant) -> ResidentTurnState {
        let (tx, _) = mpsc::channel(8);
        let mut state = ResidentTurnState::new(
            tx,
            kcoder_config::PermissionMode::Bypass,
            Arc::new(AtomicU64::new(1)),
            Arc::new(AtomicU64::new(1)),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );
        state.desktop_grant = grant;
        state
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
            handle,
            cancel: cancellation,
            thread_id: "thread".into(),
            turn_id: "old".into(),
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
        assert!(!grant.lock().unwrap().valid);
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
        assert!(grant.lock().unwrap().recovery.is_none());
        assert!(
            grant
                .lock()
                .unwrap()
                .begin_turn(&owner("new"), None)
                .is_err()
        );
    }
}
