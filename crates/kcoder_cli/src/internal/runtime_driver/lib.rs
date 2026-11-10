//! Durable native command queue and owner-bound runtime receipts.
#[path = "../../app_server/integrations/knowledge/business_templates.rs"]
pub mod business_templates;
#[path = "child_records.rs"]
pub mod child_records;
#[path = "../../app_server/integrations/core/runtime_driver/errors.rs"]
mod errors;
#[path = "../../app_server/integrations/core/runtime_driver/observations.rs"]
mod observations;
#[path = "../../app_server/integrations/core/runtime_driver/output_observation.rs"]
mod output_observation;
#[path = "recovery.rs"]
mod recovery;
#[path = "../../app_server/integrations/core/runtime_driver/source_intent.rs"]
mod source_intent;
#[path = "../../app_server/integrations/core/runtime_driver/storage.rs"]
mod storage;
#[path = "submission.rs"]
mod submission;
#[path = "../../app_server/integrations/core/runtime_driver/task_state.rs"]
mod task_state;
#[path = "../../app_server/integrations/core/runtime_driver/types.rs"]
mod types;
#[path = "workflow_spec.rs"]
mod workflow_spec;

pub use business_templates::list_business_templates;

use anyhow::{Context, Result, ensure};
pub use errors::configuration_rejection_code;
#[cfg(any(test, feature = "test-oracle"))]
pub use errors::public_error;
use kcoder_integration_storage::integrations::core::{
    IntegrationOperationBegin, IntegrationOperationStore, IntegrationOperationUpdate,
};
use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use kcoder_types::integrations::core::*;
use sha2::{Digest, Sha256};
pub use source_intent::NativeRuntimeSourceIntent;
use std::{
    collections::{BTreeMap, VecDeque},
    ffi::OsStr,
    sync::Arc,
};
pub use storage::{RuntimeBindingPrewriteConflict, RuntimeBindings};
pub use submission::required_thread;
pub use task_state::OriginalRuntimeTaskEvidence;
pub use types::*;

pub const MAX_QUEUED: usize = 128;

pub struct RuntimeStorage {
    accepting: std::sync::Mutex<()>,
    guard: NativeDomainGuard,
    profile: kcoder_config::PrivateDirectory,
    ledger: IntegrationOperationStore,
    bindings: RuntimeBindings,
}
/// Pins storage for one accepted operation. Each read verifies the current
/// owner and reopens its two receipts. The result never grants an effect.
pub struct NativeRuntimeAcceptanceReader {
    storage: Arc<RuntimeStorage>,
    scope: IntegrationScope,
    operation: String,
}

impl NativeRuntimeAcceptanceReader {
    pub fn open(context: &NativeIntegrationContext, operation: &str) -> Result<Self> {
        let storage =
            NativeRuntimeDriver::observe_storage(context)?.context("RUNTIME_UNAVAILABLE")?;
        Ok(Self {
            storage,
            scope: context.scope().clone(),
            operation: operation.to_owned(),
        })
    }

    pub fn read(
        &self,
        context: &NativeIntegrationContext,
    ) -> Result<Option<IntegrationRuntimeAcceptance>> {
        context.validate_scope(&self.scope)?;
        self.storage.verify_ledger()?;
        self.storage.bindings.verify_directory_entry()?;
        Ok(self
            .storage
            .read_accepted_operation(context, &self.operation)?
            .map(|(_, accepted)| accepted))
    }
}

impl RuntimeStorage {
    pub fn bindings(&self) -> &RuntimeBindings {
        &self.bindings
    }

    pub fn read_receipt(&self, operation: &str) -> Result<Option<IntegrationOperationReceipt>> {
        self.ledger.read(operation)
    }

    #[cfg(feature = "test-oracle")]
    pub fn test_domain_directory(&self) -> Result<kcoder_config::PrivateDirectory> {
        self.guard.directory(&self.profile)
    }

    #[cfg(feature = "test-oracle")]
    pub fn namespace_id(&self) -> &str {
        self.guard.namespace_id()
    }

