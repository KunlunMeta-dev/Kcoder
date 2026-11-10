//! Only an actual pending private ticket can publish Accepted before Provider.
use super::*;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_engine::QueryEngine;
use kcoder_state::{AppStateLifecycleIdentity, turn_attempt_store::TurnAttemptStore};
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
use std::sync::{Mutex, Weak};

pub(crate) struct NativeRuntimeAcceptedObserver {
    storage: Arc<RuntimeStorage>,
    ticket: NativeRuntimeTicket,
    context: Arc<NativeIntegrationContext>,
    authority: Arc<dyn NativeRuntimeAuthority>,
    owner: Weak<()>,
    state: AppStateLifecycleIdentity,
    thread: String,
    intent: String,
    request_fingerprint: String,
    accepted: Mutex<Option<TurnAttemptIdentity>>,
}
impl std::fmt::Debug for NativeRuntimeAcceptedObserver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeRuntimeAcceptedObserver { actual_private_ticket: bound }")
    }
}
impl NativeRuntimeDriver {
    pub(crate) fn accepted_observer(
        &self,
        context: &NativeIntegrationContext,
        ticket: &NativeRuntimeTicket,
        engine: &QueryEngine,
        params: &serde_json::Value,
        authority: Arc<dyn NativeRuntimeAuthority>,
        owner: Weak<()>,
    ) -> Result<NativeRuntimeAcceptedObserver> {
        self.check(context)?;
        ensure!(
            self.is_pending(ticket) && ticket.phase() == RuntimePhase::TurnDispatched,
            "RUNTIME_ACCEPTED_TICKET_REQUIRED"
        );
        let binding = self
            .storage()
            .bindings()
            .get(ticket.operation_id())?
            .context("RUNTIME_BINDING_MISSING")?;
        ensure!(
            binding.phase == RuntimePhase::TurnDispatched
                && binding.acceptance.is_none()
                && binding.thread_id.as_deref() == Some(engine.session_id().as_str()),
            "RUNTIME_ACCEPTED_OWNER_REQUIRED"
        );
        let params: kcoder_app_protocol::TurnStartParams = rpc_codec::decode(params.clone())?;
        ensure!(
            params.thread_id == engine.session_id()
                && params.client_message_id.as_deref() == Some(binding.client_message_id.as_str()),
            "RUNTIME_ACCEPTED_REQUEST_REQUIRED"
        );
        authority.verify_admission(context, &binding.original_request, &binding.spec)?;
        ensure!(owner.upgrade().is_some(), "RUNTIME_ACCEPTED_OWNER_CLOSED");
        Ok(NativeRuntimeAcceptedObserver {
            storage: self.storage().clone(),
            ticket: ticket.clone(),
            context: Arc::new(context.recapture_for_owned_service()?),
            authority,
            owner,
            state: engine.state.inspection_lifecycle_identity(),
            thread: engine.session_id(),
            intent: binding.intent_sha256,
            request_fingerprint: crate::app_server::turn_attempts::request_fingerprint(&params)?,
            accepted: Mutex::new(None),
        })
    }
}
impl NativeRuntimeAcceptedObserver {
    /// Recheck only the captured in-process owner while the resident gate is
    /// held. The earlier and later private source checks remain mandatory.
    pub(crate) fn try_matches_resident(&self, engine: &QueryEngine) -> Option<bool> {
        if self.owner.upgrade().is_none() {
            return Some(false);
        }
        self.state.try_matches(&engine.state)
    }

    /// Reject a foreign entry before creating an attempt or appending its input.
    pub(crate) fn verify_before_accept(
        &self,
        engine: &QueryEngine,
        params: &kcoder_app_protocol::TurnStartParams,
    ) -> Result<()> {
        let binding = self.verified_request_binding(engine, params)?;
        ensure!(
            params.input == binding.spec.input
                && !params
                    .input
                    .iter()
                    .any(|input| matches!(input, kcoder_app_protocol::UserInput::Image { .. })),
            "RUNTIME_ACCEPTED_REQUEST_CHANGED"
        );
        Ok(())
    }

