//! Original peer admission and same-turn continuation both recheck live authority.
use crate::QueryEngine;
use crate::peer_message_runtime::PeerMessageCall;
use std::sync::Arc;

mod invocation;
mod provider;
pub(crate) use provider::strip_inherited_provider;

const ORIGINAL_READ_ATTEMPTS: usize = 16;
const ORIGINAL_READ_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(25);

#[derive(Debug)]
pub(super) struct OwnedTurnBusy;
impl std::fmt::Display for OwnedTurnBusy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("target_turn_owner_busy")
    }
}
impl std::error::Error for OwnedTurnBusy {}
fn ownership_error(code: &'static str) -> anyhow::Error {
    if code == "target_turn_owner_busy" {
        anyhow::Error::new(OwnedTurnBusy)
    } else {
        anyhow::Error::msg(code)
    }
}

pub(super) struct PeerProviderScope {
    pub(super) id: uuid::Uuid,
    turn: std::sync::OnceLock<crate::owned_turn::OwnedTurnWitness>,
    response: std::sync::OnceLock<PeerModelResponseFact>,
    invocations: Arc<invocation::Invocations>,
    checks: tokio::sync::Mutex<()>,
    #[cfg(test)]
    waiting_checks: std::sync::atomic::AtomicUsize,
}
// Only a real poll of the already dispatched, bound Provider records this
// nonempty payload fact. It is not a live authorization decision: a temporarily
// busy owner may leave it pending, and every use rechecks the original weak
// turn, native permit and current Source. It retains no strong turn owner.
struct PeerModelResponseFact {
    stream: uuid::Uuid,
    turn: crate::owned_turn::OwnedTurnWitness,
}
impl PeerProviderScope {
    pub(super) fn verify_read_tool_batch(
        &self,
        state: &kcoder_state::AppState,
        owner: &kcoder_state::AppStateLifecycleIdentity,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.invocations.tools_active(),
            "peer_read_wake_tool_batch_required"
        );
        self.verify_live_response(state, owner, self.id)
    }
    pub(super) fn new() -> Self {
        Self {
            id: uuid::Uuid::new_v4(),
            turn: std::sync::OnceLock::new(),
            response: std::sync::OnceLock::new(),
            invocations: Arc::default(),
            checks: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            waiting_checks: std::sync::atomic::AtomicUsize::new(0),
        }
    }
    async fn checks_for<'a>(
        &'a self,
        engine: &QueryEngine,
    ) -> Result<tokio::sync::MutexGuard<'a, ()>, String> {
        #[cfg(test)]
        struct Waiting<'a>(&'a std::sync::atomic::AtomicUsize);
        #[cfg(test)]
        impl Drop for Waiting<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
            }
        }
        #[cfg(test)]
        let _waiting = {
            self.waiting_checks
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            Waiting(&self.waiting_checks)
        };
        loop {
            tokio::select! { biased;
                _=engine.cancel_token().cancelled_owned()=>return Err("peer_provider_start_cancelled".into()),
                checks=self.checks.lock()=>return Ok(checks),
                _=tokio::time::sleep(std::time::Duration::from_millis(25))=> {
                    match self.bind_current_task(engine) {
                        Ok(())|Err("target_turn_owner_busy")=>{}
                        Err(code)=>return Err(code.into()),
                    }
                }
            }
        }
    }
    fn observe_model_response(
        &self,
        permit: &kcoder_state::PeerAutoWakePermit,
        event: &kcoder_types::StreamEvent,
    ) {
        // A body-free SDK progress marker is useful for its idle watchdog, but
        // cannot establish the first nonempty response used by this witness.
        if matches!(event, kcoder_types::StreamEvent::ToolCallProgress)
            || !crate::stream::initial_model_progress(event)
            || permit.provider_dispatch_pending()
            || !permit.matches_provider_stream(self.id)
        {
            return;
        }
        if let Some(turn) = self.turn.get() {
            let _ = self.response.set(PeerModelResponseFact {
                stream: self.id,
                turn: turn.clone(),
            });
        }
    }
    pub(super) fn bind_current_task(&self, engine: &QueryEngine) -> Result<(), &'static str> {
        if self.turn.get().is_none() {
            let observed = engine.owned_turns.witness_current_task(&engine.state)?;
            let _ = self.turn.set(observed);
        }
        self.turn
            .get()
            .ok_or("target_turn_changed")?
            .verify_current_task(&engine.state)
    }
}
impl PeerProviderScope {
    pub(super) fn verify_registered(
        &self,
        state: &kcoder_state::AppState,
        owner: &kcoder_state::AppStateLifecycleIdentity,
    ) -> anyhow::Result<()> {
        self.turn
            .get()
            .ok_or_else(|| anyhow::anyhow!("PEER_WAKE_PROVIDER_SCOPE_CLOSED"))?
            .verify(state, owner)
            .map_err(ownership_error)
    }
    pub(super) fn verify_live_response(
        &self,
        state: &kcoder_state::AppState,
        owner: &kcoder_state::AppStateLifecycleIdentity,
        stream: uuid::Uuid,
    ) -> anyhow::Result<()> {
        let response = self
            .response
            .get()
            .ok_or_else(|| anyhow::anyhow!("PEER_WAKE_PROVIDER_RESPONSE_REQUIRED"))?;
        anyhow::ensure!(
            self.id == stream && response.stream == stream,
            "PEER_WAKE_PROVIDER_SCOPE_CHANGED"
        );
        response.turn.verify(state, owner).map_err(ownership_error)
    }
}