    pub fn verify(&self) -> Result<()> {
        self.verify_ledger()?;
        self.bindings.verify()
    }
    pub fn verify_ledger(&self) -> Result<()> {
        let directory = self.guard.directory(&self.profile)?;
        let data = directory
            .open_entry_handle(OsStr::new("data"))?
            .open_child_directory()?;
        ensure!(
            data.directory_identity()? == self.ledger.storage_directory_identity()?,
            "RUNTIME_LEDGER_CHANGED"
        );
        Ok(())
    }
    fn read_accepted_operation(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<(RuntimeBinding, IntegrationRuntimeAcceptance)>> {
        let Some(accepted) = self
            .ledger
            .read(operation)?
            .and_then(|receipt| receipt.runtime_acceptance)
        else {
            return Ok(None);
        };
        let binding = self
            .bindings
            .get(operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        context.validate_scope(&binding.source_scope)?;
        ensure!(
            binding.acceptance.as_ref() == Some(&accepted),
            "RUNTIME_ACCEPTANCE_CONFLICT"
        );
        Ok(Some((binding, accepted)))
    }
    fn transition(
        &self,
        operation: &str,
        phase: IntegrationOperationPhase,
        acceptance: Option<IntegrationRuntimeAcceptance>,
        error: Option<IntegrationError>,
    ) -> Result<IntegrationOperationReceipt> {
        self.verify()?;
        let current = self
            .ledger
            .read(operation)?
            .context("RUNTIME_OPERATION_MISSING")?;
        if current.phase == phase {
            ensure!(
                acceptance
                    .as_ref()
                    .is_none_or(|value| current.runtime_acceptance.as_ref() == Some(value)),
                "RUNTIME_ACCEPTANCE_CONFLICT"
            );
            return Ok(current);
        }
        let entity_ref = acceptance
            .as_ref()
            .map(|value| -> Result<_> {
                value.validate()?;
                let (kind, id) = match (&value.task_id, &value.turn_id) {
                    (Some(id), _) => (IntegrationEntityKind::Task, id.clone()),
                    (_, Some(id)) => (IntegrationEntityKind::Turn, id.clone()),
                    _ => anyhow::bail!("RUNTIME_ACCEPTANCE_UNCONFIRMED"),
                };
                Ok(IntegrationEntityRef {
                    kind,
                    id,
                    revision: None,
                })
            })
            .transpose()?;
        self.ledger.compare_and_swap(
            operation,
            IntegrationOperationUpdate {
                expected_revision: current.revision,
                phase,
                entity_ref,
                error,
                runtime_acceptance: acceptance,
                observed_at_ms: now()?,
            },
        )
    }
    pub fn accept(
        &self,
        mut binding: RuntimeBinding,
        acceptance: IntegrationRuntimeAcceptance,
    ) -> Result<RuntimeBinding> {
        let _accepting = self
            .accepting
            .lock()
            .map_err(|_| anyhow::anyhow!("RUNTIME_ACCEPTANCE_UNAVAILABLE"))?;
        acceptance.validate()?;
        ensure!(
            binding.thread_id.as_deref() == Some(acceptance.thread_id.as_str()),
            "RUNTIME_NATIVE_IDENTITY_MISMATCH"
        );
        if let Some(original) = &binding.acceptance {
            ensure!(original == &acceptance, "RUNTIME_ACCEPTANCE_CONFLICT");
        } else if let Some(current) = self.bindings.get(&binding.operation_id)?.filter(|current| {
            current.acceptance.as_ref() == Some(&acceptance)
                && current.intent_sha256 == binding.intent_sha256
        }) {
            binding = current;
        }
        if binding.acceptance.is_none() {
            binding.phase = RuntimePhase::Accepted;
            binding.task_state = acceptance.state;
            binding.acceptance = Some(acceptance.clone());
            let revision = binding.revision;
            binding = self.bindings.save(binding, Some(revision))?;
        }
        let current = self
            .ledger
            .read(&binding.operation_id)?
            .context("RUNTIME_OPERATION_MISSING")?;
        if !current.phase.is_terminal()
            && current.phase != IntegrationOperationPhase::CancelRequested
        {
            self.transition(
                &binding.operation_id,
                IntegrationOperationPhase::Accepted,
                Some(acceptance),
                None,
            )?;
        }
        Ok(binding)
    }
    pub fn unknown(&self, mut binding: RuntimeBinding, code: &'static str) -> Result<()> {
        binding.recovery_from = Some(binding.phase);
        binding.phase = RuntimePhase::Unknown;
        binding.task_state = IntegrationTaskState::OutcomeUnknown;
        binding.error = Some(safe_error(code, IntegrationRecovery::ReconcileOriginal));
        let operation = binding.operation_id.clone();
        let revision = binding.revision;
        self.bindings.save(binding, Some(revision))?;
        let receipt = self
            .ledger
            .read(&operation)?
            .context("RUNTIME_OPERATION_MISSING")?;
        if !receipt.phase.is_terminal() && receipt.phase != IntegrationOperationPhase::Unknown {
            self.transition(
                &operation,
                IntegrationOperationPhase::Unknown,
                None,
                Some(safe_error(code, IntegrationRecovery::ReconcileOriginal)),
            )?;
        }
        Ok(())
    }
}

/// Native context and policy are in-process capabilities. Caller JSON can
/// neither create a driver owner nor finish a generated command ticket.
pub struct NativeRuntimeDriver {
    storage: Arc<RuntimeStorage>,
    queue: VecDeque<String>,
    pending: BTreeMap<String, NativeRuntimeTicket>,
    tracked: BTreeMap<(String, String), String>,
}
impl std::fmt::Debug for NativeRuntimeDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeRuntimeDriver { native_owner: bound }")
    }
}
impl NativeRuntimeDriver {
    pub fn storage(&self) -> &Arc<RuntimeStorage> {
        &self.storage
    }

