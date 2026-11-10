//! Personal memory review through the authenticated native profile.
use super::{NativeDomain, NativeDomainGuard, NativeIntegrationContext, NativeOperations};
use crate::app_server::integrations::knowledge::{
    KnowledgeHostContext, KnowledgePolicyEvaluator, KnowledgeResource, handle_memory,
    handle_memory_management,
};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::integrations::host::IntegrationMemoryMethod;
use kcoder_app_protocol::integrations::knowledge::MemoryListParams;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_engine::QueryEngine;
use kcoder_memory::integrations::knowledge::MemoryReviewStore;
use kcoder_types::integrations::core::*;
use serde_json::{Value, json};
use std::{
    ffi::OsStr,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) use kcoder_app_protocol::integrations::host::CAPABILITY_MEMORY_REVIEW_V1 as MEMORY_REVIEW_CAPABILITY;

pub(crate) struct NativeMemoryService {
    guard: NativeDomainGuard,
    store: MemoryReviewStore,
}

impl std::fmt::Debug for NativeMemoryService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeMemoryService { native_store: bound }")
    }
}

impl NativeMemoryService {
    /// Establish a real empty source only at an explicitly enabled native setup boundary.
    pub(crate) fn prepare_enabled(context: &NativeIntegrationContext) -> Result<()> {
        let policy = PersonalMemoryPolicy(context);
        let resource = KnowledgeResource {
            kind: "memory",
            id: "current-owner".into(),
            owner: IntegrationOwner::from(context.scope()),
        };
        let allowed = policy.evaluate_action(context.scope(), "memory.write", &resource)?;
        ensure!(
            allowed.decision == IntegrationPolicyDecision::Allow,
            "MEMORY_RESOURCE_DENIED"
        );
        let existing = Self::load(context)?;
        let witness = super::memory_setup::MemorySetupWitness::acquire(context)?;
        let service = match existing {
            Some(service) => service,
            None => {
                ensure!(witness.is_first_setup(), "MEMORY_SETUP_SOURCE_MISSING");
                match Self::initialize(context, "memory-feature-enable-v1") {
                    Ok(service) => service,
                    // A concurrent setup may have committed first. Reconcile by observing
                    // its complete native receipt; never retry an unknown initialization.
                    Err(error) => Self::load(context)?.ok_or(error)?,
                }
            }
        };
        <Self as crate::app_server::integrations::knowledge::NativeReviewedMemorySource>::verified_store(
            &service, context,
        )?;
        witness.verify(context)?;
        Ok(())
    }

    pub(crate) fn load(context: &NativeIntegrationContext) -> Result<Option<Self>> {
        let profile = context.profile()?;
        let Some(guard) =
            NativeDomainGuard::observe(profile, context.scope(), NativeDomain::Memory)?
        else {
            return Ok(None);
        };
        let directory = guard.directory(profile)?;
        let store = MemoryReviewStore::open_in(&directory, OsStr::new("data"), context.scope())?;
        let service = Self { guard, store };
        service.verify(context)?;
        Ok(Some(service))
    }

    fn initialize(context: &NativeIntegrationContext, operation_id: &str) -> Result<Self> {
        let (guard, store) = NativeDomainGuard::initialize(
            context.profile()?,
            context.scope(),
            NativeDomain::Memory,
            operation_id,
            |directory| {
                MemoryReviewStore::create_in(directory, OsStr::new("data"), context.scope())
            },
        )?;
        let service = Self { guard, store };
        service.verify(context)?;
        Ok(service)
    }

    fn verify(&self, context: &NativeIntegrationContext) -> Result<()> {
        let directory = self.guard.directory(context.profile()?)?;
        let entry = directory.open_entry_handle(OsStr::new("data"))?;
        let data = entry.open_child_directory()?;
        ensure!(
            data.directory_identity()? == self.store.storage_directory_identity()?,
            "MEMORY_NATIVE_STORAGE_CHANGED"
        );
        ensure!(
            self.store.owner() == &IntegrationOwner::from(context.scope()),
            "MEMORY_SCOPE_MISMATCH"
        );
        Ok(())
    }
}