struct StartRejection {
    stage: &'static str,
    reason: &'static str,
    public_code: String,
    busy: bool,
}
impl StartRejection {
    fn native(stage: &'static str, error: anyhow::Error) -> Self {
        let owner_busy = error.downcast_ref::<OwnedTurnBusy>().is_some();
        let busy =
            owner_busy || kcoder_state::PeerAutoWakePermit::is_temporary_start_contention(&error);
        #[cfg(test)]
        if owner_busy {
            eprintln!(
                "Owned continuation read deferred: stage={stage}, code=target_turn_owner_busy"
            );
        }
        Self {
            stage,
            reason: if owner_busy {
                "target_turn_owner_busy"
            } else {
                kcoder_state::PeerAutoWakePermit::start_failure_reason(&error)
            },
            public_code: if busy {
                "peer_provider_start_original_read_busy"
            } else {
                "peer_provider_start_permit_not_current"
            }
            .into(),
            busy,
        }
    }
    fn scope(stage: &'static str, code: &'static str) -> Self {
        let mut rejection = Self::hard(stage, code);
        rejection.busy = code == "target_turn_owner_busy";
        if rejection.busy {
            rejection.public_code = "peer_provider_start_original_read_busy".into();
        }
        rejection
    }
    fn hard(stage: &'static str, code: &str) -> Self {
        let reason = match code {
            "peer_provider_start_owner_changed" => "peer_provider_start_owner_changed",
            "peer_provider_start_original_permit_not_current" => {
                "peer_provider_start_original_permit_not_current"
            }
            "peer_provider_start_original_record_unavailable" => {
                "peer_provider_start_original_record_unavailable"
            }
            "peer_provider_start_original_message_changed" => {
                "peer_provider_start_original_message_changed"
            }
            "peer_provider_start_current_authorization_required" => {
                "peer_provider_start_current_authorization_required"
            }
            "peer_wake_authorization_deferred" => "peer_wake_authorization_deferred",
            "peer_wake_owner_changed" => "peer_wake_owner_changed",
            "peer_provider_start_cancelled" => "peer_provider_start_cancelled",
            _ => "peer_provider_start_unconfirmed",
        };
        Self {
            stage,
            reason,
            public_code: code.into(),
            busy: code == "peer_provider_start_original_read_busy",
        }
    }
}

impl QueryEngine {
    /// The original host transfers its one native permit into this one turn
    /// clone. Ordinary User engines and restored processes have no such proof.
    pub fn with_peer_auto_wake_start_permit(
        mut self,
        permit: Box<kcoder_state::PeerAutoWakePermit>,
    ) -> Result<Self, String> {
        permit
            .verify_provider_binding(&self.state)
            .map_err(|_| "peer_provider_start_permit_not_current".to_owned())?;
        if !permit.provider_dispatch_pending() {
            return Err("peer_provider_start_already_dispatched".into());
        }
        self.peer_auto_wake_start = Some(Arc::from(permit));
        Ok(self)
    }