    pub fn is_pending(&self, ticket: &NativeRuntimeTicket) -> bool {
        self.pending.get(ticket.id()) == Some(ticket)
    }

    pub fn clear_pending(&mut self, ticket: &NativeRuntimeTicket) {
        if self.is_pending(ticket) {
            self.pending.remove(ticket.id());
        }
    }

    #[cfg(feature = "test-oracle")]
    pub fn test_pending(&mut self) -> &mut BTreeMap<String, NativeRuntimeTicket> {
        &mut self.pending
    }

    #[cfg(feature = "test-oracle")]
    pub fn test_queue(&mut self) -> &mut VecDeque<String> {
        &mut self.queue
    }

    pub fn load(context: &NativeIntegrationContext) -> Result<Option<Self>> {
        Self::observe_storage(context)?
            .map(Self::rehydrate)
            .transpose()
    }
    fn observe_storage(context: &NativeIntegrationContext) -> Result<Option<Arc<RuntimeStorage>>> {
        let profile = context.profile()?;
        let Some(guard) =
            NativeDomainGuard::observe(profile, context.scope(), NativeDomain::Operations)?
        else {
            return Ok(None);
        };
        let directory = guard.directory(profile)?;
        let Some(bindings) = RuntimeBindings::open(&directory, context.scope())? else {
            return Ok(None);
        };
        let ledger =
            IntegrationOperationStore::open_in(&directory, OsStr::new("data"), context.scope())?;
        Self::verified_storage(context, guard, ledger, bindings).map(Some)
    }

