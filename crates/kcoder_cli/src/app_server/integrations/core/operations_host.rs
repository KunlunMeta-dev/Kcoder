//! Native operation ownership; domain outcomes are reconciled without replaying an action.
use anyhow::{Context, Result, ensure};
use kcoder_integration_storage::integrations::core::{
    IntegrationOperationStore, IntegrationOperationUpdate,
};
use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use kcoder_types::integrations::core::*;
use std::{
    ffi::OsStr,
    time::{SystemTime, UNIX_EPOCH},
};

pub struct NativeOperations {
    guard: NativeDomainGuard,
    store: IntegrationOperationStore,
}
impl std::fmt::Debug for NativeOperations {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeOperations { native_ledger: bound }")
    }
}
impl NativeOperations {
    pub fn load(context: &NativeIntegrationContext) -> Result<Option<Self>> {
        let profile = context.profile()?;
        let Some(guard) =
            NativeDomainGuard::observe(profile, context.scope(), NativeDomain::Operations)?
        else {
            return Ok(None);
        };
        let directory = guard.directory(profile)?;
        let store =
            IntegrationOperationStore::open_in(&directory, OsStr::new("data"), context.scope())?;
        let service = Self { guard, store };
        service.verify(context)?;
        Ok(Some(service))
    }
    pub fn initialize(context: &NativeIntegrationContext, operation: &str) -> Result<Self> {
        let (guard, store) = NativeDomainGuard::initialize(
            context.profile()?,
            context.scope(),
            NativeDomain::Operations,
            operation,
            |directory| {
                IntegrationOperationStore::create_in(directory, OsStr::new("data"), context.scope())
            },
        )?;
        let service = Self { guard, store };
        service.verify(context)?;
        Ok(service)
    }
    pub fn verify(&self, context: &NativeIntegrationContext) -> Result<()> {
        let directory = self.guard.directory(context.profile()?)?;
        let data = directory
            .open_entry_handle(OsStr::new("data"))?
            .open_child_directory()?;
        ensure!(
            data.directory_identity()? == self.store.storage_directory_identity()?,
            "INTEGRATION_OPERATIONS_CHANGED"
        );
        Ok(())
    }
    pub fn read(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<IntegrationOperationReceipt>> {
        self.verify(context)?;
        let result = self.store.read(operation)?;
        self.verify(context)?;
        Ok(result)
    }
    pub fn read_original(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        port: &str,
        method: &str,
    ) -> Result<Option<IntegrationOperationReceipt>> {
        context.validate_scope(&request.scope)?;
        self.verify(context)?;
        let receipt = self.store.read_original(request, port, method)?;
        self.verify(context)?;
        Ok(receipt)
    }

    pub fn begin_memory(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        method: &str,
    ) -> Result<(IntegrationOperationReceipt, bool)> {
        self.begin(context, request, "P-MEMORY", method)
    }
    pub fn begin(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        port: &str,
        method: &str,
    ) -> Result<(IntegrationOperationReceipt, bool)> {
        self.verify(context)?;
        let receipt = self.store.begin(request, port, method, now_ms()?)?;
        let receipt = receipt.receipt().clone();
        if receipt.phase == IntegrationOperationPhase::Pending {
            Ok((
                self.transition(
                    context,
                    &receipt,
                    IntegrationOperationPhase::Executing,
                    None,
                )?,
                true,
            ))
        } else {
            Ok((receipt, false))
        }
    }
    pub fn transition(
        &self,
        context: &NativeIntegrationContext,
        original: &IntegrationOperationReceipt,
        phase: IntegrationOperationPhase,
        error: Option<IntegrationError>,
    ) -> Result<IntegrationOperationReceipt> {
        self.transition_with_entity(context, original, phase, None, error)
    }

    pub fn transition_with_entity(
        &self,
        context: &NativeIntegrationContext,
        original: &IntegrationOperationReceipt,
        phase: IntegrationOperationPhase,
        entity_ref: Option<IntegrationEntityRef>,
        error: Option<IntegrationError>,
    ) -> Result<IntegrationOperationReceipt> {
        self.verify(context)?;
        let receipt = self.store.compare_and_swap(
            &original.operation_id,
            IntegrationOperationUpdate {
                expected_revision: original.revision,
                phase,
                entity_ref,
                error,
                runtime_acceptance: None,
                observed_at_ms: now_ms()?,
            },
        )?;
        self.verify(context)?;
        Ok(receipt)
    }
}

fn now_ms() -> Result<u64> {
    u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())
        .context("INTEGRATION_CLOCK_UNAVAILABLE")
}
