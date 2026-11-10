//! Native issuer ownership and original operation reconciliation.

#[path = "policy_host/native_code_services.rs"]
mod native_code_services;
#[path = "policy_host/process_gate.rs"]
mod process_gate;
use crate::NativeOperations;
use anyhow::{Context, Result, ensure};
use kcoder_native_delegation::{
    AuthenticatedDelegationPolicy, AuthenticatedDelegationSubject, DelegationPermit,
    NativeDelegationAuthority,
};
use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use kcoder_types::integrations::core::*;
use std::ffi::OsStr;

pub struct NativePolicyService {
    guard: NativeDomainGuard,
    authority: std::sync::Arc<NativeDelegationAuthority>,
    process_gate: std::sync::Arc<process_gate::Gate>,
}

impl std::fmt::Debug for NativePolicyService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativePolicyService { issuer: native, proof: redacted }")
    }
}

impl NativePolicyService {
    pub fn load(context: &NativeIntegrationContext) -> Result<Option<Self>> {
        let profile = context.profile()?;
        let Some(guard) =
            NativeDomainGuard::observe(profile, context.scope(), NativeDomain::Policy)?
        else {
            return Ok(None);
        };
        let directory = guard.directory(profile)?;
        let process_gate = process_gate::for_directory(&directory)?;
        let authority = {
            let _gate = process_gate
                .lock()
                .map_err(|_| anyhow::anyhow!("DELEGATION_PROCESS_GATE_UNAVAILABLE"))?;
            if let Some(authority) = process_gate.authority.get() {
                authority.clone()
            } else {
                let authority = std::sync::Arc::new(NativeDelegationAuthority::open_in(
                    &directory,
                    OsStr::new("issuer"),
                    context.scope(),
                )?);
                let _ = process_gate.authority.set(authority.clone());
                authority
            }
        };
        let service = Self {
            guard,
            authority,
            process_gate,
        };
        service.verify(context)?;
        Ok(Some(service))
    }

    fn initialize(context: &NativeIntegrationContext, operation: &str) -> Result<Self> {
        let (guard, authority) = NativeDomainGuard::initialize(
            context.profile()?,
            context.scope(),
            NativeDomain::Policy,
            operation,
            |directory| {
                let gate = process_gate::for_directory(directory)?;
                let _gate = gate
                    .lock()
                    .map_err(|_| anyhow::anyhow!("DELEGATION_PROCESS_GATE_UNAVAILABLE"))?;
                NativeDelegationAuthority::create_in(
                    directory,
                    OsStr::new("issuer"),
                    context.scope(),
                )
            },
        )?;
        let process_gate = process_gate::for_directory(&guard.directory(context.profile()?)?)?;
        let authority = std::sync::Arc::new(authority);
        let _ = process_gate.authority.set(authority.clone());
        let service = Self {
            guard,
            authority,
            process_gate,
        };
        service.verify(context)?;
        Ok(service)
    }

    pub fn verify(&self, context: &NativeIntegrationContext) -> Result<()> {
        let directory = self.guard.directory(context.profile()?)?;
        let issuer = directory
            .open_entry_handle(OsStr::new("issuer"))?
            .open_child_directory()?;
        ensure!(
            issuer.directory_identity()? == self.authority.storage_directory_identity()?,
            "DELEGATION_NATIVE_STORAGE_CHANGED"
        );
        Ok(())
    }

    pub fn read(
        &self,
        context: &NativeIntegrationContext,
        id: &str,
        now_ms: u64,
    ) -> Result<Option<IntegrationDelegationView>> {
        self.with_authority_at(context, now_ms, |authority, now| authority.read(id, now))
    }