    /// Keep the exact original Box while known pre-begin reads contend. The
    /// worker cannot dispatch a Provider or create another claim, and is joined
    /// even when cancellation arrives during its bounded native read.
    pub async fn prepare_peer_auto_wake_start(
        self,
        mut permit: Box<kcoder_state::PeerAutoWakePermit>,
    ) -> Result<Self, String> {
        for attempt in 0..ORIGINAL_READ_ATTEMPTS {
            if self.is_cancelled() {
                return Err("peer_provider_start_cancelled".into());
            }
            let (original, checked) = tokio::task::spawn_blocking(move || {
                let checked = permit.try_begin();
                (permit, checked)
            })
            .await
            .map_err(|_| "peer_provider_start_begin_unknown".to_owned())?;
            permit = original;
            if self.is_cancelled() {
                return Err("peer_provider_start_cancelled".into());
            }
            match checked {
                Ok(true) => return self.with_peer_auto_wake_start_permit(permit),
                Ok(false) => return Err("peer_provider_start_already_begun".into()),
                Err(error)
                    if attempt + 1 < ORIGINAL_READ_ATTEMPTS
                        && permit.can_retry_begin_after_contention(&error) =>
                {
                    tokio::select! {
                        biased;
                        _ = self.cancel_token().cancelled_owned() => return Err("peer_provider_start_cancelled".into()),
                        _ = tokio::time::sleep(ORIGINAL_READ_RETRY_DELAY) => {}
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        stage = "peer_original_permit_begin",
                        reason = kcoder_state::PeerAutoWakePermit::start_failure_reason(&error),
                        known_busy =
                            kcoder_state::PeerAutoWakePermit::is_temporary_start_contention(&error),
                        "Original peer permit did not begin"
                    );
                    return Err("peer_provider_start_begin_unconfirmed".into());
                }
            }
        }
        Err("peer_provider_start_begin_unconfirmed".into())
    }

    pub(super) async fn authorize_peer_provider_start(&self) -> Result<(), String> {
        if !self.is_peer_driven_turn() {
            return Ok(());
        }
        if self.is_cancelled() {
            return Err("peer_provider_start_cancelled".into());
        }
        if self.agent_depth() != 0 || !self.is_peer_target_owner() {
            return Err("peer_provider_start_owner_ineligible".into());
        }
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
        // Native receipt/history readers can contend within one original
        // permit. Serialize only fresh authorization, never tool execution.
        let _checks = scope.checks_for(self).await?;
        // This invocation has not called its inner Provider. Rechecking native
        // facts cannot replay an earlier successful request in the same stream.
        for attempt in 0..ORIGINAL_READ_ATTEMPTS {
            match self
                .authorize_peer_provider_invocation(permit.clone(), scope.id)
                .await
            {
                Ok(()) => return Ok(()),
                Err(rejection) => {
                    tracing::warn!(stage = rejection.stage, code = rejection.reason,
                        known_busy = rejection.busy, scope = %scope.id,
                        dispatch_previously_started = !permit.provider_dispatch_pending(),
                        "Original peer Provider invocation was not dispatched");
                    if rejection.busy
                        && attempt + 1 < ORIGINAL_READ_ATTEMPTS
                        && !self.is_cancelled()
                    {
                        tokio::select! {
                            biased;
                            _ = self.cancel_token().cancelled_owned() => return Err("peer_provider_start_cancelled".into()),
                            _ = tokio::time::sleep(ORIGINAL_READ_RETRY_DELAY) => {}
                        }
                    } else {
                        return Err(rejection.public_code);
                    }
                }
            }
        }
        Err("peer_provider_start_permit_not_current".into())
    }

    pub(super) async fn authorize_peer_tool_continuation(&self) -> Result<(), String> {
        if !self.is_peer_driven_turn() {
            return Ok(());
        }
        let scope = self
            .peer_provider_scope
            .as_ref()
            .ok_or("peer_provider_start_actual_stream_required")?;
        if scope.invocations.provider_active() {
            return Err("peer_provider_invocation_busy".into());
        }
        self.require_peer_tool_scope().await?;
        self.authorize_peer_provider_start().await
    }

    async fn require_peer_tool_scope(&self) -> Result<Arc<PeerProviderScope>, String> {
        let scope = self
            .peer_provider_scope
            .as_ref()
            .ok_or("peer_provider_start_actual_stream_required")?;
        let _checks = scope.checks_for(self).await?;
        for attempt in 0..3 {
            if self.is_cancelled() {
                return Err("peer_provider_start_cancelled".into());
            }
            let checked = (|| -> anyhow::Result<()> {
                scope.bind_current_task(self).map_err(ownership_error)?;
                let owner = self
                    .state
                    .try_inspection_lifecycle_identity()
                    .ok_or_else(|| anyhow::anyhow!("peer_provider_start_owner_unavailable"))?;
                scope.verify_live_response(&self.state, &owner, scope.id)
            })();
            match checked {
                Ok(()) => return Ok(scope.clone()),
                Err(error) if error.downcast_ref::<OwnedTurnBusy>().is_some() && attempt < 2 => {
                    tokio::select! { biased;
                        _=self.cancel_token().cancelled_owned()=>return Err("peer_provider_start_cancelled".into()),
                        _=tokio::time::sleep(std::time::Duration::from_millis(2))=>{}
                    }
                }
                Err(_) => return Err("peer_provider_response_required".into()),
            }
        }
        Err("peer_provider_response_required".into())
    }