    /// Read one accepted operation without rebuilding the execution index.
    /// This is receipt evidence only. The caller still checks current authority.
    pub fn read_original_acceptance(
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<IntegrationRuntimeAcceptance>> {
        Ok(Self::read_accepted_operation(context, operation)?.map(|(_, accepted)| accepted))
    }

    fn read_accepted_operation(
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<(RuntimeBinding, IntegrationRuntimeAcceptance)>> {
        let Some(storage) = Self::observe_storage(context)? else {
            return Ok(None);
        };
        storage.read_accepted_operation(context, operation)
    }
    /// Only an authorized first mutation may initialize private storage.
    pub fn initialize(context: &NativeIntegrationContext, operation: &str) -> Result<Self> {
        context.verify()?;
        if let Some(guard) = NativeDomainGuard::observe(
            context.profile()?,
            context.scope(),
            NativeDomain::Operations,
        )? {
            let directory = guard.directory(context.profile()?)?;
            let ledger = IntegrationOperationStore::open_in(
                &directory,
                OsStr::new("data"),
                context.scope(),
            )?;
            let bindings = match RuntimeBindings::open(&directory, context.scope())? {
                Some(value) => value,
                None => RuntimeBindings::create(&directory, context.scope())?,
            };
            return Self::assemble(context, guard, ledger, bindings);
        }
        let (guard, (ledger, bindings)) = NativeDomainGuard::initialize(
            context.profile()?,
            context.scope(),
            NativeDomain::Operations,
            operation,
            |directory| {
                Ok((
                    IntegrationOperationStore::create_in(
                        directory,
                        OsStr::new("data"),
                        context.scope(),
                    )?,
                    RuntimeBindings::create(directory, context.scope())?,
                ))
            },
        )?;
        Self::assemble(context, guard, ledger, bindings)
    }
    fn assemble(
        context: &NativeIntegrationContext,
        guard: NativeDomainGuard,
        ledger: IntegrationOperationStore,
        bindings: RuntimeBindings,
    ) -> Result<Self> {
        Self::rehydrate(Self::verified_storage(context, guard, ledger, bindings)?)
    }
    fn verified_storage(
        context: &NativeIntegrationContext,
        guard: NativeDomainGuard,
        ledger: IntegrationOperationStore,
        bindings: RuntimeBindings,
    ) -> Result<Arc<RuntimeStorage>> {
        let profile = context.profile()?.duplicate_handle()?;
        let storage = Arc::new(RuntimeStorage {
            accepting: std::sync::Mutex::new(()),
            guard,
            profile,
            ledger,
            bindings,
        });
        storage.verify()?;
        Ok(storage)
    }
    fn rehydrate(storage: Arc<RuntimeStorage>) -> Result<Self> {
        let mut driver = Self {
            storage: storage.clone(),
            queue: VecDeque::new(),
            pending: BTreeMap::new(),
            tracked: BTreeMap::new(),
        };
        storage.bindings.visit(|binding| driver.track(binding))?;
        Ok(driver)
    }
    pub fn check(&self, context: &NativeIntegrationContext) -> Result<()> {
        self.check_owner(context)?;
        self.storage.verify()
    }
    fn check_owner(&self, context: &NativeIntegrationContext) -> Result<()> {
        context.verify()?;
        ensure!(
            IntegrationOwner::from(context.scope()) == self.storage.bindings.owner(),
            "RUNTIME_OWNER_MISMATCH"
        );
        Ok(())
    }
    fn checked_binding(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<RuntimeBinding> {
        self.check_owner(context)?;
        self.storage.verify_ledger()?;
        // The binding read verifies its own owner, initialization and lock.
        self.storage
            .bindings
            .get(operation)?
            .context("RUNTIME_BINDING_MISSING")
    }
    /// Invoke after current native policy, resource, readiness and model preparation.
    pub fn accept_task(
        &mut self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        spec: PreparedRuntimeTask,
    ) -> Result<RuntimeSubmission> {
        request.validate_method(IntegrationPort::Runtime, "acceptTask")?;
        context.check_captured_scope(&request.scope)?;
        spec.validate()?;
        // check() verifies the live context before any operation-store access.
        self.check(context)?;
        let operation = request
            .operation_id
            .clone()
            .context("RUNTIME_OPERATION_INVALID")?;
        if let Some(receipt) = self.storage.ledger.read(&operation)? {
            self.storage
                .ledger
                .begin(request, "P-RUNTIME", "acceptTask", now()?)?;
            if let Some(binding) = self.storage.bindings.get(&operation)? {
                ensure!(
                    binding.intent_sha256 == prepared_intent(request, &spec)?,
                    "RUNTIME_INTENT_CONFLICT"
                );
            }
            return Ok(match receipt.runtime_acceptance {
                Some(value) => RuntimeSubmission::Known(value),
                None => RuntimeSubmission::Unconfirmed,
            });
        }
        ensure!(self.queue.len() < MAX_QUEUED, "RUNTIME_QUEUE_CAPACITY");
        // Replays above use the original receipt even if its source was removed.
        // First admission requires the actual normalized, immutable definition.
        if let Some(workflow) = &spec.configuration.workflow {
            workflow.resolve_pinned(context)?;
        }
        let IntegrationOperationBegin::Created(_) =
            self.storage
                .ledger
                .begin(request, "P-RUNTIME", "acceptTask", now()?)?
        else {
            return Ok(RuntimeSubmission::Unconfirmed);
        };
        self.storage
            .transition(&operation, IntegrationOperationPhase::Executing, None, None)?;
        let native_id = hash(&serde_json::to_vec(&(
            IntegrationOwner::from(&request.scope),
            &operation,
        ))?);
        let thread_id = spec.existing_thread_id.clone();
        let phase = if thread_id.is_some() {
            RuntimePhase::ConfigureQueued
        } else {
            RuntimePhase::ThreadQueued
        };
        let binding = RuntimeBinding {
            version: 1,
            revision: 0,
            owner: IntegrationOwner::from(&request.scope),
            operation_id: operation.clone(),
            intent_sha256: prepared_intent(request, &spec)?,
            source_scope: request.scope.clone(),
            original_request: request.clone(),
            cancel_operation: None,
            cancel_request: None,
            recovery_from: None,
            spec,
            phase,
            thread_request_id: format!("integration-thread-{native_id}"),
            client_message_id: format!("integration-message-{native_id}"),
            thread_id,
            acceptance: None,
            task_state: IntegrationTaskState::Queued,
            output: None,
            output_observation: None,
            artifact_refs: vec![],
            pending_interactions: vec![],
            child_intents: vec![],
            error: None,
        };
        self.storage.bindings.save(binding, None)?;
        self.queue.push_back(operation);
        Ok(RuntimeSubmission::Queued)
    }
    pub fn read_operation(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<IntegrationOperationReceipt>> {
        self.check(context)?;
        self.storage.ledger.read(operation)
    }
    /// Read only the original host-prepared policy; request/source labels do not authorize delegation.
    pub fn read_execution_configuration(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<RuntimeExecutionConfiguration> {
        let binding = self.checked_binding(context, operation)?;
        context.validate_scope(&binding.source_scope)?;
        binding.spec.validate()?;
        ensure!(
            binding.acceptance.is_some(),
            "RUNTIME_ACCEPTANCE_UNCONFIRMED"
        );
        Ok(binding.spec.configuration)
    }
    pub fn read_task(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<IntegrationRuntimeTask> {
        self.read_task_with_revision(context, operation)
            .map(|(task, _)| task)
    }

    /// Resolve the frozen public task reference to its original private binding;
    /// this never substitutes the current/latest resident turn.
    pub fn operation_for_reference(
        &self,
        context: &NativeIntegrationContext,
        reference: &IntegrationRuntimeReadTaskParams,
    ) -> Result<String> {
        self.project_reference(context, reference, |binding| {
            Ok(binding.operation_id.clone())
        })
    }
    fn project_reference<T>(
        &self,
        context: &NativeIntegrationContext,
        reference: &IntegrationRuntimeReadTaskParams,
        project: impl Fn(&RuntimeBinding) -> Result<T>,
    ) -> Result<T> {
        self.check(context)?;
        reference.validate()?;
        let wanted = reference
            .task_id
            .as_ref()
            .or(reference.turn_id.as_ref())
            .context("RUNTIME_NATIVE_REFERENCE_INVALID")?;
        let mut matched = None;
        let mut inspect = |binding: &RuntimeBinding| -> Result<()> {
            if let Some(accepted) = &binding.acceptance {
                let same_kind = if reference.task_id.is_some() {
                    accepted.task_id.as_ref() == Some(wanted)
                        && reference
                            .turn_id
                            .as_ref()
                            .is_none_or(|turn| accepted.turn_id.as_ref() == Some(turn))
                } else {
                    accepted.task_id.is_none() && accepted.turn_id.as_ref() == Some(wanted)
                };
                if same_kind
                    && reference
                        .thread_id
                        .as_ref()
                        .is_none_or(|thread| thread == &accepted.thread_id)
                {
                    ensure!(matched.is_none(), "RUNTIME_NATIVE_REFERENCE_CONFLICT");
                    matched = Some(project(binding)?);
                }
            }
            Ok(())
        };
        let indexed: Vec<_> = if let Some(thread) = &reference.thread_id {
            self.tracked
                .get(&(thread.clone(), wanted.clone()))
                .into_iter()
                .collect()
        } else {
            self.tracked
                .iter()
                .filter(|((_, id), _)| id == wanted)
                .map(|(_, operation)| operation)
                .collect()
        };
        if indexed.is_empty() {
            // A native workflow observer may have committed before Root handles
            // its job response. Bound the exceptional scan; routine polls use
            // the exact native index and read one operation only.
            self.storage.bindings.visit(&mut inspect)?;
        } else {
            for operation in indexed {
                let binding = self
                    .storage
                    .bindings
                    .get(operation)?
                    .context("RUNTIME_BINDING_MISSING")?;
                inspect(&binding)?;
            }
        }
        matched.context("RUNTIME_NATIVE_REFERENCE_NOT_OBSERVED")
    }
    pub fn read_task_reference(
        &self,
        context: &NativeIntegrationContext,
        reference: &IntegrationRuntimeReadTaskParams,
    ) -> Result<IntegrationRuntimeTask> {
        self.read_task(context, &self.operation_for_reference(context, reference)?)
    }
    #[cfg(any(test, feature = "test-oracle"))]
    pub fn has_commands(&self) -> bool {
        !self.queue.is_empty()
    }
    pub fn track(&mut self, binding: &RuntimeBinding) -> Result<()> {
        if let Some(acceptance) = &binding.acceptance
            && let Some(id) = acceptance.task_id.as_ref().or(acceptance.turn_id.as_ref())
        {
            let key = (acceptance.thread_id.clone(), id.clone());
            ensure!(
                self.tracked
                    .get(&key)
                    .is_none_or(|operation| operation == &binding.operation_id),
                "RUNTIME_NATIVE_REFERENCE_CONFLICT"
            );
            self.tracked.insert(key, binding.operation_id.clone());
        }
        Ok(())
    }
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn prepared_intent(request: &IntegrationRequest, spec: &PreparedRuntimeTask) -> Result<String> {
    let mut scope = request.scope.clone();
    scope.organization_id = IntegrationOwner::from(&scope).organization_id;
    // Transport request IDs and wait budgets do not change a pinned operation.
    let value = serde_json::json!({"version":1,"contractVersion":request.contract_version,
        "scope":scope,"expectedRevision":request.expected_revision,"payload":request.payload,"prepared":spec});
    fn canonical(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(map) => serde_json::Value::Object(
                map.into_iter()
                    .map(|(key, value)| (key, canonical(value)))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(canonical).collect())
            }
            other => other,
        }
    }
    Ok(hash(&serde_json::to_vec(&canonical(value))?))
}
fn now() -> Result<u64> {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis(),
    )
    .context("RUNTIME_CLOCK_UNAVAILABLE")
}
pub fn safe_error(code: &'static str, recovery: IntegrationRecovery) -> IntegrationError {
    IntegrationError {
        code: code.into(),
        recovery,
        message_key: "integrations.runtimeOperationFailed".into(),
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