impl crate::app_server::integrations::knowledge::NativeReviewedMemorySource
    for NativeMemoryService
{
    fn verified_store(&self, context: &NativeIntegrationContext) -> Result<&MemoryReviewStore> {
        self.verify(context)?;
        let policy = PersonalMemoryPolicy(context);
        let resource = KnowledgeResource {
            kind: "memory",
            id: "current-owner".into(),
            owner: IntegrationOwner::from(context.scope()),
        };
        let evaluation = policy.evaluate_action(context.scope(), "memory.read", &resource)?;
        ensure!(
            evaluation.decision == IntegrationPolicyDecision::Allow,
            "MEMORY_RESOURCE_DENIED"
        );
        Ok(&self.store)
    }
}

struct PersonalMemoryPolicy<'a>(&'a NativeIntegrationContext);
impl KnowledgePolicyEvaluator for PersonalMemoryPolicy<'_> {
    fn evaluate_action(
        &self,
        scope: &IntegrationScope,
        action: &str,
        resource: &KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation> {
        self.0.verify()?;
        let allowed = scope == self.0.scope()
            && scope
                .organization_id
                .as_ref()
                .is_none_or(|id| id.as_ref().is_none())
            && resource.owner == IntegrationOwner::from(scope)
            && resource.kind == "memory"
            && resource.id == "current-owner"
            && matches!(action, "memory.read" | "memory.write" | "memory.manage");
        Ok(IntegrationPolicyEvaluation {
            decision: if allowed {
                IntegrationPolicyDecision::Allow
            } else {
                IntegrationPolicyDecision::Deny
            },
            policy_revision: "native-personal-memory-v1".into(),
            reason_code: if allowed {
                "CURRENT_NATIVE_OWNER"
            } else {
                "NATIVE_RESOURCE_DENIED"
            }
            .into(),
        })
    }
}

pub(crate) fn memory_method(method: &str) -> Option<(&'static str, bool)> {
    IntegrationMemoryMethod::parse(method).map(IntegrationMemoryMethod::port_method)
}