    pub(super) async fn begin_peer_tool_invocation(
        &self,
    ) -> Result<Option<invocation::Invocation>, String> {
        if !self.is_peer_driven_turn() {
            return Ok(None);
        }
        let scope = self.require_peer_tool_scope().await?;
        scope.invocations.tools().map(Some).map_err(str::to_owned)
    }

    async fn authorize_peer_provider_invocation(
        &self,
        permit: Arc<kcoder_state::PeerAutoWakePermit>,
        scope: uuid::Uuid,
    ) -> Result<(), StartRejection> {
        let original_scope = self
            .peer_provider_scope
            .as_ref()
            .filter(|original| original.id == scope)
            .ok_or_else(|| {
                StartRejection::hard("native_scope", "peer_provider_scope_turn_changed")
            })?;
        original_scope
            .bind_current_task(self)
            .map_err(|code| StartRejection::scope("native_scope", code))?;
        permit.bind_provider_stream(scope).map_err(|_| {
            StartRejection::hard(
                "native_stream_binding",
                "peer_provider_start_permit_already_owned",
            )
        })?;
        let proof = permit.clone();
        let state = self.state.clone();
        let continuation = original_scope.clone();
        let owner =
            tokio::task::spawn_blocking(move || match proof.checked_provider_owner(&state) {
                Ok(owner) => Ok(owner),
                Err(error)
                    if kcoder_state::PeerAutoWakePermit::start_failure_reason(&error)
                        == "PEER_WAKE_PERMIT_EXPIRED"
                        && !proof.provider_dispatch_pending() =>
                {
                    let owner = state
                        .try_inspection_lifecycle_identity()
                        .ok_or_else(|| anyhow::anyhow!("PEER_WAKE_PERMIT_STATE_BUSY"))?;
                    continuation.verify_live_response(&state, &owner, scope)?;
                    proof.observed_provider_budget_owner(&state)
                }
                Err(error) => Err(error),
            })
            .await
            .map_err(|_| {
                StartRejection::hard("native_owner_worker", "peer_provider_start_begin_unknown")
            })?
            .map_err(|error| StartRejection::native("native_original_permit", error))?;
        permit.bind_provider_stream(scope).map_err(|_| {
            StartRejection::hard(
                "native_stream_binding",
                "peer_provider_start_permit_already_owned",
            )
        })?;
        let host = self.peer_message_host.as_ref().ok_or_else(|| {
            StartRejection::hard("current_host", "peer_provider_start_current_host_required")
        })?;
        let call = PeerMessageCall::claimed_provider_start(
            self.state.clone(),
            owner,
            permit.clone(),
            original_scope.clone(),
            self.cancel_token(),
        );
        host.authorize_claimed_provider_start(call.clone(), &permit)
            .await
            .map_err(|code| StartRejection::hard("fresh_source_host", &code))?;
        match self.state.try_check_lifecycle_identity(call.owner()) {
            Ok(Some(true)) => {}
            Ok(None) => {
                return Err(StartRejection::native(
                    "post_source_owner",
                    anyhow::anyhow!("PEER_WAKE_PERMIT_STATE_BUSY"),
                ));
            }
            _ => {
                return Err(StartRejection::hard(
                    "post_source_owner",
                    "peer_provider_start_owner_changed",
                ));
            }
        }
        if self.is_cancelled() {
            return Err(StartRejection::hard(
                "cancellation",
                "peer_provider_start_cancelled",
            ));
        }
        original_scope
            .bind_current_task(self)
            .map_err(|code| StartRejection::scope("native_scope", code))?;
        if !permit.provider_dispatch_pending() {
            call.verify_current_provider_invocation(&permit)
                .map_err(|error| StartRejection::native("native_continuation", error))?;
            return Ok(());
        }
        let state = self.state.clone();
        let owner = call.owner().clone();
        tokio::task::spawn_blocking(move || permit.try_mark_provider_dispatched(&state, &owner))
            .await
            .map_err(|_| {
                StartRejection::hard("dispatch_worker", "peer_provider_start_begin_unknown")
            })?
            .map_err(|error| StartRejection::native("native_dispatch_mark", error))?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "tests/peer_provider_start.rs"]
mod tests;
