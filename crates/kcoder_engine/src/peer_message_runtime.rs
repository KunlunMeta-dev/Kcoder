//! Target-owned peer delivery at complete provider/tool-batch boundaries.
use crate::{EngineEvent, QueryEngine};
use kcoder_state::{
    AppState, AppStateLifecycleIdentity, peer_agent_history::PeerHistoryCommitWitness,
};
use kcoder_types::TurnAttemptIdentity;
use std::sync::Arc;
mod claimed_validation;

#[derive(Clone)]
pub struct PeerMessageCall {
    state: AppState,
    owner: AppStateLifecycleIdentity,
    attempt: Option<TurnAttemptIdentity>,
    idle: bool,
    cancel: tokio_util::sync::CancellationToken,
    claimed_start: Option<(Arc<kcoder_state::PeerAutoWakePermit>, uuid::Uuid)>,
    claimed_scope: Option<std::sync::Weak<crate::peer_provider_start::PeerProviderScope>>,
}
pub(super) struct PeerBoundaryDelivery {
    pub events: Vec<EngineEvent>,
    pub has_fresh_delivery: bool,
}
impl PeerMessageCall {
    /// Observation only. A real host must still verify its original target
    /// lease; this value supplies no attempt or append/wake authority.
    pub fn observe_owner(
        state: AppState,
        owner: AppStateLifecycleIdentity,
    ) -> Result<Self, &'static str> {
        if owner.try_matches(&state) != Some(true) {
            return Err("peer_target_owner_unavailable");
        }
        Ok(Self {
            state,
            owner,
            attempt: None,
            idle: true,
            cancel: tokio_util::sync::CancellationToken::new(),
            claimed_start: None,
            claimed_scope: None,
        })
    }
    pub fn from_owned_turn(
        admission: &crate::owned_turn::OwnedTurnAdmission,
    ) -> Result<Self, &'static str> {
        admission.verify_current()?;
        Ok(Self {
            state: admission.state().clone(),
            owner: admission.owner().clone(),
            attempt: Some(admission.identity().clone()),
            idle: false,
            cancel: tokio_util::sync::CancellationToken::new(),
            claimed_start: None,
            claimed_scope: None,
        })
    }
    pub(super) fn claimed_provider_start(
        state: AppState,
        owner: AppStateLifecycleIdentity,
        permit: Arc<kcoder_state::PeerAutoWakePermit>,
        scope: Arc<crate::peer_provider_start::PeerProviderScope>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Self {
        // This is the original idle contribution's claimed target turn;
        // its current target attempt cannot become a sender attempt.
        Self {
            state,
            owner,
            attempt: None,
            idle: false,
            cancel,
            claimed_start: Some((permit, scope.id)),
            claimed_scope: Some(Arc::downgrade(&scope)),
        }
    }
    /// Only a real Engine-created claimed call carries this private scope.
    /// A budget observation alone never authorizes a Provider continuation.
    pub fn verify_current_provider_invocation(
        &self,
        permit: &kcoder_state::PeerAutoWakePermit,
    ) -> anyhow::Result<()> {
        let (original, stream) = self
            .claimed_start
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("PEER_WAKE_PROVIDER_ORIGINAL_CALL_REQUIRED"))?;
        self.verify_current_owner()?;
        anyhow::ensure!(
            std::ptr::eq(original.as_ref(), permit) && permit.matches_provider_stream(*stream),
            "PEER_WAKE_PROVIDER_ORIGINAL_CALL_REQUIRED"
        );
        let scope = self
            .claimed_scope
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
            .ok_or_else(|| anyhow::anyhow!("PEER_WAKE_PROVIDER_SCOPE_CLOSED"))?;
        scope.verify_registered(&self.state, &self.owner)?;
        match permit.verify_provider_start(&self.state, &self.owner) {
            Ok(()) => Ok(()),
            Err(error)
                if kcoder_state::PeerAutoWakePermit::start_failure_reason(&error)
                    == "PEER_WAKE_PERMIT_EXPIRED"
                    && !permit.provider_dispatch_pending() =>
            {
                scope.verify_live_response(&self.state, &self.owner, *stream)?;
                permit.observed_provider_budget_owner(&self.state)?;
                Ok(())
            }
            Err(error) => Err(error),
        }
    }
    pub fn has_current_claimed_peer_start(&self) -> bool {
        self.verify_claimed_peer_start().is_ok()
    }
    pub fn claimed_start_matches_record(
        &self,
        record: &kcoder_state::cross_session_messages::CrossSessionMessageRecord,
    ) -> bool {
        self.verify_claimed_start_record(record).is_ok()
    }
    pub fn claimed_start_matches(
        &self,
        source: &kcoder_types::session_address::SessionAddressV1,
        destination: &kcoder_types::session_address::SessionAddressV1,
        client_id: &str,
        body_sha256: &str,
    ) -> bool {
        self.verify_claimed_start_selector(source, destination, client_id, body_sha256)
            .is_ok()
    }
    pub fn state(&self) -> &AppState {
        &self.state
    }
    pub fn owner(&self) -> &AppStateLifecycleIdentity {
        &self.owner
    }
    pub fn attempt(&self) -> Option<&TurnAttemptIdentity> {
        self.attempt.as_ref()
    }
    pub fn is_idle(&self) -> bool {
        self.idle
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
    pub async fn cancelled(&self) {
        self.cancel.cancelled().await
    }
    pub fn is_current(&self) -> bool {
        !self.cancel.is_cancelled() && self.owner.try_matches(&self.state) == Some(true)
    }
    /// Local bookkeeping only. The retained original permit may wait for its
    /// first storage lease; actual Provider/Source authorization remains fresh.
    pub fn settle_idle_wakes_in_provider_context(
        &self,
        store: &kcoder_state::cross_session_messages::CrossSessionMessageStore,
        messages: &kcoder_types::SharedMessages,
    ) -> anyhow::Result<()> {
        self.settle_idle_wakes_in_provider_context_checked(store, messages, || Ok(()))
    }
    pub fn settle_idle_wakes_in_provider_context_checked(
        &self,
        store: &kcoder_state::cross_session_messages::CrossSessionMessageStore,
        messages: &kcoder_types::SharedMessages,
        verify_host: impl Fn() -> anyhow::Result<()>,
    ) -> anyhow::Result<()> {
        verify_host()?;
        let settled = match self.claimed_start.as_ref() {
            Some((permit, stream)) if permit.provider_dispatch_pending() => store
                .settle_peer_idle_wakes_before_first_provider(
                    &self.state,
                    &self.owner,
                    messages,
                    permit,
                    *stream,
                ),
            _ => store.settle_peer_idle_wakes_in_provider_context_checked(
                &self.state,
                &self.owner,
                messages,
                &verify_host,
            ),
        };
        verify_host()?;
        settled
    }
}