/// This control route is not a model tool or a channel's arbitrary policy endpoint.
pub(crate) fn request_memory(
    method: &str,
    params: Value,
    engine: &QueryEngine,
    context: &mut NativeIntegrationContext,
    cached: &mut Option<NativeMemoryService>,
    operations: &mut Option<NativeOperations>,
) -> Result<IntegrationReply> {
    let (method, management) =
        memory_method(method).context("INTEGRATION_MEMORY_METHOD_UNSUPPORTED")?;
    // Thread-bound snapshot reads have their own native routing and authorization.
    ensure!(
        method != "readMemoryTaskSnapshot",
        "MEMORY_SNAPSHOT_THREAD_ROUTE_REQUIRED"
    );
    let request: IntegrationRequest =
        rpc_codec::decode(params).context("INTEGRATION_MEMORY_INVALID_REQUEST")?;
    let mutation = management || !matches!(method, "listMemories" | "readMemory");
    request.validate(mutation)?;
    context
        .refresh_configuration_revision(engine.active_model_configuration_summary()?.revision)?;
    let policy = PersonalMemoryPolicy(context);
    let action = if management {
        "memory.manage"
    } else if mutation {
        "memory.write"
    } else {
        "memory.read"
    };
    let resource = KnowledgeResource {
        kind: "memory",
        id: "current-owner".into(),
        owner: IntegrationOwner::from(context.scope()),
    };
    let evaluation = policy.evaluate_action(&request.scope, action, &resource)?;
    if evaluation.decision != IntegrationPolicyDecision::Allow {
        return Ok(failure(
            &request,
            IntegrationStatus::Rejected,
            "MEMORY_RESOURCE_DENIED",
            IntegrationRecovery::RequestAuthorization,
        ));
    }
    if cached.is_none() {
        *cached = NativeMemoryService::load(context)?;
    }
    let mut original = None;
    if mutation {
        let operation_id = request
            .operation_id
            .as_deref()
            .context("MEMORY_OPERATION_REQUIRED")?;
        if operations.is_none() {
            *operations = NativeOperations::load(context)?;
        }
        if operations.is_none() {
            *operations = Some(NativeOperations::initialize(context, operation_id)?);
        }
        let ledger = operations
            .as_ref()
            .context("INTEGRATION_OPERATIONS_UNAVAILABLE")?;
        let recorded = ledger.read(context, operation_id)?;
        // A legacy domain result without the original host intent is not a new intent's receipt.
        if recorded.is_none()
            && cached
                .as_ref()
                .map(|service| service.store.read_operation_result(operation_id))
                .transpose()?
                .flatten()
                .is_some()
        {
            return Ok(failure(
                &request,
                IntegrationStatus::Rejected,
                "MEMORY_OPERATION_CONFLICT",
                IntegrationRecovery::ExplicitUserDecision,
            ));
        }
        let (receipt, execute) = ledger.begin_memory(context, &request, method)?;
        if !execute {
            if receipt.phase == IntegrationOperationPhase::Rejected {
                let error = receipt
                    .error
                    .context("INTEGRATION_OPERATION_RECEIPT_INVALID")?;
                return Ok(failure(
                    &request,
                    IntegrationStatus::Rejected,
                    &error.code,
                    error.recovery,
                ));
            }
            if let Some(result) = cached
                .as_ref()
                .map(|service| service.store.read_operation_result(operation_id))
                .transpose()?
                .flatten()
            {
                if matches!(
                    receipt.phase,
                    IntegrationOperationPhase::Executing | IntegrationOperationPhase::Unknown
                ) {
                    ledger.transition(
                        context,
                        &receipt,
                        IntegrationOperationPhase::Completed,
                        None,
                    )?;
                }
                return Ok(completed(&request, json!({"memory":result})));
            }
            return Ok(failure(
                &request,
                IntegrationStatus::Unknown,
                "MEMORY_OPERATION_UNCONFIRMED",
                IntegrationRecovery::ReconcileOriginal,
            ));
        }
        original = Some(receipt);
    }
    if cached.is_none() && method == "proposeMemory" {
        // Validate the public structure before initializing the domain. The store validates content.
        let _: kcoder_app_protocol::integrations::knowledge::MemoryProposeParams =
            rpc_codec::decode(Value::Object(request.payload.clone()))?;
        *cached = Some(NativeMemoryService::initialize(
            context,
            request
                .operation_id
                .as_deref()
                .context("MEMORY_OPERATION_REQUIRED")?,
        )?);
    }
    let Some(service) = cached.as_ref() else {
        if method == "listMemories" {
            let list: MemoryListParams = rpc_codec::decode(Value::Object(request.payload.clone()))?;
            ensure!(list.after.is_none(), "MEMORY_INVALID_CURSOR");
            return Ok(completed(
                &request,
                json!({"page":{"items":[],"nextCursor":null}}),
            ));
        }
        let reply = failure(
            &request,
            IntegrationStatus::Rejected,
            "MEMORY_NOT_FOUND",
            IntegrationRecovery::None,
        );
        settle_memory_operation(context, operations.as_ref(), original.as_ref(), &reply)?;
        return Ok(reply);
    };
    service.verify(context)?;
    let now_ms = u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
    let host = KnowledgeHostContext {
        scope: context.scope(),
        now_ms,
        explicit_user_action: true,
        policy: &policy,
    };
    let reply = if management {
        handle_memory_management(method, &request, &host, &service.store)
    } else {
        handle_memory(method, &request, &host, &service.store)
    };
    if service.verify(context).is_err() {
        return Ok(failure(
            &request,
            if mutation {
                IntegrationStatus::Unknown
            } else {
                IntegrationStatus::Unavailable
            },
            "MEMORY_NATIVE_STORAGE_CHANGED",
            if mutation {
                IntegrationRecovery::ReconcileOriginal
            } else {
                IntegrationRecovery::RetryRead
            },
        ));
    }
    reply.validate()?;
    settle_memory_operation(context, operations.as_ref(), original.as_ref(), &reply)?;
    Ok(reply)
}

