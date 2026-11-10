//! Persist native remote-operation receipts around the original owned effects.
use crate::{NativeOperations, receiver_history};
use anyhow::{Context, Result, ensure};
use kcoder_acp::outbound::{InstalledOutboundRunner, OutboundEffect, OutboundHost};
use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use kcoder_state::integrations::core::remote_delegations::{
    NativeRemoteDelegationStore, NativeRemoteDispatch, NativeRemoteObservation, NativeRemotePlan,
    NativeRemoteStage,
};
use kcoder_types::integrations::core::{IntegrationOperationPhase, IntegrationRequest};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    sync::{Arc, Mutex},
};

/// Actual native source/recipient facts and narrow policy. No JSON implementation exists.
/// The production constructor must bind a real original accepted caller and a verified receiver.
pub trait NativeRemoteAuthority: Send + Sync {
    fn check_owned_native_control(&self, _context: &NativeIntegrationContext) -> Result<()> {
        anyhow::bail!("REMOTE_NATIVE_OWNED_CONTROL_UNAVAILABLE")
    }
    fn verify_owned_native_material(&self, _request: &Value) -> Result<()> {
        anyhow::bail!("REMOTE_NATIVE_MATERIAL_UNAVAILABLE")
    }
    fn material_intent(&self) -> Result<Value> {
        anyhow::bail!("REMOTE_NATIVE_MATERIAL_UNAVAILABLE")
    }
    fn material_receipt(&self) -> Result<Value> {
        anyhow::bail!("REMOTE_NATIVE_MATERIAL_UNAVAILABLE")
    }
    fn check_owned_native_observation(&self, _context: &NativeIntegrationContext) -> Result<()> {
        anyhow::bail!("REMOTE_NATIVE_OWNED_READ_UNAVAILABLE")
    }
    fn verify_owned_native_read(&self, _request: &Value) -> Result<()> {
        anyhow::bail!("REMOTE_NATIVE_OWNED_READ_UNAVAILABLE")
    }
    fn admit_owned_native_cancel(&self, _session: &Value) -> Result<()> {
        anyhow::bail!("REMOTE_NATIVE_OWNED_CANCEL_UNAVAILABLE")
    }
    fn check_owned_native_close(&self, _context: &NativeIntegrationContext) -> Result<()> {
        anyhow::bail!("REMOTE_NATIVE_OWNED_CLOSE_UNAVAILABLE")
    }
    fn verify_owned_native_close(&self, _intent: &Value) -> Result<()> {
        anyhow::bail!("REMOTE_NATIVE_OWNED_CLOSE_UNAVAILABLE")
    }
    fn admit_owned_native_close(&self, _intent: &Value) -> Result<()> {
        anyhow::bail!("REMOTE_NATIVE_OWNED_CLOSE_UNAVAILABLE")
    }
    fn verify_owned_native_close_receipt(&self, _receipt: &Value) -> Result<()> {
        anyhow::bail!("REMOTE_NATIVE_OWNED_CLOSE_UNAVAILABLE")
    }
    fn observe_owned_native_close(&self, _receipt: &Value) -> Result<()> {
        anyhow::bail!("REMOTE_NATIVE_OWNED_CLOSE_UNAVAILABLE")
    }
    fn owned_endpoint_instance_id(&self) -> Option<&str> {
        None
    }
    fn verify_owned_frame_transport(
        &self,
        _transport: &dyn kcoder_acp::outbound::OwnedNativeFrameTransport,
    ) -> Result<()> {
        anyhow::bail!("REMOTE_NATIVE_OWNED_TRANSPORT_UNAVAILABLE")
    }
    fn verify_owned_native_bind(&self, _intent: &Value) -> Result<()> {
        anyhow::bail!("REMOTE_NATIVE_OWNED_BIND_UNAVAILABLE")
    }
    fn verify_owned_native_bind_receipt(&self, _receipt: &Value) -> Result<()> {
        anyhow::bail!("REMOTE_NATIVE_OWNED_BIND_UNAVAILABLE")
    }
    fn observe_owned_native_bind(&self, _receipt: &Value) -> Result<()> {
        anyhow::bail!("REMOTE_NATIVE_OWNED_BIND_UNAVAILABLE")
    }
    fn handle_owned_native_control<'a>(
        &'a self,
        _frame: &'a Value,
    ) -> kcoder_acp::outbound::OwnedNativeControlFuture<'a> {
        Box::pin(async { Ok(None) })
    }
    fn handle_owned_native_settlement<'a>(
        &'a self,
        _frame: &'a Value,
    ) -> kcoder_acp::outbound::OwnedNativeControlFuture<'a> {
        Box::pin(async { anyhow::bail!("REMOTE_NATIVE_OWNED_SETTLEMENT_UNAVAILABLE") })
    }
    fn original_attempt(&self) -> &kcoder_types::TurnAttemptIdentity;
    fn verify_original_tool(
        &self,
        engine_state: &kcoder_state::AppState,
        tool_state: &kcoder_state::AppState,
        tool_call_id: Option<&str>,
        is_aborted: &dyn Fn() -> bool,
    ) -> Result<()>;
    fn check_current(&self, context: &NativeIntegrationContext) -> Result<()>;
    fn verify_runner(
        &self,
        context: &NativeIntegrationContext,
        runner: &InstalledOutboundRunner,
    ) -> Result<()>;
    fn check_frozen_intent(&self, stage: OutboundEffect, actual: &Value) -> Result<()>;
    fn observe_receipt(&self, stage: OutboundEffect, safe: &Value) -> Result<()>;
    fn recipient_revision(&self) -> &str;
    fn recipient_identity(&self) -> &Value;
    fn deadline(&self) -> tokio::time::Instant;
}