#[async_trait::async_trait]
pub trait PeerMessageHost: Send + Sync {
    async fn authorize_claimed_provider_start(
        &self,
        _call: PeerMessageCall,
        _permit: &kcoder_state::PeerAutoWakePermit,
    ) -> Result<(), String> {
        Err("peer_provider_start_current_authorization_required".into())
    }
    /// Settle only original idle intents actually present in this Provider
    /// request. This is local durable bookkeeping, never a network allow cache.
    async fn settle_idle_wakes_in_provider_context(
        &self,
        _call: PeerMessageCall,
        _messages: &kcoder_types::SharedMessages,
    ) -> Result<(), String> {
        Ok(())
    }
    /// Durable quota only, after fresh current Source/target wake authorization.
    /// Hosts without a persistent implementation do not grant automatic starts.
    async fn claim_idle_wake(
        &self,
        _call: PeerMessageCall,
        _witnesses: &[PeerHistoryCommitWitness],
    ) -> Result<kcoder_state::PeerAutoWakeClaim, String> {
        Ok(kcoder_state::PeerAutoWakeClaim::NotEligible)
    }
    async fn record_fresh_user_reset(
        &self,
        _call: PeerMessageCall,
        _witness: &kcoder_state::PeerWakeUserResetWitness,
    ) -> Result<(), String> {
        Ok(())
    }
    /// A wake-up hint only, never an authorization or validated queue result.
    fn observation_stamp(
        &self,
    ) -> Result<
        Option<kcoder_state::cross_session_messages::CrossSessionMessageObservationStamp>,
        String,
    > {
        Ok(None)
    }

