//! Task-local source restrictions over real native Accepted records and execution facts.
//! This module stores selection metadata only; the existing runtime owns all execution.
mod factory;
mod guard;
mod storage;

use super::super::core::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use super::{NativeConnectivitySourceCatalog, NativeMcpSourceFact};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_engine::integrations::core::NativeToolAuthorizationRequest;
use kcoder_state::{
    integrations::core::IntegrationOperationStore, turn_attempt_store::TurnAttemptRecord,
};
use kcoder_types::{
    BackgroundRunKey, TurnAttemptIdentity, TurnAttemptStatus, integrations::core::*,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{any::Any, collections::BTreeSet, ffi::OsStr, sync::Arc};

pub(crate) use factory::NativeTaskCapabilityScopeFactory;
pub(crate) use guard::{NativeTaskCapabilityScopeGuard, NativeTaskCapabilityScopePendingTarget};
pub(crate) use storage::{NativeTaskCapabilityScopeBinding, NativeTaskCapabilityScopeBindingStore};

/// A native scope/State epoch witness supplied by Root's actual session adapter.
/// No serde or JSON constructor exists for this capability seam.
pub(crate) struct NativeTaskCapabilityScopeTurnWitness {
    pub scope: IntegrationScope,
    pub session_directory_identity: String,
    pub state_epoch: String,
    pub record: TurnAttemptRecord,
}

pub(crate) struct NativeTaskCapabilityScopeLineageEdge {
    pub run: BackgroundRunKey,
    pub child_session_id: String,
}

/// Actual current execution evidence. Root must read native State/attempts and
/// live run ownership, not reconstruct these fields from the requested session ID.
pub(crate) struct NativeTaskCapabilityScopeExecution {
    pub scope: IntegrationScope,
    pub task_key: String,
    pub current_session_id: String,
    pub root_session_directory_identity: String,
    pub root_state_epoch: String,
    pub root_attempt_chain: Vec<TurnAttemptRecord>,
    /// Actual emitter attempt, separate from the accepted root task's history.
    pub current_attempt: Option<TurnAttemptRecord>,
    pub lineage: Vec<NativeTaskCapabilityScopeLineageEdge>,
    pub native_emitter_id: String,
    /// Captured from the actual emitting registered connection, including its
    /// original account/version. A name lookup in the latest factory is insufficient.
    pub emitter_source: Option<Arc<NativeMcpSourceFact>>,
    /// Native quiescence token. The required provider independently verifies its lease.
    pub boundary_id: Option<String>,
}

/// Resource/App/admission frames carry an actual native emitter capability.
/// There is no public RPC method for constructing this in-process frame.
pub(crate) struct NativeTaskCapabilityScopeCallback<'a> {
    pub session_id: &'a str,
    pub native_witness: &'a (dyn Any + Send + Sync),
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeTaskCapabilityScopeCallbackPurpose {
    Admission,
    ChildAdmission,
    Provider,
    Event,
    SourceBoundary,
    Resource,
    App,
}

/// Required actual host adapters. Missing facts are errors; there are no defaults.
/// Implementations must authenticate the actual emitter/State owner, including
/// native parent -> child lineage, rather than trusting request.session_id.
#[async_trait]
pub(crate) trait NativeTaskCapabilityScopeFacts: Send + Sync {
    async fn reconcile_pending_selection(
        &self,
        _context: &NativeIntegrationContext,
        _binding: &NativeTaskCapabilityScopeBinding,
    ) -> Result<()> {
        anyhow::bail!("TASK_CAPABILITY_SCOPE_PENDING_RECONCILIATION_UNAVAILABLE")
    }

    async fn prepare_child(
        &self,
        _context: &NativeIntegrationContext,
        _binding: &NativeTaskCapabilityScopeBinding,
        _request: &kcoder_engine::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> Result<()> {
        anyhow::bail!("TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE")
    }
    async fn observe_child_accepted(
        &self,
        _context: &NativeIntegrationContext,
        _binding: &NativeTaskCapabilityScopeBinding,
        _request: &kcoder_engine::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> Result<()> {
        anyhow::bail!("TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE")
    }
    async fn accepted_turn(
        &self,
        context: &NativeIntegrationContext,
        identity: &TurnAttemptIdentity,
    ) -> Result<NativeTaskCapabilityScopeTurnWitness>;
    async fn execution_for_tool(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<NativeTaskCapabilityScopeExecution>;
    async fn execution_for_callback(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        callback: &NativeTaskCapabilityScopeCallback<'_>,
        purpose: NativeTaskCapabilityScopeCallbackPurpose,
    ) -> Result<NativeTaskCapabilityScopeExecution>;
    async fn sources(&self, context: &NativeIntegrationContext)
    -> Result<Vec<NativeMcpSourceFact>>;
    async fn selection_admission(
        &self,
        _context: &NativeIntegrationContext,
        _accepted: &NativeAcceptedTaskIdentity,
        _operation: &str,
        _selection: &IntegrationTaskCapabilityScopeSelection,
    ) -> Result<super::task_capability_scope_control::NativeTaskCapabilityScopeAdmission> {
        anyhow::bail!("TASK_CAPABILITY_SCOPE_DURABLE_ADMISSION_UNAVAILABLE")
    }
    async fn revalidate_selection_authorization(
        &self,
        _context: &NativeIntegrationContext,
        _accepted: &NativeAcceptedTaskIdentity,
        _authorization: &super::task_capability_scope_control::NativeTaskCapabilityScopeAuthorizationReceipt,
        _operation: &str,
        _selection: &IntegrationTaskCapabilityScopeSelection,
    ) -> Result<()> {
        anyhow::bail!("TASK_CAPABILITY_SCOPE_DURABLE_REVALIDATION_UNAVAILABLE")
    }
    async fn authorize_resource_selection(
        &self,
        _context: &NativeIntegrationContext,
        _accepted: &NativeAcceptedTaskIdentity,
        _operation: &str,
        _bindings: &[IntegrationTaskResourceBinding],
    ) -> Result<()> {
        anyhow::bail!("TASK_RESOURCE_NATIVE_MANAGEMENT_REQUIRED")
    }
    async fn verify_resource_bindings(
        &self,
        _context: &NativeIntegrationContext,
        _bindings: &[IntegrationTaskResourceBinding],
    ) -> Result<()> {
        anyhow::bail!("TASK_RESOURCE_NATIVE_GRANT_UNAVAILABLE")
    }
    fn inherited_resource_tools(
        &self,
        _context: &NativeIntegrationContext,
        _bindings: &[IntegrationTaskResourceBinding],
        _registered: &kcoder_tools::ToolRegistry,
    ) -> Result<Vec<Arc<dyn kcoder_tools::Tool>>> {
        anyhow::bail!("TASK_RESOURCE_NATIVE_CHILD_CATALOG_UNAVAILABLE")
    }
    async fn authorize_resource_tool(
        &self,
        _context: &NativeIntegrationContext,
        _bindings: &[IntegrationTaskResourceBinding],
        _request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<bool> {
        anyhow::bail!("TASK_RESOURCE_TOOL_SEMANTICS_UNAVAILABLE")
    }
    async fn authorize_resource_uri(
        &self,
        _context: &NativeIntegrationContext,
        _bindings: &[IntegrationTaskResourceBinding],
        _selector: &super::NativeMcpSourceSelector,
        _uri: &str,
    ) -> Result<bool> {
        anyhow::bail!("TASK_RESOURCE_NATIVE_GRANT_UNAVAILABLE")
    }
    async fn authorize_selection(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        operation_id: &str,
        selection: &IntegrationTaskCapabilityScopeSelection,
    ) -> Result<()>;
    fn verify_safe_boundary(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        execution: &NativeTaskCapabilityScopeExecution,
    ) -> Result<()>;
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum AcceptedOrigin {
    Runtime {
        operation_id: String,
        acceptance: IntegrationRuntimeAcceptance,
    },
    Studio,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AcceptedData {
    pub scope: IntegrationScope,
    pub origin: AcceptedOrigin,
    pub initial_attempt: TurnAttemptIdentity,
    pub session_directory_identity: String,
    pub state_epoch: String,
    pub accepted_fingerprint: String,
}

/// Constructed by reading the original native private records, never a public receipt.
pub(crate) struct NativeAcceptedTaskIdentity {
    data: AcceptedData,
}
impl NativeAcceptedTaskIdentity {
    pub(crate) async fn capture_runtime(
        context: &NativeIntegrationContext,
        operation_id: &str,
        initial_attempt: &TurnAttemptIdentity,
        facts: &dyn NativeTaskCapabilityScopeFacts,
    ) -> Result<Self> {
        let receipt = runtime_receipt(context, operation_id)?;
        let acceptance = receipt
            .runtime_acceptance
            .context("TASK_CAPABILITY_SCOPE_ACCEPTANCE_REQUIRED")?;
        ensure!(
            acceptance.thread_id == initial_attempt.thread_id
                && acceptance
                    .turn_id
                    .as_ref()
                    .is_none_or(|turn| turn == &initial_attempt.turn_id),
            "TASK_CAPABILITY_SCOPE_ACCEPTANCE_MISMATCH"
        );
        Self::capture(
            context,
            AcceptedOrigin::Runtime {
                operation_id: operation_id.into(),
                acceptance,
            },
            initial_attempt,
            facts,
        )
        .await
    }
    pub(crate) async fn capture_studio(
        context: &NativeIntegrationContext,
        initial_attempt: &TurnAttemptIdentity,
        facts: &dyn NativeTaskCapabilityScopeFacts,
    ) -> Result<Self> {
        Self::capture(context, AcceptedOrigin::Studio, initial_attempt, facts).await
    }
    async fn capture(
        context: &NativeIntegrationContext,
        origin: AcceptedOrigin,
        initial_attempt: &TurnAttemptIdentity,
        facts: &dyn NativeTaskCapabilityScopeFacts,
    ) -> Result<Self> {
        context.verify()?;
        initial_attempt.validate().map_err(anyhow::Error::msg)?;
        let witness = facts.accepted_turn(context, initial_attempt).await?;
        validate_witness(context, initial_attempt, &witness)?;
        let identity = Self {
            data: AcceptedData {
                scope: context.scope().clone(),
                origin,
                initial_attempt: initial_attempt.clone(),
                session_directory_identity: witness.session_directory_identity,
                state_epoch: witness.state_epoch,
                accepted_fingerprint: attempt_fingerprint(&witness.record)?,
            },
        };
        context.verify()?;
        Ok(identity)
    }
    pub(crate) fn task_key(&self) -> Result<String> {
        digest(&self.data)
    }
    pub(crate) fn thread_id(&self) -> &str {
        &self.data.initial_attempt.thread_id
    }
    pub(crate) fn initial_attempt(&self) -> &TurnAttemptIdentity {
        &self.data.initial_attempt
    }
    pub(crate) fn control_target(&self) -> IntegrationTaskCapabilityScopeControlTarget {
        IntegrationTaskCapabilityScopeControlTarget {
            initial_attempt: self.data.initial_attempt.clone(),
            runtime_operation_id: match &self.data.origin {
                AcceptedOrigin::Runtime { operation_id, .. } => Some(operation_id.clone()),
                AcceptedOrigin::Studio => None,
            },
        }
    }
    pub(crate) fn validate_control_target(
        &self,
        target: &IntegrationTaskCapabilityScopeControlTarget,
    ) -> Result<()> {
        target.validate()?;
        ensure!(
            *target == self.control_target(),
            "TASK_CAPABILITY_SCOPE_CONTROL_ORIGINAL_TUPLE_MISMATCH"
        );
        Ok(())
    }
    pub(crate) fn immutable_control_resource(&self) -> Result<IntegrationEntityRef> {
        let (kind, id, revision) = match &self.data.origin {
            AcceptedOrigin::Runtime { acceptance, .. } => (
                if acceptance.task_id.is_some() {
                    IntegrationEntityKind::Task
                } else {
                    IntegrationEntityKind::Turn
                },
                acceptance
                    .task_id
                    .as_ref()
                    .or(acceptance.turn_id.as_ref())
                    .context("TASK_CAPABILITY_SCOPE_IMMUTABLE_TASK_RESOURCE_REQUIRED")?
                    .clone(),
                digest(acceptance)?,
            ),
            AcceptedOrigin::Studio => (
                IntegrationEntityKind::Turn,
                self.data.initial_attempt.turn_id.clone(),
                self.data.accepted_fingerprint.clone(),
            ),
        };
        Ok(IntegrationEntityRef {
            kind,
            id,
            revision: Some(revision),
        })
    }
    pub(crate) fn accepted_fingerprint(&self) -> &str {
        &self.data.accepted_fingerprint
    }
    pub(crate) fn native_owner_epoch(&self) -> &str {
        &self.data.state_epoch
    }

    pub(crate) fn runtime_operation_id(&self) -> Option<&str> {
        match &self.data.origin {
            AcceptedOrigin::Runtime { operation_id, .. } => Some(operation_id),
            AcceptedOrigin::Studio => None,
        }
    }
    pub(crate) async fn verify(
        &self,
        context: &NativeIntegrationContext,
        facts: &dyn NativeTaskCapabilityScopeFacts,
    ) -> Result<()> {
        context.validate_scope(&self.data.scope)?;
        if let AcceptedOrigin::Runtime {
            operation_id,
            acceptance,
        } = &self.data.origin
        {
            ensure!(
                runtime_receipt(context, operation_id)?
                    .runtime_acceptance
                    .as_ref()
                    == Some(acceptance),
                "TASK_CAPABILITY_SCOPE_ACCEPTANCE_CHANGED"
            );
        }
        let witness = facts
            .accepted_turn(context, &self.data.initial_attempt)
            .await?;
        validate_witness(context, &self.data.initial_attempt, &witness)?;
        ensure!(
            witness.session_directory_identity == self.data.session_directory_identity
                && witness.state_epoch == self.data.state_epoch
                && attempt_fingerprint(&witness.record)? == self.data.accepted_fingerprint,
            "TASK_CAPABILITY_SCOPE_ACCEPTED_OWNER_CHANGED"
        );
        context.verify()
    }
    pub(super) async fn restore(
        context: &NativeIntegrationContext,
        data: AcceptedData,
        facts: &dyn NativeTaskCapabilityScopeFacts,
    ) -> Result<Self> {
        let identity = Self { data };
        identity.verify(context, facts).await?;
        Ok(identity)
    }
    pub(super) fn check_execution(
        &self,
        context: &NativeIntegrationContext,
        session: &str,
        execution: &NativeTaskCapabilityScopeExecution,
        model_call: bool,
    ) -> Result<()> {
        context.validate_scope(&execution.scope)?;
        ensure!(
            execution.task_key == self.task_key()?
                && execution.current_session_id == session
                && execution.root_session_directory_identity
                    == self.data.session_directory_identity
                && execution.root_state_epoch == self.data.state_epoch,
            "TASK_CAPABILITY_SCOPE_EXECUTION_OWNER_MISMATCH"
        );
        atom(&execution.native_emitter_id)?;
        ensure!(
            !execution.root_attempt_chain.is_empty() && execution.root_attempt_chain.len() <= 64,
            "TASK_CAPABILITY_SCOPE_ATTEMPT_PROOF_REQUIRED"
        );
        let first = &execution.root_attempt_chain[0];
        ensure!(
            first.identity == self.data.initial_attempt
                && attempt_fingerprint(first)? == self.data.accepted_fingerprint,
            "TASK_CAPABILITY_SCOPE_ATTEMPT_ORIGIN_CHANGED"
        );
        let mut attempts = BTreeSet::new();
        let mut previous: Option<&TurnAttemptRecord> = None;
        for record in &execution.root_attempt_chain {
            record.validate()?;
            ensure!(
                record.status.is_known()
                    && record.identity.thread_id == self.data.initial_attempt.thread_id
                    && record.identity.turn_id == self.data.initial_attempt.turn_id
                    && attempts.insert(record.identity.attempt_id.clone()),
                "TASK_CAPABILITY_SCOPE_ATTEMPT_CHAIN_INVALID"
            );
            if let Some(parent) = previous {
                ensure!(
                    record.parent_attempt_id.as_deref()
                        == Some(parent.identity.attempt_id.as_str()),
                    "TASK_CAPABILITY_SCOPE_ATTEMPT_CHAIN_INVALID"
                );
            }
            previous = Some(record);
        }
        if model_call {
            let current = execution
                .current_attempt
                .as_ref()
                .context("TASK_CAPABILITY_SCOPE_EMITTER_ATTEMPT_REQUIRED")?;
            current.validate()?;
            ensure!(
                current.identity.thread_id == session
                    && current.status == TurnAttemptStatus::Accepted
                    && current.completion.is_none(),
                "TASK_CAPABILITY_SCOPE_ATTEMPT_NOT_ACTIVE"
            );
            if session == self.thread_id() {
                ensure!(
                    previous.is_some_and(|root| root.identity == current.identity),
                    "TASK_CAPABILITY_SCOPE_ATTEMPT_CHAIN_INVALID"
                );
            }
        }
        ensure!(
            execution.lineage.len() <= 32,
            "TASK_CAPABILITY_SCOPE_LINEAGE_LIMIT"
        );
        let mut expected = self.thread_id();
        let mut seen = BTreeSet::from([expected.to_owned()]);
        for edge in &execution.lineage {
            atom(&edge.run.parent_session_id)?;
            atom(&edge.run.agent_id)?;
            atom(&edge.run.run_id)?;
            atom(&edge.child_session_id)?;
            ensure!(
                edge.run.parent_session_id == expected
                    && seen.insert(edge.child_session_id.clone()),
                "TASK_CAPABILITY_SCOPE_LINEAGE_INVALID"
            );
            expected = &edge.child_session_id;
        }
        ensure!(
            expected == session,
            "TASK_CAPABILITY_SCOPE_LINEAGE_REQUIRED"
        );
        Ok(())
    }
}

fn runtime_receipt(
    context: &NativeIntegrationContext,
    operation: &str,
) -> Result<IntegrationOperationReceipt> {
    atom(operation)?;
    let profile = context.profile()?;
    let guard = NativeDomainGuard::observe(profile, context.scope(), NativeDomain::Operations)?
        .context("TASK_CAPABILITY_SCOPE_RUNTIME_LEDGER_REQUIRED")?;
    let directory = guard.directory(profile)?;
    let ledger =
        IntegrationOperationStore::open_in(&directory, OsStr::new("data"), context.scope())?;
    let receipt = ledger
        .read(operation)?
        .context("TASK_CAPABILITY_SCOPE_RUNTIME_RECEIPT_REQUIRED")?;
    context.validate_scope(&receipt.scope)?;
    ensure!(
        receipt.port == "P-RUNTIME"
            && receipt.method == "acceptTask"
            && receipt.runtime_acceptance.is_some(),
        "TASK_CAPABILITY_SCOPE_ACCEPTANCE_REQUIRED"
    );
    let acceptance = receipt.runtime_acceptance.as_ref().unwrap();
    acceptance.validate()?;
    ensure!(
        !matches!(
            receipt.phase,
            IntegrationOperationPhase::Pending | IntegrationOperationPhase::Executing
        ),
        "TASK_CAPABILITY_SCOPE_ACCEPTANCE_REQUIRED"
    );
    if let Some(entity) = &receipt.entity_ref {
        ensure!(
            matches!((entity.kind,&acceptance.task_id,&acceptance.turn_id),
            (IntegrationEntityKind::Task,Some(id),_) if entity.id==*id)
                || matches!((entity.kind,&acceptance.turn_id),(IntegrationEntityKind::Turn,Some(id)) if entity.id==*id),
            "TASK_CAPABILITY_SCOPE_ACCEPTANCE_MISMATCH"
        );
    }
    ensure!(
        ledger.storage_directory_identity()?
            == directory
                .open_entry_handle(OsStr::new("data"))?
                .open_child_directory()?
                .directory_identity()?,
        "TASK_CAPABILITY_SCOPE_RUNTIME_LEDGER_CHANGED"
    );
    context.verify()?;
    Ok(receipt)
}
fn validate_witness(
    context: &NativeIntegrationContext,
    identity: &TurnAttemptIdentity,
    witness: &NativeTaskCapabilityScopeTurnWitness,
) -> Result<()> {
    context.validate_scope(&witness.scope)?;
    witness.record.validate()?;
    ensure!(
        witness.record.identity == *identity && witness.record.status.is_known(),
        "TASK_CAPABILITY_SCOPE_ACCEPTED_TURN_REQUIRED"
    );
    atom(&witness.session_directory_identity)?;
    atom(&witness.state_epoch)?;
    Ok(())
}
fn attempt_fingerprint(record: &TurnAttemptRecord) -> Result<String> {
    record.validate()?;
    digest(&serde_json::json!([
        record.identity,
        record.parent_attempt_id,
        record.retry_operation_id,
        record.accepted_at_ms,
        record.input_context_hash,
        record.request_fingerprint,
        record.retained_input,
        record.client_presentation
    ]))
}
pub(super) fn atom(value: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control),
        "TASK_CAPABILITY_SOURCE_ID_INVALID"
    );
    Ok(())
}
pub(super) fn digest<T: Serialize>(value: &T) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

#[cfg(test)]
mod tests;