fn settle_memory_operation(
    context: &NativeIntegrationContext,
    ledger: Option<&NativeOperations>,
    original: Option<&IntegrationOperationReceipt>,
    reply: &IntegrationReply,
) -> Result<()> {
    let (Some(ledger), Some(original)) = (ledger, original) else {
        return Ok(());
    };
    let phase = match reply.status {
        IntegrationStatus::Completed => IntegrationOperationPhase::Completed,
        IntegrationStatus::Rejected => IntegrationOperationPhase::Rejected,
        _ => IntegrationOperationPhase::Unknown,
    };
    let error = if phase == IntegrationOperationPhase::Completed {
        None
    } else {
        Some(reply.error.as_ref().cloned().unwrap_or(IntegrationError {
            code: "MEMORY_OPERATION_UNCONFIRMED".into(),
            recovery: IntegrationRecovery::ReconcileOriginal,
            message_key: "integrations.memory.operationFailed".into(),
        }))
    };
    ledger.transition(context, original, phase, error)?;
    Ok(())
}

pub(crate) fn read_operation(
    params: Value,
    engine: &QueryEngine,
    context: &mut NativeIntegrationContext,
    operations: &mut Option<NativeOperations>,
    memory: &mut Option<NativeMemoryService>,
) -> Result<IntegrationReply> {
    let request: IntegrationRequest = rpc_codec::decode(params)?;
    request.validate(false)?;
    context
        .refresh_configuration_revision(engine.active_model_configuration_summary()?.revision)?;
    ensure!(
        request.scope == *context.scope(),
        "INTEGRATION_SCOPE_MISMATCH"
    );
    let input: kcoder_app_protocol::integrations::host::IntegrationOperationReadParams =
        rpc_codec::decode(Value::Object(request.payload.clone()))?;
    if operations.is_none() {
        *operations = NativeOperations::load(context)?;
    }
    let mut receipt = operations
        .as_ref()
        .map(|ledger| ledger.read(context, &input.operation_id))
        .transpose()?
        .flatten();
    if let Some(recorded) = &receipt
        && recorded.port == "P-MEMORY"
        && matches!(
            recorded.phase,
            IntegrationOperationPhase::Executing | IntegrationOperationPhase::Unknown
        )
    {
        if memory.is_none() {
            *memory = NativeMemoryService::load(context)?;
        }
        if let Some(service) = memory.as_ref() {
            service.verify(context)?;
            if service
                .store
                .read_operation_result(&input.operation_id)?
                .is_some()
            {
                let ledger = operations
                    .as_ref()
                    .context("INTEGRATION_OPERATIONS_UNAVAILABLE")?;
                // Repair only this already frozen host intent from its native successful domain receipt.
                receipt = Some(
                    match ledger.transition(
                        context,
                        recorded,
                        IntegrationOperationPhase::Completed,
                        None,
                    ) {
                        Ok(updated) => updated,
                        Err(_) => ledger
                            .read(context, &input.operation_id)?
                            .context("INTEGRATION_OPERATION_UNCONFIRMED")?,
                    },
                );
            }
        }
    }
    context.verify()?;
    Ok(completed(&request, json!({"receipt":receipt})))
}

fn completed(request: &IntegrationRequest, result: Value) -> IntegrationReply {
    envelope(
        request,
        IntegrationStatus::Completed,
        result.as_object().cloned(),
        None,
    )
}
fn failure(
    request: &IntegrationRequest,
    status: IntegrationStatus,
    code: &str,
    recovery: IntegrationRecovery,
) -> IntegrationReply {
    envelope(
        request,
        status,
        None,
        Some(IntegrationError {
            code: code.into(),
            recovery,
            message_key: "integrations.memory.operationFailed".into(),
        }),
    )
}
fn envelope(
    request: &IntegrationRequest,
    status: IntegrationStatus,
    result: Option<serde_json::Map<String, Value>>,
    error: Option<IntegrationError>,
) -> IntegrationReply {
    IntegrationReply {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: request.request_id.clone(),
        status,
        operation_id: request
            .operation_id
            .clone()
            .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        entity_revision: IntegrationNullable::Null,
        observed_at: chrono::Utc::now().to_rfc3339(),
        result: result.map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        error: error.map_or(IntegrationNullable::Null, IntegrationNullable::Value),
    }
}