    /// The host rechecks current sender/target access, owns queue transactions,
    /// and returns only opaque State-native history witnesses for committed peers.
    async fn apply_at_boundary(
        &self,
        call: PeerMessageCall,
    ) -> Result<Vec<PeerHistoryCommitWitness>, String>;
    /// Waking a model needs a separate fresh host decision. History presence
    /// and an untrusted requested mode never become a permission grant.
    async fn authorize_idle_wake(
        &self,
        _call: PeerMessageCall,
        _witnesses: &[PeerHistoryCommitWitness],
    ) -> Result<bool, String> {
        Ok(false)
    }
}
impl QueryEngine {
    /// A durable User input may refill only its actual target's wake quota.
    /// Failure must never reject, replay or suppress the normal User turn.
    pub async fn record_fresh_user_input_for_peer_wake(
        &self,
        input: &kcoder_state::CommittedUserInput,
    ) -> Result<(), String> {
        let Some(witness) = input
            .peer_wake_reset_witness()
            .map_err(|_| "peer_wake_user_evidence_unavailable".to_owned())?
        else {
            return Ok(());
        };
        if !self.is_peer_target_owner() {
            return Ok(());
        }
        let Some(host) = self.peer_message_host.as_ref() else {
            return Ok(());
        };
        let owner = self
            .state
            .try_inspection_lifecycle_identity()
            .ok_or("peer_wake_user_owner_unavailable")?;
        if !witness.matches_target(&self.state, &owner) {
            return Err("peer_wake_user_target_changed".into());
        }
        let call = PeerMessageCall {
            state: self.state.clone(),
            owner,
            attempt: self.state.current_history_attempt_identity(),
            idle: !self.turn_driver_active(),
            cancel: self.cancel_token.clone(),
            claimed_start: None,
            claimed_scope: None,
        };
        host.record_fresh_user_reset(call, &witness).await
    }
    pub async fn claim_peer_auto_wake(
        &self,
        witnesses: &[PeerHistoryCommitWitness],
    ) -> Result<kcoder_state::PeerAutoWakeClaim, String> {
        if self.turn_driver_active()
            || !self.is_peer_target_owner()
            || !witnesses
                .iter()
                .any(PeerHistoryCommitWitness::has_pending_idle_wake_admission)
        {
            return Ok(kcoder_state::PeerAutoWakeClaim::NotEligible);
        }
        let Some(host) = self.peer_message_host.as_ref() else {
            return Ok(kcoder_state::PeerAutoWakeClaim::NotEligible);
        };
        let owner = self
            .state
            .try_inspection_lifecycle_identity()
            .ok_or("peer_wake_owner_unavailable")?;
        let call = PeerMessageCall {
            state: self.state.clone(),
            owner,
            attempt: self.state.current_history_attempt_identity(),
            idle: true,
            cancel: self.cancel_token.clone(),
            claimed_start: None,
            claimed_scope: None,
        };
        let claim = host.claim_idle_wake(call.clone(), witnesses).await?;
        // The native host may already have consumed the one durable attempt.
        // Keep its exact returned permit while a transient State writer holds
        // the lock; never call claim_idle_wake again to recover that object.
        for attempt in 0..3 {
            match call.state.try_check_lifecycle_identity(&call.owner) {
                Ok(Some(true)) => return Ok(claim),
                Ok(Some(false)) => return Err("peer_wake_owner_changed".into()),
                Ok(None) if attempt < 2 && !self.is_cancelled() => {
                    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                }
                Ok(None) => return Err("peer_wake_owner_busy".into()),
                Err(_) => return Err("peer_wake_owner_unavailable".into()),
            }
        }
        Err("peer_wake_owner_unavailable".into())
    }
    /// Availability only. All actual reads, appends and wakes recheck their own authority.
    pub fn has_peer_message_host(&self) -> bool {
        self.peer_message_host.is_some()
    }
    pub fn peer_message_observation_stamp(
        &self,
    ) -> Result<
        Option<kcoder_state::cross_session_messages::CrossSessionMessageObservationStamp>,
        String,
    > {
        match self.peer_message_host.as_ref() {
            Some(host) => host.observation_stamp(),
            None => Ok(None),
        }
    }
    pub fn with_peer_message_host(mut self, host: Arc<dyn PeerMessageHost>) -> Self {
        self.peer_message_host = Some(host);
        self
    }
    pub(super) fn is_peer_target_owner(&self) -> bool {
        self.agent_depth() == 0
            && self.subagent_system_prompt.is_none()
            && !self.native_input_requires_source_admission()
            && !self
                .terminal_verdict_turn
                .load(std::sync::atomic::Ordering::Acquire)
            && self
                .verifier_vote_channel
                .try_read()
                .is_ok_and(|slot| slot.is_none())
            && self
                .review_vote_channel
                .try_read()
                .is_ok_and(|slot| slot.is_none())
            && !self.is_arrangement_mode_active()
            && self.state.session_mode() == kcoder_state::SessionMode::Default
    }
    async fn apply_peer_boundary(
        &self,
        idle: bool,
    ) -> Result<Vec<PeerHistoryCommitWitness>, String> {
        if !self.is_peer_target_owner() {
            return Ok(Vec::new());
        }
        let Some(host) = self.peer_message_host.as_ref() else {
            return Ok(Vec::new());
        };
        let owner = self
            .state
            .try_inspection_lifecycle_identity()
            .ok_or("peer_target_owner_unavailable")?;
        let call = PeerMessageCall {
            state: self.state.clone(),
            owner,
            attempt: self.state.current_history_attempt_identity(),
            idle,
            cancel: self.cancel_token.clone(),
            claimed_start: None,
            claimed_scope: None,
        };
        let witnesses = host.apply_at_boundary(call.clone()).await?;
        if !call.is_current() {
            return Err("peer_target_owner_changed".into());
        }
        for witness in &witnesses {
            if !witness.is_current()
                || !call
                    .owner
                    .same_lifecycle(&witness.target_state().inspection_lifecycle_identity())
            {
                return Err("peer_history_witness_target_changed".into());
            }
        }
        if self.state.peer_input_requires_fresh_user() {
            self.peer_intent_restricted
                .store(true, std::sync::atomic::Ordering::Release);
        }
        Ok(witnesses)
    }
    /// Called by the original host only while it holds the target's idle execution gate.
    /// This neither fabricates a user prompt nor starts/resumes a provider by itself.
    pub async fn apply_peer_messages_at_idle(
        &self,
    ) -> Result<Vec<PeerHistoryCommitWitness>, String> {
        if self.turn_driver_active() {
            return Err("peer_target_has_active_turn".into());
        }
        self.apply_peer_boundary(true).await
    }
    pub async fn peer_idle_wake_authorized(
        &self,
        witnesses: &[PeerHistoryCommitWitness],
    ) -> Result<bool, String> {
        if !witnesses
            .iter()
            .any(PeerHistoryCommitWitness::has_pending_idle_wake_admission)
            || self.turn_driver_active()
            || !self.is_peer_target_owner()
        {
            return Ok(false);
        }
        let Some(host) = self.peer_message_host.as_ref() else {
            return Ok(false);
        };
        let owner = self
            .state
            .try_inspection_lifecycle_identity()
            .ok_or("peer_target_owner_unavailable")?;
        let call = PeerMessageCall {
            state: self.state.clone(),
            owner,
            attempt: self.state.current_history_attempt_identity(),
            idle: true,
            cancel: self.cancel_token.clone(),
            claimed_start: None,
            claimed_scope: None,
        };
        let allowed = host.authorize_idle_wake(call.clone(), witnesses).await?;
        if !call.is_current() {
            return Err("peer_target_owner_changed".into());
        }
        Ok(allowed)
    }

