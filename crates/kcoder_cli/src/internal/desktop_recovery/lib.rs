//! Recovery reuses the resident turn's authorization and owned cleanup path.
//! A recovery ticket is never a new grant and cannot contain model input.
use anyhow::{Context, Result};
#[cfg(any(windows, test, feature = "test-oracle"))]
use kcoder_app_protocol::{
    ComputerUseAuthorizationState as Authorization, ComputerUseChannelState as Channel,
    ComputerUseDiagnostic,
};
use kcoder_app_protocol::{
    ComputerUseCleanupState as Cleanup, ComputerUseRecoverParams, ComputerUseRecoverResult,
};
#[cfg(any(windows, test, feature = "test-oracle"))]
use kcoder_app_protocol::{ComputerUseStateChanged, ComputerUseTarget};
use kcoder_computer_use::session::DesktopSession;
#[cfg(any(windows, test, feature = "test-oracle"))]
use kcoder_types::computer_use::DesktopOwner;
use kcoder_types::computer_use::DesktopSessionState;
use std::sync::{Arc, Mutex as StdMutex};

pub type SharedGrant = Arc<StdMutex<DesktopGrantState>>;
#[derive(Default)]
pub struct DesktopGrantState {
    owner: Option<String>,
    thread_id: Option<String>,
    generation: u64,
    valid: bool,
    conversation_authorization: bool,
    #[cfg(any(windows, test, feature = "test-oracle"))]
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
pub struct RecoveryTicket {
    grant: SharedGrant,
    generation: u64,
    previous_turn_id: String,
    owner: String,
    thread_id: String,
}
impl RecoveryTicket {
    pub fn previous_turn_id(&self) -> &str {
        &self.previous_turn_id
    }
    pub fn validate_ready(&self) -> Result<()> {
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
pub enum RecoveryPreparation {
    Existing(ComputerUseRecoverResult),
    New(RecoveryTicket),
}
impl DesktopGrantState {
    /// Desktop state an idle eviction would silently drop: unconfirmed
    /// worker/input cleanup, a pending recovery or a live conversation grant.
    pub fn retains_desktop_state(&self) -> bool {
        self.recovery.is_some()
            || (self.valid && self.conversation_authorization)
            || self
                .current
                .as_ref()
                .is_some_and(|receipt| !(receipt.cleanup == Cleanup::Confirmed && receipt.terminal))
    }
    pub fn revoke(&mut self) {
        self.valid = false;
        self.generation = self.generation.saturating_add(1);
        self.recovery = None;
    }
    #[cfg(any(windows, test, feature = "test-oracle"))]
    pub fn capture_policy_generation(&mut self, generation: u64) {
        self.policy_generation = Some(generation);
    }
    #[cfg(any(windows, test, feature = "test-oracle"))]
    pub fn check_policy_generation(&mut self, generation: u64) -> Result<()> {
        if self.policy_generation != Some(generation) {
            self.revoke();
            anyhow::bail!("Desktop plugin policy changed; a fresh explicit approval is required");
        }
        Ok(())
    }
    #[cfg(any(windows, test, feature = "test-oracle"))]
    pub fn valid_for(&self, owner: &DesktopOwner, generation: u64) -> bool {
        self.valid
            && self.generation == generation
            && self.owner.as_deref() == Some(&owner.client_instance)
            && self.thread_id.as_deref() == Some(&owner.thread_id)
            && self
                .current
                .as_ref()
                .is_some_and(|receipt| receipt.turn_id == owner.turn_id)
    }
    #[cfg(any(test, feature = "test-oracle"))]
    pub fn begin_turn(
        &mut self,
        owner: &DesktopOwner,
        ticket: Option<&RecoveryTicket>,
    ) -> Result<u64> {
        self.begin_turn_with_session(owner, ticket, false, true)
    }
    #[cfg(any(windows, test, feature = "test-oracle"))]
    pub fn begin_turn_with_session(
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
    #[cfg(any(windows, test, feature = "test-oracle"))]
    pub fn expire_per_turn_grant(&mut self, turn_id: &str) {
        if !self.conversation_authorization
            && self
                .current
                .as_ref()
                .is_some_and(|receipt| receipt.turn_id == turn_id)
        {
            self.revoke();
        }
    }
    #[cfg(any(test, feature = "test-oracle"))]
    pub fn confirm_cleanup(&mut self, turn_id: &str, cleanup: Cleanup, terminal: bool) {
        self.set_cleanup(turn_id, cleanup, terminal);
    }
    #[cfg(any(windows, test, feature = "test-oracle"))]
    pub fn confirm_cleanup_for_session(
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
    #[cfg(any(windows, test, feature = "test-oracle"))]
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
    #[cfg(any(windows, test, feature = "test-oracle"))]
    pub fn attach_session(
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
    pub fn attach_host(
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
    #[cfg(any(windows, test, feature = "test-oracle"))]
    pub fn diagnostic(
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

    /// Read the current host state for this exact owner and turn. A terminal
    /// turn without an explicit host receipt is deliberately not observable.
    #[cfg(any(windows, test, feature = "test-oracle"))]
    pub fn observe_turn(&self, owner: &DesktopOwner) -> Option<ComputerUseStateChanged> {
        if self.owner.as_deref() != Some(&owner.client_instance)
            || self.thread_id.as_deref() != Some(&owner.thread_id)
        {
            return None;
        }
        let receipt = self
            .current
            .as_ref()
            .filter(|receipt| receipt.turn_id == owner.turn_id)?;
        let state = match receipt.session.as_ref() {
            Some(session) => *session.subscribe_state().borrow(),
            None => match receipt.cleanup {
                Cleanup::Confirmed => DesktopSessionState::Stopped,
                Cleanup::Failed => DesktopSessionState::StopFailed,
                Cleanup::Pending => DesktopSessionState::Stopping,
                Cleanup::Unknown => return None,
            },
        };
        let (diagnostic, recovery_available) = self.diagnostic(&owner.turn_id, state);
        Some(ComputerUseStateChanged {
            state,
            target: ComputerUseTarget::LocalWindowsDesktop,
            diagnostic: Some(diagnostic),
            recovery_available: Some(recovery_available),
        })
    }

    #[cfg(any(windows, test))]
    fn startup_failure_observation(&self, owner: &DesktopOwner) -> Option<ComputerUseStateChanged> {
        if self.owner.as_deref() != Some(&owner.client_instance)
            || self.thread_id.as_deref() != Some(&owner.thread_id)
        {
            return None;
        }
        let receipt = self
            .current
            .as_ref()
            .filter(|receipt| receipt.turn_id == owner.turn_id)?;
        if receipt.session.is_some() || receipt.cleanup != Cleanup::Unknown {
            return self.observe_turn(owner);
        }
        let (mut diagnostic, _) = self.diagnostic(&owner.turn_id, DesktopSessionState::StopFailed);
        if diagnostic.authorization == Authorization::Revoked {
            diagnostic.failure_code = Some("lease_revoked".into());
        }
        Some(ComputerUseStateChanged {
            state: DesktopSessionState::StopFailed,
            target: ComputerUseTarget::LocalWindowsDesktop,
            diagnostic: Some(diagnostic),
            recovery_available: Some(false),
        })
    }
}

#[cfg(any(windows, test, feature = "test-oracle"))]
pub fn observe_turn_with_sequence(
    shared: &SharedGrant,
    owner: &DesktopOwner,
    sequence: &std::sync::atomic::AtomicU64,
) -> (u64, Option<ComputerUseStateChanged>) {
    let grant = shared.lock().unwrap_or_else(|error| error.into_inner());
    let observation = grant.observe_turn(owner);
    let sequence = sequence.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    (sequence, observation)
}

impl RecoveryTicket {
    pub fn validate_current(&self) -> Result<()> {
        self.grant
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .validate_ticket(self)
    }

    pub fn validate_cleanup_confirmed(&self) -> Result<()> {
        let grant = self.grant.lock().unwrap_or_else(|error| error.into_inner());
        grant.validate_ticket(self)?;
        anyhow::ensure!(
            grant.current.as_ref().is_some_and(|receipt| {
                receipt.cleanup == Cleanup::Confirmed && receipt.terminal
            }),
            "Old desktop worker, input and resources are not confirmed released"
        );
        Ok(())
    }

    #[cfg(windows)]
    pub async fn stop_previous_host(&self) -> Result<()> {
        let host = self
            .grant
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .current
            .as_ref()
            .and_then(|receipt| receipt.host.clone());
        if let Some(host) = host {
            let cleaned = host.stop().await.is_ok();
            self.grant
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
        Ok(())
    }
}

impl DesktopGrantState {
    pub fn revoke_for_owner(&mut self, owner: &str) -> Result<Option<Arc<DesktopSession>>> {
        anyhow::ensure!(
            self.owner
                .as_deref()
                .is_none_or(|existing| existing == owner),
            "Desktop grant belongs to another owner"
        );
        self.revoke();
        Ok(self
            .current
            .as_ref()
            .and_then(|receipt| receipt.session.clone()))
    }
}

#[cfg(windows)]
pub fn startup_failure(
    grant: &SharedGrant,
    owner: &DesktopOwner,
    sequence: &std::sync::atomic::AtomicU64,
) -> Option<(u64, kcoder_app_protocol::ComputerUseStateChanged)> {
    let grant = grant.lock().unwrap_or_else(|error| error.into_inner());
    let payload = grant.startup_failure_observation(owner)?;
    let sequence = sequence.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Some((sequence, payload))
}

pub fn claim_recovery(
    shared: &SharedGrant,
    params: &ComputerUseRecoverParams,
    owner: &str,
) -> Result<RecoveryPreparation> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn owner(turn: &str) -> DesktopOwner {
        DesktopOwner {
            client_instance: "client".into(),
            thread_id: "thread".into(),
            turn_id: turn.into(),
        }
    }
    #[test]
    fn turn_status_requires_exact_owner_and_an_explicit_host_receipt() {
        let mut grant = DesktopGrantState::default();
        let current = owner("turn");
        grant.begin_turn(&current, None).unwrap();

        assert!(grant.observe_turn(&current).is_none());
        assert!(grant.observe_turn(&owner("other-turn")).is_none());
        let mut foreign = current.clone();
        foreign.client_instance = "other-client".into();
        assert!(grant.observe_turn(&foreign).is_none());

        grant.confirm_cleanup("turn", Cleanup::Confirmed, true);
        let stopped = grant
            .observe_turn(&current)
            .expect("confirmed cleanup receipt");
        assert_eq!(stopped.state, DesktopSessionState::Stopped);
        assert_eq!(
            stopped.diagnostic.as_ref().unwrap().cleanup,
            Cleanup::Confirmed
        );

        grant.confirm_cleanup("turn", Cleanup::Failed, true);
        let failed = grant
            .observe_turn(&current)
            .expect("failed cleanup receipt");
        assert_eq!(failed.state, DesktopSessionState::StopFailed);
        assert_eq!(failed.diagnostic.as_ref().unwrap().cleanup, Cleanup::Failed);
    }

    #[test]
    fn startup_failure_keeps_an_exact_unconfirmed_receipt_attention_visible() {
        let mut grant = DesktopGrantState::default();
        let current = owner("turn");
        grant.begin_turn(&current, None).unwrap();

        assert!(grant.observe_turn(&current).is_none());
        let failure = grant
            .startup_failure_observation(&current)
            .expect("failed startup matches the exact turn receipt");
        assert_eq!(failure.state, DesktopSessionState::StopFailed);
        assert_eq!(
            failure.diagnostic.as_ref().unwrap().cleanup,
            Cleanup::Unknown
        );
        assert!(
            grant
                .startup_failure_observation(&owner("unrelated-turn"))
                .is_none()
        );
        grant.revoke();
        let revoked = grant
            .startup_failure_observation(&current)
            .expect("revoked startup receipt stays observable");
        assert_eq!(
            revoked.diagnostic.as_ref().unwrap().failure_code.as_deref(),
            Some("lease_revoked")
        );
    }

    #[test]
    fn notification_and_query_snapshots_share_one_sequence_lock() {
        let shared = Arc::new(StdMutex::new(DesktopGrantState::default()));
        let current = owner("turn");
        shared.lock().unwrap().begin_turn(&current, None).unwrap();
        shared
            .lock()
            .unwrap()
            .confirm_cleanup("turn", Cleanup::Failed, true);
        let sequence = std::sync::atomic::AtomicU64::new(20);

        // Hold the first notification for later delivery while a query observes
        // the newer confirmed cleanup state.
        let (event_sequence, event) = observe_turn_with_sequence(&shared, &current, &sequence);
        assert_eq!(event_sequence, 20);
        assert_eq!(event.unwrap().state, DesktopSessionState::StopFailed);

        shared
            .lock()
            .unwrap()
            .confirm_cleanup("turn", Cleanup::Confirmed, true);
        let (query_sequence, query) = observe_turn_with_sequence(&shared, &current, &sequence);
        assert_eq!(query_sequence, 21);
        assert_eq!(query.unwrap().state, DesktopSessionState::Stopped);

        let (unobservable_sequence, unobservable) =
            observe_turn_with_sequence(&shared, &owner("different-turn"), &sequence);
        assert_eq!(unobservable_sequence, 22);
        assert!(unobservable.is_none());
        // A consumer can apply the query first and ignore the delayed older
        // event. The missing observation does not alter that watermark.
        assert!(event_sequence < query_sequence);
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
}
