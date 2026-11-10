//! Native commands are driven by the existing connection loop, never a nested RPC loop.
mod accepted_observer;
mod thread_initializer;
pub(crate) use thread_initializer::NativeRuntimeThreadInitializer;
pub(crate) mod child_intents;
pub(crate) use accepted_observer::NativeRuntimeAcceptedObserver;
mod configuration;
mod input_installation;
pub(crate) use input_installation::NativeInputInstallation;
mod original_task_configuration;
pub(crate) use original_task_configuration::NativeOriginalTaskConfiguration;
mod submission;
#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;
mod workflow;
mod workflow_guard;
pub(super) mod workflow_origin;

pub(crate) use configuration::{
    NativeRuntimeAuthority, NativeRuntimeCurrentSource, NativeRuntimePolicyInstaller,
    NativeRuntimePreStart,
};
#[cfg(test)]
use kcoder_runtime_driver::MAX_QUEUED;
#[cfg(test)]
pub(crate) use kcoder_runtime_driver::public_error;
pub(crate) use kcoder_runtime_driver::{
    NativeRuntimeAcceptanceReader, NativeRuntimeSourceIntent, RuntimeOutputObservationState,
};
pub use kcoder_runtime_driver::{
    NativeRuntimeCommand, NativeRuntimeTicket, PreparedRuntimeTask, RuntimeExecutionConfiguration,
    RuntimeExternalSend, RuntimeSubmission, RuntimeWorkflowSpec,
};
use kcoder_runtime_driver::{
    NativeRuntimeDriver as Driver, RuntimeBinding, RuntimeBindings, RuntimePhase, RuntimeStorage,
    hash, safe_error,
};
#[cfg(test)]
pub(crate) use workflow::NativeWorkflowLaunch;

use super::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use anyhow::{Context, Result, ensure};
use kcoder_state::integrations::core::{IntegrationOperationBegin, IntegrationOperationStore};
use kcoder_types::integrations::core::*;
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, sync::Arc};

/// The App Server supplies the original resident and policy capabilities.
pub struct NativeRuntimeDriver(Driver);

impl NativeRuntimeDriver {
    pub(crate) fn observe_source_intent(
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<NativeRuntimeSourceIntent>> {
        Driver::observe_source_intent(context, operation)
    }

    pub(crate) fn read_original_acceptance(
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<IntegrationRuntimeAcceptance>> {
        Driver::read_original_acceptance(context, operation)
    }

    pub(crate) fn read_original_task_evidence(
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<kcoder_runtime_driver::OriginalRuntimeTaskEvidence>> {
        Driver::read_original_task_evidence(context, operation)
    }

    pub(crate) fn load(context: &NativeIntegrationContext) -> Result<Option<Self>> {
        Driver::load(context).map(|driver| driver.map(Self))
    }

    pub(crate) fn initialize(context: &NativeIntegrationContext, operation: &str) -> Result<Self> {
        Driver::initialize(context, operation).map(Self)
    }
}

impl std::fmt::Debug for NativeRuntimeDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::ops::Deref for NativeRuntimeDriver {
    type Target = Driver;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for NativeRuntimeDriver {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

#[cfg(test)]
impl NativeRuntimeDriver {
    /// Recovery queues reads only. Missing receipts never restart a thread,
    /// configure a recovered engine, resubmit a turn or start another workflow.
    pub fn reconcile_operation(
        &mut self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<()> {
        self.check(context)?;
        ensure!(
            !self
                .test_pending()
                .values()
                .any(|ticket| ticket.operation_id() == operation),
            "RUNTIME_COMMAND_STILL_PENDING"
        );
        if self.test_queue().iter().any(|value| value == operation) {
            return Ok(());
        }
        let mut binding = self
            .storage()
            .bindings()
            .get(operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        self.track(&binding)?;
        if binding.phase == RuntimePhase::Terminal || binding.phase == RuntimePhase::Rejected {
            return Ok(());
        }
        if binding.spec.configuration.workflow.is_some() {
            if binding.acceptance.is_some() {
                return self.refresh_workflow(context, operation);
            }
            return self
                .storage()
                .unknown(binding, "RUNTIME_WORKFLOW_ACCEPTANCE_UNCONFIRMED");
        }
        binding.recovery_from = Some(binding.phase);
        binding.phase = if binding.thread_id.is_some() {
            RuntimePhase::RecoverTurnQueued
        } else {
            RuntimePhase::RecoverThreadQueued
        };
        self.save_and_enqueue(binding)
    }
}