    fn verified_request_binding(
        &self,
        engine: &QueryEngine,
        params: &kcoder_app_protocol::TurnStartParams,
    ) -> Result<RuntimeBinding> {
        let binding = self.verified_current_binding(&self.context, engine)?;
        ensure!(
            params.thread_id == self.thread
                && crate::app_server::turn_attempts::request_fingerprint(params)?
                    == self.request_fingerprint,
            "RUNTIME_ACCEPTED_REQUEST_CHANGED"
        );
        Ok(binding)
    }
    /// Runs only inside the original owned Accepted job. Optional async source
    /// facts never replace the original private ticket, State or signature checks.
    pub(crate) async fn verify_live_accepted_source(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        identity: &TurnAttemptIdentity,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<()> {
        let binding = self.verified_current_binding(&self.context, engine)?;
        self.verify_live_source_from_binding(context, engine, identity, cancel, &binding)
            .await
    }

    async fn verify_live_source_from_binding(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        identity: &TurnAttemptIdentity,
        cancel: &tokio_util::sync::CancellationToken,
        binding: &RuntimeBinding,
    ) -> Result<()> {
        ensure!(!cancel.is_cancelled(), "RUNTIME_CURRENT_SOURCE_CANCELLED");
        if let Some(source) = self.authority.current_source() {
            let owned_cancel = cancel.child_token();
            let _cancel_on_drop = owned_cancel.clone().drop_guard();
            tokio::select! { biased;
                _ = cancel.cancelled() => anyhow::bail!("RUNTIME_CURRENT_SOURCE_CANCELLED"),
                result = tokio::time::timeout(
                    std::time::Duration::from_millis(binding.original_request.timeout_ms.min(30_000)),
                    source.verify_current_source(&self.context, &binding.original_request, &binding.spec, &owned_cancel),
                ) => result.map_err(|_| anyhow::anyhow!("RUNTIME_CURRENT_SOURCE_UNCONFIRMED"))??,
            }
        }
        ensure!(!cancel.is_cancelled(), "RUNTIME_CURRENT_SOURCE_CANCELLED");
        if !std::ptr::eq(context, self.context.as_ref()) {
            self.context.verify()?;
        }
        self.verify_accepted(context, engine, identity)
    }

    /// Only authorities with an actual async current-source port need this
    /// earlier receipt publication. Existing authorities retain their old flow.
    pub(crate) async fn admit_current_source(
        &self,
        engine: &QueryEngine,
        identity: &TurnAttemptIdentity,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<()> {
        if self.authority.current_source().is_none() {
            return self.verify_current(&self.context, engine);
        }
        // Use the binding just checked after the durable Accepted commit.
        // The source read and the post-await receipt checks are still required.
        let binding = self.observe_accepted_binding(&self.context, engine, identity)?;
        self.verify_live_source_from_binding(&self.context, engine, identity, cancel, &binding)
            .await
    }

    pub(crate) fn context(&self) -> &NativeIntegrationContext {
        &self.context
    }
    pub(crate) fn retain_context(&self) -> Result<Arc<NativeIntegrationContext>> {
        self.context.retain_for_checked_operation()
    }
    pub(crate) fn operation_id(&self) -> &str {
        self.ticket.operation_id()
    }

    pub(crate) fn initial_task_capability_scope_selection(
        &self,
    ) -> Result<IntegrationTaskCapabilityScopeSelection> {
        ensure!(
            self.owner.upgrade().is_some(),
            "RUNTIME_ACCEPTED_OWNER_CLOSED"
        );
        self.context.verify()?;
        self.binding()?;
        Ok(IntegrationTaskCapabilityScopeSelection {
            mode: IntegrationTaskCapabilityScopeMode::InheritCurrent,
            sources: vec![],
        })
    }
    pub(crate) fn initial_task_capability_scope_operation(
        &self,
        identity: &TurnAttemptIdentity,
    ) -> Result<String> {
        Ok(format!(
            "source-initial-runtime-{}",
            hash(&serde_json::to_vec(&(
                self.ticket.operation_id(),
                identity,
            ))?)
        ))
    }

    pub(crate) fn verify_current(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
    ) -> Result<()> {
        self.verified_current_binding(context, engine).map(|_| ())
    }

    fn verified_current_binding(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
    ) -> Result<RuntimeBinding> {
        ensure!(
            self.owner.upgrade().is_some()
                && self.state.matches(&engine.state)
                && self.thread == engine.session_id(),
            "RUNTIME_ACCEPTED_OWNER_CHANGED"
        );
        context.validate_scope(self.context.scope())?;
        self.storage.verify_ledger()?;
        let binding = self.binding()?;
        context.validate_scope(&binding.source_scope)?;
        self.authority
            .verify_admission(context, &binding.original_request, &binding.spec)?;
        Ok(binding)
    }

    fn binding(&self) -> Result<RuntimeBinding> {
        let binding = self
            .storage
            .bindings()
            .get(self.ticket.operation_id())?
            .context("RUNTIME_BINDING_MISSING")?;
        ensure!(
            binding.intent_sha256 == self.intent
                && binding.thread_id.as_deref() == Some(self.thread.as_str())
                && (binding.phase == RuntimePhase::TurnDispatched
                    || binding.phase == RuntimePhase::Accepted),
            "RUNTIME_ACCEPTED_BINDING_CHANGED"
        );
        Ok(binding)
    }

    fn verify_attempt(&self, engine: &QueryEngine, identity: &TurnAttemptIdentity) -> Result<()> {
        ensure!(
            identity.thread_id == self.thread
                && engine.state.matches_current_history_attempt(Some(identity)),
            "RUNTIME_ACTUAL_ACCEPTED_SCOPE_REQUIRED"
        );
        let store = TurnAttemptStore::open_existing(
            &engine.session_storage_dir_for(&self.thread),
            &self.thread,
        )?
        .context("RUNTIME_ACTUAL_ACCEPTED_REQUIRED")?;
        let record = store
            .load(identity)?
            .context("RUNTIME_ACTUAL_ACCEPTED_REQUIRED")?;
        record.validate()?;
        ensure!(
            record.identity == *identity
                && record.status == TurnAttemptStatus::Accepted
                && record.parent_attempt_id.is_none()
                && record.request_fingerprint.as_deref() == Some(self.request_fingerprint.as_str()),
            "RUNTIME_ACTUAL_ACCEPTED_CHANGED"
        );
        Ok(())
    }

    pub(crate) fn observe_accepted(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        identity: &TurnAttemptIdentity,
    ) -> Result<()> {
        self.observe_accepted_binding(context, engine, identity)
            .map(|_| ())
    }

    fn observe_accepted_binding(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        identity: &TurnAttemptIdentity,
    ) -> Result<RuntimeBinding> {
        let mut original = self
            .accepted
            .lock()
            .map_err(|_| anyhow::anyhow!("RUNTIME_ACCEPTED_UNAVAILABLE"))?;
        ensure!(
            original.as_ref().is_none_or(|old| old == identity),
            "RUNTIME_ACCEPTED_IDENTITY_CHANGED"
        );
        let binding = self.verified_current_binding(context, engine)?;
        self.verify_attempt(engine, identity)?;
        if original.is_some() {
            self.verify_original_receipt(&binding, identity)?;
            return Ok(binding);
        }
        let acceptance = IntegrationRuntimeAcceptance {
            thread_id: identity.thread_id.clone(),
            turn_id: Some(identity.turn_id.clone()),
            task_id: None,
            state: IntegrationTaskState::Running,
        };
        self.storage.accept(binding, acceptance)?;
        *original = Some(identity.clone());
        let binding = self.verified_current_binding(context, engine)?;
        self.verify_attempt(engine, identity)?;
        Ok(binding)
    }

    pub(crate) fn verify_accepted(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        identity: &TurnAttemptIdentity,
    ) -> Result<()> {
        ensure!(
            self.accepted
                .lock()
                .map_err(|_| anyhow::anyhow!("RUNTIME_ACCEPTED_UNAVAILABLE"))?
                .as_ref()
                == Some(identity),
            "RUNTIME_ACTUAL_ACCEPTED_REQUIRED"
        );
        let binding = self.verified_current_binding(context, engine)?;
        self.verify_attempt(engine, identity)?;
        self.verify_original_receipt(&binding, identity)
    }

    fn verify_original_receipt(
        &self,
        binding: &RuntimeBinding,
        identity: &TurnAttemptIdentity,
    ) -> Result<()> {
        let expected = IntegrationRuntimeAcceptance {
            thread_id: identity.thread_id.clone(),
            turn_id: Some(identity.turn_id.clone()),
            task_id: None,
            state: IntegrationTaskState::Running,
        };
        let receipt = self
            .storage
            .read_receipt(self.ticket.operation_id())?
            .context("RUNTIME_OPERATION_MISSING")?;
        ensure!(
            binding.acceptance.as_ref() == Some(&expected)
                && receipt.runtime_acceptance.as_ref() == Some(&expected),
            "RUNTIME_ACCEPTANCE_UNCONFIRMED"
        );
        Ok(())
    }
}