pub struct NativeRemoteJournal {
    context: NativeIntegrationContext,
    guard: NativeDomainGuard,
    store: NativeRemoteDelegationStore,
    operations: NativeOperations,
    operation_id: String,
    authority: Arc<dyn NativeRemoteAuthority>,
    dispatches: Mutex<BTreeMap<NativeRemoteStage, NativeRemoteDispatch>>,
}
impl std::fmt::Debug for NativeRemoteJournal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeRemoteJournal { original_native_operation: bound }")
    }
}
impl NativeRemoteJournal {
    pub fn context(&self) -> &NativeIntegrationContext {
        &self.context
    }

    pub fn store(&self) -> &NativeRemoteDelegationStore {
        &self.store
    }

    pub fn authority(&self) -> &dyn NativeRemoteAuthority {
        self.authority.as_ref()
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub fn finish_owned_material_transfer(&self) -> Result<()> {
        self.check_current()?;
        let receipt = self.authority.material_receipt()?;
        let permits = self
            .dispatches
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_DISPATCH_UNAVAILABLE"))?;
        self.store.receive(
            permits
                .get(&NativeRemoteStage::InputTransfer)
                .context("REMOTE_ORIGINAL_DISPATCH_MISSING")?,
            &receipt,
        )?;
        Ok(())
    }
    pub fn record_owned_endpoint_cleanup(
        self: &Arc<Self>,
        receipt: &kcoder_acp::outbound::OutboundCleanup,
    ) -> Result<()> {
        ensure!(
            receipt.belongs_to(self),
            "REMOTE_ORIGINAL_CLEANUP_OWNER_MISMATCH"
        );
        let endpoint = self
            .authority
            .owned_endpoint_instance_id()
            .context("REMOTE_ORIGINAL_ENDPOINT_REQUIRED")?;
        self.store
            .record_endpoint_cleanup(&self.operation_id, endpoint, receipt.confirmed())?;
        let observed = self
            .store
            .read(&self.operation_id)?
            .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
        if receipt.confirmed()
            && observed.endpoint_receiver.as_ref().is_some_and(|receiver| {
                receiver.outcome
                    == Some(
                        kcoder_types::integrations::core::NativeRemoteCallOutcomeV1::Interrupted,
                    )
            })
        {
            let original = self
                .operations
                .read(&self.context, &self.operation_id)?
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
            if original.phase == IntegrationOperationPhase::CancelRequested {
                self.operations.transition(
                    &self.context,
                    &original,
                    IntegrationOperationPhase::Cancelled,
                    None,
                )?;
            }
        }
        Ok(())
    }
    /// Authorized original write only. Existing operation observations never create another runner.
    pub fn begin(
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        authority: Arc<dyn NativeRemoteAuthority>,
    ) -> Result<Self> {
        context.validate_scope(&request.scope)?;
        request.validate(true)?;
        ensure!(
            context.scope().organization_id.is_none(),
            "REMOTE_ORGANIZATION_POLICY_UNAVAILABLE"
        );
        authority.check_current(context)?;
        let operation_id = request
            .operation_id
            .as_ref()
            .context("REMOTE_OPERATION_REQUIRED")?;
        let operations = match NativeOperations::load(context)? {
            Some(operations) => operations,
            None => match NativeOperations::initialize(context, operation_id) {
                Ok(operations) => operations,
                Err(error) => NativeOperations::load(context)?.ok_or(error)?,
            },
        };
        let (original, created) = operations.begin(context, request, "P-REMOTE", "delegate")?;
        ensure!(
            created && original.phase == IntegrationOperationPhase::Executing,
            "REMOTE_EXISTING_OPERATION_REQUIRES_OBSERVATION"
        );
        authority.check_current(context)?;
        let load_store = || -> Result<Option<(NativeDomainGuard, NativeRemoteDelegationStore)>> {
            let Some(guard) = NativeDomainGuard::observe(
                context.profile()?,
                context.scope(),
                NativeDomain::RemoteDelegations,
            )?
            else {
                return Ok(None);
            };
            let directory = guard.directory(context.profile()?)?;
            let store = NativeRemoteDelegationStore::open_in(
                &directory,
                OsStr::new("data"),
                context.scope(),
            )?
            .context("REMOTE_JOURNAL_MISSING")?;
            Ok(Some((guard, store)))
        };
        let (guard, store) = match load_store()? {
            Some(existing) => existing,
            None => match NativeDomainGuard::initialize(
                context.profile()?,
                context.scope(),
                NativeDomain::RemoteDelegations,
                operation_id,
                |directory| {
                    NativeRemoteDelegationStore::create_in(
                        directory,
                        OsStr::new("data"),
                        context.scope(),
                    )
                },
            ) {
                Ok(created) => created,
                Err(error) => load_store()?.ok_or(error)?,
            },
        };
        let (record, first) = store.begin(&NativeRemotePlan {
            operation_id: operation_id.clone(),
            scope: context.scope().clone(),
            public_intent: Value::Object(request.payload.clone()),
            recipient_revision: authority.recipient_revision().to_owned(),
            recipient_identity: authority.recipient_identity().clone(),
        })?;
        ensure!(
            first && record.stages.is_empty(),
            "REMOTE_EXISTING_OPERATION_REQUIRES_OBSERVATION"
        );
        let service = Self {
            context: context.recapture_for_owned_service()?,
            guard,
            store,
            operations,
            operation_id: operation_id.clone(),
            authority,
            dispatches: Mutex::default(),
        };
        service.verify_namespace()?;
        Ok(service)
    }
    /// Pure lookup; no runner, task, model, namespace or operation initialization.
    pub fn read(
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<NativeRemoteObservation>> {
        context.verify()?;
        let original = NativeOperations::load(context)?
            .map(|operations| operations.read(context, operation))
            .transpose()?
            .flatten();
        if let Some(receipt) = &original {
            ensure!(
                receipt.port == "P-REMOTE" && receipt.method == "delegate",
                "REMOTE_OPERATION_KIND_MISMATCH"
            );
        }
        let Some(guard) = NativeDomainGuard::observe(
            context.profile()?,
            context.scope(),
            NativeDomain::RemoteDelegations,
        )?
        else {
            ensure!(
                original.is_none(),
                "REMOTE_ORIGINAL_OPERATION_JOURNAL_UNAVAILABLE_OUTCOME_UNKNOWN"
            );
            return Ok(None);
        };
        let directory = guard.directory(context.profile()?)?;
        let store =
            NativeRemoteDelegationStore::open_in(&directory, OsStr::new("data"), context.scope())?
                .context("REMOTE_JOURNAL_MISSING")?;
        let result = store.read(operation)?;
        let current = guard
            .directory(context.profile()?)?
            .open_entry_handle(OsStr::new("data"))?
            .open_child_directory()?;
        ensure!(
            current.directory_identity()? == store.storage_directory_identity()?,
            "REMOTE_JOURNAL_CHANGED"
        );
        context.verify()?;
        Ok(result)
    }
    pub fn record_owned_cleanup(
        self: &Arc<Self>,
        receipt: &kcoder_acp::outbound::OutboundCleanup,
    ) -> Result<()> {
        ensure!(
            receipt.belongs_to(self),
            "REMOTE_ORIGINAL_CLEANUP_OWNER_MISMATCH"
        );
        self.store.record_owner_cleanup(
            &self.operation_id,
            receipt.owned_pid(),
            receipt.confirmed(),
        )?;
        if receipt.confirmed()
            && receiver_history::read_original_receiver(
                &self.context,
                &self.store,
                &self.operation_id,
            )?
            .is_some_and(|actual| actual.status == kcoder_types::TurnAttemptStatus::Interrupted)
        {
            let mut original = self
                .operations
                .read(&self.context, &self.operation_id)?
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
            let observed = self
                .store
                .read(&self.operation_id)?
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
            if original.phase == IntegrationOperationPhase::Executing
                && observed.stages.contains_key(&NativeRemoteStage::Cancel)
            {
                original = self.operations.transition(
                    &self.context,
                    &original,
                    IntegrationOperationPhase::CancelRequested,
                    None,
                )?;
            }
            if original.phase == IntegrationOperationPhase::CancelRequested {
                self.operations.transition(
                    &self.context,
                    &original,
                    IntegrationOperationPhase::Cancelled,
                    None,
                )?;
            }
        }
        Ok(())
    }
    fn verify_namespace(&self) -> Result<()> {
        let directory = self.guard.directory(self.context.profile()?)?;
        let data = directory
            .open_entry_handle(OsStr::new("data"))?
            .open_child_directory()?;
        ensure!(
            data.directory_identity()? == self.store.storage_directory_identity()?,
            "REMOTE_JOURNAL_CHANGED"
        );
        Ok(())
    }
}
impl OutboundHost for NativeRemoteJournal {
    fn handle_owned_native_settlement<'a>(
        &'a self,
        frame: &'a Value,
    ) -> kcoder_acp::outbound::OwnedNativeControlFuture<'a> {
        Box::pin(async move {
            self.context.verify()?;
            self.verify_namespace()?;
            let original = self
                .operations
                .read(&self.context, &self.operation_id)?
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
            ensure!(
                original.port == "P-REMOTE" && original.method == "delegate",
                "REMOTE_OPERATION_KIND_MISMATCH"
            );
            self.authority.handle_owned_native_settlement(frame).await
        })
    }