    pub fn revoke(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
        reference: &IntegrationRevisionRef,
        now_ms: u64,
    ) -> Result<IntegrationDelegationRevokeResult> {
        self.verify(context)?;
        let result = self.with_authority_at(context, now_ms, |authority, now| {
            authority.revoke(operation, &reference.id, &reference.revision, now)
        })?;
        self.verify(context)?;
        Ok(IntegrationDelegationRevokeResult {
            delegation_ref: result.delegation_ref,
            status: IntegrationDelegationStatus::Revoked,
            cancellation_requested: false,
            cancellation_settled: false,
        })
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep the original native caller, signed policy, exact resource set and time explicit"
    )]
    pub fn authorize(
        &self,
        context: &NativeIntegrationContext,
        reference: &IntegrationRevisionRef,
        subject: &AuthenticatedDelegationSubject,
        policy: &AuthenticatedDelegationPolicy,
        action: IntegrationDelegationAction,
        resources: &[IntegrationEntityRef],
        now_ms: u64,
    ) -> Result<DelegationPermit> {
        self.verify(context)?;
        ensure!(
            IntegrationOwner::from(&policy.scope) == IntegrationOwner::from(context.scope()),
            "DELEGATION_NATIVE_OWNER_MISMATCH"
        );
        let permit = self.with_authority_at(context, now_ms, |authority, now| {
            let proof = authority.read_private_proof(reference)?;
            authority.authorize(&proof, policy, subject, action, resources, now)
        })?;
        self.verify(context)?;
        Ok(permit)
    }

    pub fn revalidate(
        &self,
        context: &NativeIntegrationContext,
        permit: &DelegationPermit,
        subject: &AuthenticatedDelegationSubject,
        policy: &AuthenticatedDelegationPolicy,
        now_ms: u64,
    ) -> Result<()> {
        self.verify(context)?;
        ensure!(
            IntegrationOwner::from(&policy.scope) == IntegrationOwner::from(context.scope()),
            "DELEGATION_NATIVE_OWNER_MISMATCH"
        );
        self.with_authority_at(context, now_ms, |authority, now| {
            authority.revalidate(permit, policy, subject, now)
        })?;
        self.verify(context)
    }
    fn with_authority_at<T>(
        &self,
        context: &NativeIntegrationContext,
        now_ms: u64,
        work: impl FnOnce(&NativeDelegationAuthority, u64) -> Result<T>,
    ) -> Result<T> {
        let started = std::time::Instant::now();
        let _gate = self
            .process_gate
            .lock()
            .map_err(|_| anyhow::anyhow!("DELEGATION_PROCESS_GATE_UNAVAILABLE"))?;
        self.verify(context)?;
        let now = now_ms
            .checked_add(u64::try_from(started.elapsed().as_millis())?)
            .context("DELEGATION_TIME_OVERFLOW")?;
        let result = work(&self.authority, now);
        self.verify(context)?;
        result
    }
    fn read_issue(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
        now_ms: u64,
    ) -> Result<Option<IntegrationDelegationView>> {
        self.with_authority_at(context, now_ms, |authority, now| {
            authority.read_issue_operation(operation, now)
        })
    }
}