    pub(super) async fn settle_peer_idle_wakes_in_provider_context(
        &self,
        messages: &kcoder_types::SharedMessages,
    ) -> Result<(), String> {
        if !self.is_peer_target_owner()
            || !messages
                .iter()
                .any(kcoder_types::Message::has_peer_agent_metadata)
        {
            return Ok(());
        }
        let Some(host) = self.peer_message_host.as_ref() else {
            return Ok(());
        };
        let owner = self
            .state
            .try_inspection_lifecycle_identity()
            .ok_or("peer_provider_owner_unavailable")?;
        let claimed_start = if self.is_peer_driven_turn() {
            let permit = self
                .peer_auto_wake_start
                .as_ref()
                .ok_or("peer_provider_start_original_permit_required")?;
            let scope = self
                .peer_provider_scope
                .as_ref()
                .ok_or("peer_provider_start_actual_stream_required")?;
            if !self.turn_driver_active() {
                return Err("peer_provider_start_actual_stream_required".into());
            }
            scope
                .bind_current_task(self)
                .map_err(|_| "peer_provider_start_actual_turn_required")?;
            // This actual stream already owns its original permit. Bind that
            // same scope before preflight bookkeeping; binding grants neither
            // fresh Source permission nor a Provider dispatch.
            permit
                .bind_provider_stream(scope.id)
                .map_err(|_| "peer_provider_start_actual_stream_changed")?;
            Some((permit.clone(), scope.id))
        } else {
            None
        };
        let call = PeerMessageCall {
            state: self.state.clone(),
            owner,
            attempt: self.state.current_history_attempt_identity(),
            idle: false,
            cancel: self.cancel_token.clone(),
            claimed_start,
            claimed_scope: self.peer_provider_scope.as_ref().map(Arc::downgrade),
        };
        if let Err(code) = host
            .settle_idle_wakes_in_provider_context(call.clone(), messages)
            .await
        {
            if !matches!(
                self.state
                    .peer_idle_wakes_superseded_by_native_user(&call.owner, messages)
                    .await,
                Ok(true)
            ) {
                return Err(code);
            }
            tracing::warn!("peer_wake_user_context_settlement_deferred");
        }
        if !call.is_current() {
            return Err("peer_provider_owner_changed".into());
        }
        Ok(())
    }