    fn check_owned_native_close(&self) -> Result<()> {
        self.context.verify()?;
        self.verify_namespace()?;
        let original = self
            .operations
            .read(&self.context, &self.operation_id)?
            .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
        ensure!(
            original.port == "P-REMOTE" && original.method == "delegate",
            "REMOTE_OPERATION_KIND_MISMATCH"
        );
        self.authority.check_owned_native_close(&self.context)
    }
    fn before_owned_native_close(&self, intent: &Value) -> Result<()> {
        self.check_owned_native_close()?;
        self.authority.verify_owned_native_close(intent)?;
        let permit = self.store.before_dispatch(
            &self.operation_id,
            self.context.scope(),
            NativeRemoteStage::OwnerClose,
            intent,
        )?;
        self.dispatches
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_DISPATCH_UNAVAILABLE"))?
            .insert(NativeRemoteStage::OwnerClose, permit);
        if let Err(error) = self.authority.admit_owned_native_close(intent) {
            self.unknown_owned_native_close()?;
            return Err(error);
        }
        Ok(())
    }
    fn record_owned_native_close(&self, receipt: &Value) -> Result<()> {
        self.check_owned_native_close()?;
        self.authority.verify_owned_native_close_receipt(receipt)?;
        let permits = self
            .dispatches
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_DISPATCH_UNAVAILABLE"))?;
        self.store.receive(
            permits
                .get(&NativeRemoteStage::OwnerClose)
                .context("REMOTE_ORIGINAL_DISPATCH_MISSING")?,
            receipt,
        )?;
        let reply: kcoder_types::integrations::core::NativeRemoteControlReplyV1 =
            serde_json::from_value(receipt.clone())?;
        let kcoder_types::integrations::core::NativeRemoteReceiptDataV1::OwnerClosed {
            accepted,
            outcome,
            ..
        } = reply.data
        else {
            anyhow::bail!("REMOTE_OWNER_CLOSE_RECEIPT_REQUIRED")
        };
        self.store.record_endpoint_receiver(&self.operation_id,
            &kcoder_state::integrations::core::remote_delegations::NativeRemoteEndpointReceiverObservation {
                endpoint_instance_id: reply.endpoint_instance_id, accepted, outcome, cleanup_confirmed: true
            })?;
        self.authority.observe_owned_native_close(receipt)?;
        Ok(())
    }
    fn unknown_owned_native_close(&self) -> Result<()> {
        let permits = self
            .dispatches
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_DISPATCH_UNAVAILABLE"))?;
        self.store.unknown(
            permits
                .get(&NativeRemoteStage::OwnerClose)
                .context("REMOTE_ORIGINAL_DISPATCH_MISSING")?,
        )?;
        Ok(())
    }