/// Historical grant fixtures exercise the old journal format only.
/// Production channel admission cannot issue member delegations.
#[cfg(any(test, feature = "test-oracle"))]
pub fn prepare_native_delegation(
    context: &NativeIntegrationContext,
    request: &IntegrationRequest,
    subject: &AuthenticatedDelegationSubject,
    policy: &AuthenticatedDelegationPolicy,
    service: &mut Option<NativePolicyService>,
    operations: &mut Option<NativeOperations>,
    now_ms: u64,
) -> Result<IntegrationDelegationView> {
    request.validate_method(IntegrationPort::Policy, "prepareDelegation")?;
    context.validate_scope(&request.scope)?;
    ensure!(
        policy.scope == *context.scope(),
        "DELEGATION_NATIVE_POLICY_MISMATCH"
    );
    let params: IntegrationDelegationPrepareParams =
        serde_json::from_value(serde_json::Value::Object(request.payload.clone()))?;
    params.validate()?;
    policy.authorize_issue(&params, subject)?;
    let operation = request
        .operation_id
        .as_deref()
        .context("DELEGATION_OPERATION_REQUIRED")?;
    if service.is_none() {
        *service = NativePolicyService::load(context)?;
    }
    if operations.is_none() {
        *operations = NativeOperations::load(context)?;
    }
    if operations.is_none() {
        *operations = Some(NativeOperations::initialize(context, operation)?);
    }
    let ledger = operations
        .as_ref()
        .context("INTEGRATION_OPERATIONS_UNAVAILABLE")?;
    let previous = ledger.read(context, operation)?;
    if previous.is_none()
        && service
            .as_ref()
            .map(|s| s.read_issue(context, operation, now_ms))
            .transpose()?
            .flatten()
            .is_some()
    {
        anyhow::bail!("DELEGATION_ORIGINAL_INTENT_MISSING");
    }
    // Authenticated reconnects may reconcile the original frozen intent, never
    // change its source or silently turn an unresolved operation into a new issue.
    let mut frozen = request.clone();
    if let Some(previous) = &previous {
        ensure!(
            IntegrationOwner::from(&previous.scope) == IntegrationOwner::from(context.scope()),
            "DELEGATION_NATIVE_OWNER_MISMATCH"
        );
        frozen.scope = previous.scope.clone();
    }
    let (receipt, execute) = ledger.begin(context, &frozen, "P-POLICY", "prepareDelegation")?;
    if previous.is_some() || !execute {
        let original = service
            .as_ref()
            .map(|s| s.read_issue(context, operation, now_ms))
            .transpose()?
            .flatten();
        let Some(original) = original else {
            mark_unknown(context, ledger, &receipt)?;
            anyhow::bail!("DELEGATION_ORIGINAL_RESULT_UNKNOWN");
        };
        if matches!(
            receipt.phase,
            IntegrationOperationPhase::Executing | IntegrationOperationPhase::Unknown
        ) {
            settle(context, ledger, &receipt, &original)?;
        }
        return Ok(original);
    }
    if service.is_none() {
        *service = Some(NativePolicyService::initialize(context, operation)?);
    }
    let service = service
        .as_ref()
        .context("DELEGATION_NATIVE_ISSUER_UNAVAILABLE")?;
    service.verify(context)?;
    let issued = service.with_authority_at(context, now_ms, |authority, now| {
        authority.issue(operation, &params, subject, policy, now)
    });
    let (result, _private_proof): (IntegrationDelegationView, SignedDelegation) = match issued {
        Ok(result) => result,
        Err(error) => {
            mark_unknown(context, ledger, &receipt)?;
            return Err(error);
        }
    };
    service.verify(context)?;
    settle(context, ledger, &receipt, &result)?;
    Ok(result)
}

#[cfg(any(test, feature = "test-oracle"))]
fn settle(
    context: &NativeIntegrationContext,
    ledger: &NativeOperations,
    original: &IntegrationOperationReceipt,
    result: &IntegrationDelegationView,
) -> Result<()> {
    ledger.transition_with_entity(
        context,
        original,
        IntegrationOperationPhase::Completed,
        Some(IntegrationEntityRef {
            kind: IntegrationEntityKind::Delegation,
            id: result.delegation_ref.id.clone(),
            revision: Some(result.delegation_ref.revision.clone()),
        }),
        None,
    )?;
    Ok(())
}

#[cfg(any(test, feature = "test-oracle"))]
fn mark_unknown(
    context: &NativeIntegrationContext,
    ledger: &NativeOperations,
    original: &IntegrationOperationReceipt,
) -> Result<()> {
    if matches!(
        original.phase,
        IntegrationOperationPhase::Executing | IntegrationOperationPhase::Pending
    ) {
        ledger.transition(
            context,
            original,
            IntegrationOperationPhase::Unknown,
            Some(IntegrationError {
                code: "DELEGATION_ORIGINAL_RESULT_UNKNOWN".into(),
                recovery: IntegrationRecovery::ReconcileOriginal,
                message_key: "integrations.policy.operationUnknown".into(),
            }),
        )?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "policy_host/tests.rs"]
mod tests;

#[cfg(any(test, feature = "test-oracle"))]
use kcoder_native_delegation::SignedDelegation;