    pub fn is_peer_driven_turn(&self) -> bool {
        self.peer_driven_turn
            .load(std::sync::atomic::Ordering::Acquire)
    }
    pub(super) fn peer_restricts_user_intent(&self) -> bool {
        self.is_peer_driven_turn()
            || self
                .peer_intent_restricted
                .load(std::sync::atomic::Ordering::Acquire)
            || self.state.peer_input_requires_fresh_user()
    }

    /// Clear only with an original current user receipt, never a peer text or
    /// a saved consent flag. A user input before the latest peer cannot clear it.
    pub fn acknowledge_fresh_user_input_for_peer_policy(
        &self,
        input: &kcoder_state::CommittedUserInput,
    ) -> anyhow::Result<()> {
        if !self.is_peer_driven_turn()
            && !self
                .peer_intent_restricted
                .load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(());
        }
        let (mut messages, _, _) = self.state.shared_messages_with_lifecycle();
        let peer = messages
            .iter()
            .rposition(kcoder_types::Message::has_peer_agent_metadata);
        if let Some(peer) = peer {
            messages.remove_range(0..peer + 1);
        }
        anyhow::ensure!(
            input.is_shared_in(&messages) && input.try_is_current()?,
            "fresh original user input is not current for this peer policy"
        );
        self.peer_intent_restricted
            .store(false, std::sync::atomic::Ordering::Release);
        self.peer_driven_turn
            .store(false, std::sync::atomic::Ordering::Release);
        Ok(())
    }
    pub(super) fn peer_turn_engine(&self) -> Self {
        let mut engine = self.clone();
        engine.peer_driven_turn = Arc::new(std::sync::atomic::AtomicBool::new(true));
        engine.peer_provider_scope = Some(Arc::new(
            crate::peer_provider_start::PeerProviderScope::new(),
        ));
        engine
            .peer_intent_restricted
            .store(true, std::sync::atomic::Ordering::Release);
        engine
    }
    pub fn run_peer_message_turn_stream_with_cancel_and_steering<
        'a,
        P: kcoder_permissions::PermissionPrompt,
    >(
        &self,
        prompt: &'a P,
        cancel: tokio_util::sync::CancellationToken,
        steering: crate::TurnSteerSession,
    ) -> std::pin::Pin<Box<dyn futures::Stream<Item = EngineEvent> + Send + 'a>> {
        self.peer_turn_engine()
            .run_turn_stream_with_cancel_and_steering(prompt, cancel, steering)
    }
    pub fn run_peer_message_turn_stream<'a, P: kcoder_permissions::PermissionPrompt>(
        &self,
        prompt: &'a P,
    ) -> std::pin::Pin<Box<dyn futures::Stream<Item = EngineEvent> + Send + 'a>> {
        self.peer_turn_engine().run_turn_stream(prompt)
    }
    pub fn run_native_peer_message_turn_stream<'a, P: kcoder_permissions::PermissionPrompt>(
        &self,
        prompt: &'a P,
    ) -> std::pin::Pin<
        Box<
            dyn futures::Stream<Item = crate::integrations::core::NativeEngineEventFrame>
                + Send
                + 'a,
        >,
    > {
        self.peer_turn_engine()
            .run_native_turn_stream_with_max_turns(prompt, crate::MAX_AGENT_TURNS)
    }
    pub fn run_native_peer_message_turn_stream_with_max_turns<
        'a,
        P: kcoder_permissions::PermissionPrompt,
    >(
        &self,
        prompt: &'a P,
        max_turns: usize,
    ) -> std::pin::Pin<
        Box<
            dyn futures::Stream<Item = crate::integrations::core::NativeEngineEventFrame>
                + Send
                + 'a,
        >,
    > {
        self.peer_turn_engine()
            .run_native_turn_stream_with_max_turns(prompt, max_turns)
    }

    pub(super) async fn apply_peer_messages_at_boundary(
        &self,
    ) -> Result<PeerBoundaryDelivery, String> {
        let witnesses = self.apply_peer_boundary(false).await?;
        let has_fresh_delivery = witnesses
            .iter()
            .any(PeerHistoryCommitWitness::newly_inserted_into_context);
        let events = witnesses
            .into_iter()
            .map(|witness| EngineEvent::PeerAgentMessageAdded {
                history_uuid: witness.history_uuid().to_owned(),
                message: witness.message().clone(),
            })
            .collect();
        Ok(PeerBoundaryDelivery {
            events,
            has_fresh_delivery,
        })
    }
}

#[cfg(test)]
#[path = "tests/peer_message_runtime.rs"]
mod tests;

#[cfg(test)]
pub(crate) async fn run_claimed_validation_test() {
    claimed_validation::tests::run().await;
}