    fn before_owned_native_material(&self, request: &Value) -> Result<()> {
        self.check_current()?;
        self.authority.verify_owned_native_material(request)?;
        let mut permits = self
            .dispatches
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_DISPATCH_UNAVAILABLE"))?;
        if let std::collections::btree_map::Entry::Vacant(entry) =
            permits.entry(NativeRemoteStage::InputTransfer)
        {
            entry.insert(self.store.before_dispatch(
                &self.operation_id,
                self.context.scope(),
                NativeRemoteStage::InputTransfer,
                &self.authority.material_intent()?,
            )?);
        }
        let observed = self
            .store
            .read(&self.operation_id)?
            .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
        ensure!(observed.stages.get(&NativeRemoteStage::InputTransfer)==Some(&kcoder_state::integrations::core::remote_delegations::NativeRemoteStageState::Dispatched),"REMOTE_MATERIAL_RECONCILE_ORIGINAL");
        Ok(())
    }
    fn unknown_owned_native_material(&self) -> Result<()> {
        let permits = self
            .dispatches
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_DISPATCH_UNAVAILABLE"))?;
        self.store.unknown(
            permits
                .get(&NativeRemoteStage::InputTransfer)
                .context("REMOTE_ORIGINAL_DISPATCH_MISSING")?,
        )?;
        Ok(())
    }
    fn check_owned_native_observation(&self) -> Result<()> {
        self.context.verify()?;
        self.verify_namespace()?;
        let original = self
            .operations
            .read(&self.context, &self.operation_id)?
            .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
        ensure!(
            original.port == "P-REMOTE" && original.method == "delegate",
            "REMOTE_OPERATION_KIND_MISMATCH"
        );
        self.authority.check_owned_native_observation(&self.context)
    }
    fn verify_owned_native_read(&self, request: &Value) -> Result<()> {
        self.check_owned_native_observation()?;
        self.authority.verify_owned_native_read(request)
    }
    fn verify_owned_frame_transport(
        &self,
        transport: &dyn kcoder_acp::outbound::OwnedNativeFrameTransport,
    ) -> Result<()> {
        self.check_current()?;
        self.authority.verify_owned_frame_transport(transport)
    }
    fn before_owned_native_bind(&self, intent: &Value) -> Result<()> {
        self.check_current()?;
        self.authority.verify_owned_native_bind(intent)?;
        let permit = self.store.before_dispatch(
            &self.operation_id,
            self.context.scope(),
            NativeRemoteStage::BindOriginal,
            intent,
        )?;
        self.dispatches
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_DISPATCH_UNAVAILABLE"))?
            .insert(NativeRemoteStage::BindOriginal, permit);
        Ok(())
    }
    fn record_owned_native_bind(&self, receipt: &Value) -> Result<()> {
        self.authority.verify_owned_native_bind_receipt(receipt)?;
        let permits = self
            .dispatches
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_DISPATCH_UNAVAILABLE"))?;
        let permit = permits
            .get(&NativeRemoteStage::BindOriginal)
            .context("REMOTE_ORIGINAL_DISPATCH_MISSING")?;
        self.store.receive(permit, receipt)?;
        self.authority.observe_owned_native_bind(receipt)
    }
    fn unknown_owned_native_bind(&self) -> Result<()> {
        let permits = self
            .dispatches
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_DISPATCH_UNAVAILABLE"))?;
        self.store.unknown(
            permits
                .get(&NativeRemoteStage::BindOriginal)
                .context("REMOTE_ORIGINAL_DISPATCH_MISSING")?,
        )?;
        Ok(())
    }
    fn handle_owned_native_control<'a>(
        &'a self,
        frame: &'a Value,
    ) -> kcoder_acp::outbound::OwnedNativeControlFuture<'a> {
        Box::pin(async move {
            let request: kcoder_types::integrations::core::NativeRemoteControlFrameV1 =
                serde_json::from_value(frame["params"].clone())?;
            if matches!(
                request.message,
                kcoder_types::integrations::core::NativeRemoteControlDataV1::ReserveModel(_)
                    | kcoder_types::integrations::core::NativeRemoteControlDataV1::DispatchModel(_)
            ) {
                self.context.verify()?;
                self.verify_namespace()?;
                ensure!(
                    !self
                        .store
                        .read(&self.operation_id)?
                        .context("REMOTE_ORIGINAL_OPERATION_MISSING")?
                        .stages
                        .contains_key(&NativeRemoteStage::OwnerClose),
                    "REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL"
                );
                self.authority.check_owned_native_control(&self.context)?;
                let original = self
                    .operations
                    .read(&self.context, &self.operation_id)?
                    .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
                ensure!(
                    original.phase == IntegrationOperationPhase::Executing
                        && original.port == "P-REMOTE"
                        && original.method == "delegate",
                    "REMOTE_ORIGINAL_OPERATION_NOT_ACTIVE"
                );
            } else {
                self.check_owned_native_observation()?;
            }
            let response = self.authority.handle_owned_native_control(frame).await?;
            if response.is_some()
                && let kcoder_types::integrations::core::NativeRemoteControlDataV1::ReceiverAccepted(
                    accepted,
                ) = request.message
            {
                let endpoint = self
                    .authority
                    .owned_endpoint_instance_id()
                    .context("REMOTE_ORIGINAL_ENDPOINT_REQUIRED")?;
                self.store.record_endpoint_receiver(&self.operation_id,&kcoder_state::integrations::core::remote_delegations::NativeRemoteEndpointReceiverObservation {
                        endpoint_instance_id:endpoint.into(),accepted,outcome:None,cleanup_confirmed:false })?;
            }
            Ok(response)
        })
    }
    fn verify_runner(&self, runner: &InstalledOutboundRunner) -> Result<()> {
        self.check_current()?;
        self.authority.verify_runner(&self.context, runner)
    }
    fn check_current(&self) -> Result<()> {
        self.context.verify()?;
        self.verify_namespace()?;
        self.authority.check_current(&self.context)?;
        ensure!(
            !self
                .store
                .read(&self.operation_id)?
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?
                .stages
                .contains_key(&NativeRemoteStage::OwnerClose),
            "REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL"
        );
        let original = self
            .operations
            .read(&self.context, &self.operation_id)?
            .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
        ensure!(
            original.phase == IntegrationOperationPhase::Executing
                && original.port == "P-REMOTE"
                && original.method == "delegate",
            "REMOTE_ORIGINAL_OPERATION_NOT_ACTIVE"
        );
        Ok(())
    }
    fn deadline(&self) -> tokio::time::Instant {
        self.authority.deadline()
    }
    fn before_effect(&self, effect: OutboundEffect, intent: &Value) -> Result<()> {
        self.check_current()?;
        self.authority.check_frozen_intent(effect, intent)?;
        let stage = stage(effect);
        let permit =
            self.store
                .before_dispatch(&self.operation_id, self.context.scope(), stage, intent)?;
        self.dispatches
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_DISPATCH_UNAVAILABLE"))?
            .insert(stage, permit);
        Ok(())
    }
    fn record_receipt(&self, effect: OutboundEffect, receipt: &Value) -> Result<()> {
        // Fact settlement uses only the retained original store/permit, even after authority revocation.
        // It cannot allocate a new effect or grant access to another profile.
        let dispatches = self
            .dispatches
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_DISPATCH_UNAVAILABLE"))?;
        let permit = dispatches
            .get(&stage(effect))
            .context("REMOTE_ORIGINAL_DISPATCH_MISSING")?;
        self.store.receive(permit, receipt)?;
        self.authority.observe_receipt(effect, receipt)?;
        Ok(())
    }
    fn record_unknown(&self, effect: OutboundEffect) -> Result<()> {
        let dispatches = self
            .dispatches
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_DISPATCH_UNAVAILABLE"))?;
        let permit = dispatches
            .get(&stage(effect))
            .context("REMOTE_ORIGINAL_DISPATCH_MISSING")?;
        self.store.unknown(permit)?;
        Ok(())
    }
    fn begin_owned_cancel(&self, session: &Value) -> Result<()> {
        let original = self
            .store
            .read(&self.operation_id)?
            .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
        ensure!(
            original
                .safe_receipts
                .get(&NativeRemoteStage::Session)
                .is_some_and(|receipt| &receipt["sessionId"] == session)
                && original.stages.contains_key(&NativeRemoteStage::Prompt),
            "REMOTE_ORIGINAL_SESSION_CHANGED"
        );
        let permit = self.store.before_dispatch(
            &self.operation_id,
            self.context.scope(),
            NativeRemoteStage::Cancel,
            &serde_json::json!({"sessionId":session,"action":"cancel_original_only"}),
        )?;
        self.dispatches
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_DISPATCH_UNAVAILABLE"))?
            .insert(NativeRemoteStage::Cancel, permit);
        if self.authority.owned_endpoint_instance_id().is_some()
            && let Err(error) = self.authority.admit_owned_native_cancel(session)
        {
            self.finish_owned_cancel(false)?;
            return Err(error);
        }
        Ok(())
    }
    fn finish_owned_cancel(&self, native_terminal_observed: bool) -> Result<()> {
        let dispatches = self
            .dispatches
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_DISPATCH_UNAVAILABLE"))?;
        let permit = dispatches
            .get(&NativeRemoteStage::Cancel)
            .context("REMOTE_ORIGINAL_DISPATCH_MISSING")?;
        if native_terminal_observed {
            self.store.receive(
                permit,
                &serde_json::json!({"nativeTaskTerminalObserved":true,"businessCompleted":false}),
            )?;
        } else {
            self.store.unknown(permit)?;
        }
        Ok(())
    }
    fn owned_cancel_complete(&self) -> Result<bool> {
        if let Some(receiver) = self
            .store
            .read(&self.operation_id)?
            .context("REMOTE_ORIGINAL_OPERATION_MISSING")?
            .endpoint_receiver
        {
            use kcoder_types::integrations::core::NativeRemoteCallOutcomeV1 as Outcome;
            return Ok(matches!(
                receiver.outcome,
                Some(Outcome::Completed | Outcome::Failed | Outcome::Interrupted)
            ));
        }
        Ok(receiver_history::read_original_receiver(
            &self.context,
            &self.store,
            &self.operation_id,
        )?
        .is_some_and(|record| {
            matches!(
                record.status,
                kcoder_types::TurnAttemptStatus::Completed
                    | kcoder_types::TurnAttemptStatus::Failed
                    | kcoder_types::TurnAttemptStatus::Interrupted
            )
        }))
    }
}
fn stage(effect: OutboundEffect) -> NativeRemoteStage {
    match effect {
        OutboundEffect::Spawn => NativeRemoteStage::Spawn,
        OutboundEffect::Initialize => NativeRemoteStage::Initialize,
        OutboundEffect::Session => NativeRemoteStage::Session,
        OutboundEffect::Prompt => NativeRemoteStage::Prompt,
    }
}
