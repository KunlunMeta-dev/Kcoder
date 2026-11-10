//! Child admission metadata on the original native runtime binding, never a new actor ledger.
use super::*;
use kcoder_config::PrivateDirectory;
use kcoder_engine::{
    QueryEngine,
    integrations::core::{NativeChildAdmissionRequest, NativeWorkflowParentFacts},
};
use kcoder_runtime_driver::child_records::validate_records;
use kcoder_runtime_driver::child_records::{
    ChildIntent, ChildIntentPhase, ChildIntentRecord, MAX_CHILDREN, facts, sha,
};
use kcoder_state::turn_attempt_store::TurnAttemptStore;
use kcoder_types::{BackgroundRunKey, TaskStatus, TurnAttemptIdentity, TurnAttemptStatus};

async fn retry_child_metadata_prewrite<T>(mut action: impl FnMut() -> Result<T>) -> Result<T> {
    for attempt in 0..4 {
        match action() {
            Ok(value) => return Ok(value),
            Err(error)
                if attempt < 3
                    && error
                        .downcast_ref::<kcoder_runtime_driver::RuntimeBindingPrewriteConflict>()
                        .is_some() =>
            {
                // Re-read and validate the same original sealed intent. This
                // retries metadata CAS only, never child begin or model work.
                tokio::time::sleep(std::time::Duration::from_millis(2 << attempt)).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("the final bounded attempt always returns")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeWorkflowChildPreparation {
    Prepared,
    Existing,
}

struct ExistingBindings {
    guard: NativeDomainGuard,
    directory: PrivateDirectory,
    bindings: RuntimeBindings,
    ledger: IntegrationOperationStore,
}
impl ExistingBindings {
    fn open(native: &NativeIntegrationContext) -> Result<Self> {
        native.verify()?;
        let guard = NativeDomainGuard::observe(
            native.profile()?,
            native.scope(),
            NativeDomain::Operations,
        )?
        .context("RUNTIME_CHILD_STORE_UNAVAILABLE")?;
        let directory = guard.directory(native.profile()?)?;
        let bindings = RuntimeBindings::open(&directory, native.scope())?
            .context("RUNTIME_CHILD_STORE_UNAVAILABLE")?;
        let ledger =
            IntegrationOperationStore::open_in(&directory, OsStr::new("data"), native.scope())?;
        Ok(Self {
            guard,
            directory,
            bindings,
            ledger,
        })
    }
    fn verify(&self, native: &NativeIntegrationContext) -> Result<()> {
        native.verify()?;
        ensure!(
            self.guard
                .directory(native.profile()?)?
                .directory_identity()?
                == self.directory.directory_identity()?,
            "RUNTIME_CHILD_STORE_CHANGED"
        );
        self.bindings.verify()?;
        Ok(())
    }
    fn current(
        &self,
        native: &NativeIntegrationContext,
        operation: &str,
        request: &NativeChildAdmissionRequest<'_>,
    ) -> Result<(RuntimeBinding, ChildIntent)> {
        self.verify(native)?;
        let parent = request.parent();
        let child = request.child();
        let sealed = request
            .workflow_parent()
            .context("RUNTIME_CHILD_WORKFLOW_ORIGIN_REQUIRED")?;
        ensure!(
            sealed.matches_parent(parent) && sealed.matches_run(request.run()),
            "RUNTIME_CHILD_PARENT_CHANGED"
        );
        let source = sealed.facts();
        ensure!(
            source.operation_id == operation,
            "RUNTIME_CHILD_OPERATION_CHANGED"
        );
        let binding = self
            .bindings
            .get(operation)?
            .context("RUNTIME_CHILD_BINDING_MISSING")?;
        native.validate_scope(&binding.source_scope)?;
        let receipt = self
            .ledger
            .read(operation)?
            .context("RUNTIME_CHILD_RECEIPT_MISSING")?;
        let accepted = receipt
            .runtime_acceptance
            .as_ref()
            .context("RUNTIME_CHILD_PARENT_UNACCEPTED")?;
        accepted.validate()?;
        ensure!(
            receipt.port == "P-RUNTIME"
                && receipt.method == "acceptTask"
                && receipt.phase == IntegrationOperationPhase::Accepted
                && receipt.operation_id == operation
                && receipt.revision == source.receipt_revision
                && receipt.scope == binding.source_scope
                && binding.acceptance.as_ref() == Some(accepted)
                && source.runtime_acceptance_sha256
                    == sha(&(IntegrationOwner::from(native.scope()), operation, accepted))?
                && source.workflow_task_id == accepted.task_id.as_deref().unwrap_or_default()
                && accepted.thread_id == parent.session_id()
                && accepted.turn_id.is_none()
                && binding.phase == RuntimePhase::Accepted,
            "RUNTIME_CHILD_RECEIPT_CHANGED"
        );
        let settings = parent
            .settings_persistence_path()
            .context("RUNTIME_CHILD_PROFILE_UNAVAILABLE")?;
        let profile = PrivateDirectory::open_existing(
            settings
                .parent()
                .context("RUNTIME_CHILD_PROFILE_UNAVAILABLE")?,
        )?;
        ensure!(
            profile.directory_identity()? == native.profile()?.directory_identity()?
                && PrivateDirectory::open_existing(&parent.state.cwd())?.directory_identity()?
                    == native.workspace_directory_identity()?
                && PrivateDirectory::open_existing(&child.state.cwd())?.directory_identity()?
                    == native.workspace_directory_identity()?
                && parent.active_model_configuration_summary()?.revision
                    == binding.spec.configuration.model.model.revision,
            "RUNTIME_CHILD_NATIVE_OWNER_CHANGED"
        );
        let run = request.run();
        let task = parent
            .state
            .task_for_background_run(run)
            .context("RUNTIME_CHILD_RUN_MISSING")?;
        let record = parent
            .state
            .background_run_record(run)
            .context("RUNTIME_CHILD_RUN_MISSING")?;
        ensure!(
            run.parent_session_id == parent.session_id()
                // Native Workflow tasks may omit this older display field.
                // The required C28 seal, State-owned run, node and Core task
                // above/below remain the actual parent proof; a foreign Some rejects.
                && task.parent_session_id.as_deref().is_none_or(|id| id == parent.session_id())
                && task.background_run.as_ref() == Some(run)
                && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
                && record.terminal.is_none()
                && !record.imported_history,
            "RUNTIME_CHILD_RUN_CHANGED"
        );
        let observed = kcoder_tools::workflow_runs::observe_read(
            native.profile_path()?.join("workflow-runs"),
            &source.workflow_task_id,
        )?;
        let workflow = binding
            .spec
            .configuration
            .workflow
            .as_ref()
            .context("RUNTIME_CHILD_WORKFLOW_REQUIRED")?;
        let pin = workflow.resolve_pinned(native)?;
        ensure!(
            observed.status == "running"
                && observed.thread_id == parent.session_id()
                && observed.run_id == source.workflow_task_id
                && observed.definition_id.as_deref() == Some(source.definition_id.as_str())
                && observed.version == Some(source.definition_version)
                && pin
                    .definition()
                    .nodes
                    .iter()
                    .any(|node| node.id == source.node_id
                        && node.kind == kcoder_types::workflow::WorkflowNodeKind::Agent)
                && observed
                    .node_states
                    .iter()
                    .any(|node| node.node_id == source.node_id
                        && node.agent_id.as_deref() == Some(run.agent_id.as_str())
                        && matches!(node.status.as_str(), "running" | "retrying" | "waiting")),
            "RUNTIME_CHILD_NODE_CHANGED"
        );
        let intent = ChildIntent::from_parent_facts(
            &binding,
            source,
            pin.definition_sha256(),
            pin.inputs_sha256(),
            run.clone(),
            request.identity().clone(),
            request.input_hash(),
            request.fingerprint(),
        )?;
        self.verify(native)?;
        Ok((binding, intent))
    }
}

/// Only a real C28 sealed request can append. A retry never authorizes another begin.
pub(crate) async fn prepare_native_workflow_child(
    native: &NativeIntegrationContext,
    operation: &str,
    request: &NativeChildAdmissionRequest<'_>,
) -> Result<NativeWorkflowChildPreparation> {
    let store = ExistingBindings::open(native)?;
    retry_child_metadata_prewrite(|| {
        let (mut binding, intent) = store.current(native, operation, request)?;
        if let Some(previous) = binding
            .child_intents
            .iter()
            .find(|record| record.intent.background_run == intent.background_run)
        {
            ensure!(previous.intent == intent, "RUNTIME_CHILD_INTENT_CONFLICT");
            return Ok(NativeWorkflowChildPreparation::Existing);
        }
        let revision = binding.revision;
        binding.child_intents.push(ChildIntentRecord {
            intent,
            phase: ChildIntentPhase::Prepared,
        });
        store.bindings.save(binding, Some(revision))?;
        // Post-write errors are not prewrite conflicts and never repeat begin.
        store.current(native, operation, request)?;
        Ok(NativeWorkflowChildPreparation::Prepared)
    })
    .await
}

pub(crate) async fn observe_native_workflow_child_accepted(
    native: &NativeIntegrationContext,
    operation: &str,
    request: &NativeChildAdmissionRequest<'_>,
) -> Result<()> {
    let store = ExistingBindings::open(native)?;
    retry_child_metadata_prewrite(|| {
        let (mut binding, intent) = store.current(native, operation, request)?;
        let child = request.child();
        ensure!(
            child.state.current_history_attempt_identity().as_ref() == Some(request.identity()),
            "RUNTIME_CHILD_ACCEPTED_SCOPE_CHANGED"
        );
        let private = TurnAttemptStore::open_existing(
            &child.session_storage_dir_for(&request.identity().thread_id),
            &request.identity().thread_id,
        )?
        .context("RUNTIME_CHILD_ACCEPTANCE_MISSING")?;
        let accepted = private
            .load(request.identity())?
            .context("RUNTIME_CHILD_ACCEPTANCE_MISSING")?;
        ensure!(
            accepted.identity == *request.identity()
                && accepted.status == TurnAttemptStatus::Accepted
                && accepted.completion.is_none()
                && accepted.input_context_hash == request.input_hash()
                && accepted.request_fingerprint.as_deref() == Some(request.fingerprint()),
            "RUNTIME_CHILD_ACCEPTANCE_CHANGED"
        );
        let record = binding
            .child_intents
            .iter_mut()
            .find(|record| record.intent.background_run == intent.background_run)
            .context("RUNTIME_CHILD_INTENT_MISSING")?;
        ensure!(record.intent == intent, "RUNTIME_CHILD_INTENT_CONFLICT");
        if record.phase == ChildIntentPhase::Accepted {
            return Ok(());
        }
        record.phase = ChildIntentPhase::Accepted;
        let revision = binding.revision;
        store.bindings.save(binding, Some(revision))?;
        store.current(native, operation, request)?;
        Ok(())
    })
    .await
}

/// Read-only historical ownership over the original Core binding and its
/// immutable, natively accepted child intent. No historical runtime is started.
pub(crate) fn verify_workflow_office_history(
    native: &NativeIntegrationContext,
    engine: &QueryEngine,
    task: &kcoder_types::integrations::office::OfficeTaskRef,
    attempts: &[kcoder_state::turn_attempt_store::TurnAttemptRecord],
) -> Result<()> {
    let run = task
        .run_id
        .as_ref()
        .context("RUNTIME_CHILD_WORKFLOW_REQUIRED")?;
    let observed = kcoder_tools::workflow_runs::observe_read(
        native.profile_path()?.join("workflow-runs"),
        run,
    )?;
    let reference = IntegrationRuntimeReadTaskParams {
        thread_id: Some(observed.thread_id.clone()),
        turn_id: None,
        task_id: Some(run.clone()),
    };
    let driver = NativeRuntimeDriver::load(native)?.context("RUNTIME_CHILD_STORE_UNAVAILABLE")?;
    let operation = driver.operation_for_reference(native, &reference)?;
    let store = driver.storage();
    store.verify()?;
    let binding = store
        .bindings()
        .get(&operation)?
        .context("RUNTIME_CHILD_BINDING_MISSING")?;
    native.validate_scope(&binding.source_scope)?;
    validate_records(&binding)?;
    let receipt = store
        .read_receipt(&operation)?
        .context("RUNTIME_CHILD_RECEIPT_MISSING")?;
    ensure!(
        receipt.scope == binding.source_scope
            && receipt.port == "P-RUNTIME"
            && receipt.method == "acceptTask"
            && receipt.runtime_acceptance == binding.acceptance
            && binding.acceptance.is_some(),
        "RUNTIME_CHILD_RECEIPT_CHANGED"
    );
    let record = binding
        .child_intents
        .iter()
        .find(|record| {
            record.phase == ChildIntentPhase::Accepted
                && record.intent.workflow_task_id == *run
                && record.intent.child_identity.thread_id == task.thread_id
                && record.intent.child_identity.turn_id == task.turn_id
        })
        .context("RUNTIME_CHILD_ACCEPTANCE_MISSING")?;
    let intent = &record.intent;
    ensure!(
        observed.run_id == *run
            && observed.thread_id == intent.parent_thread_id
            && observed.definition_id.as_deref() == Some(intent.definition_id.as_str())
            && observed.version == Some(intent.definition_version)
            && observed
                .node_states
                .iter()
                .any(|node| node.node_id == intent.node_id),
        "RUNTIME_CHILD_WORKFLOW_CHANGED"
    );
    ensure!(
        attempts
            .iter()
            .any(|attempt| attempt.identity == intent.child_identity
                && attempt.status.is_known()
                && attempt.input_context_hash == intent.input_hash
                && attempt.request_fingerprint.as_deref() == Some(intent.fingerprint.as_str())),
        "RUNTIME_CHILD_ACCEPTANCE_CHANGED"
    );
    let settings = engine
        .native_settings_source_path()
        .context("RUNTIME_CHILD_PROFILE_UNAVAILABLE")?;
    ensure!(
        PrivateDirectory::open_existing(
            settings
                .parent()
                .context("RUNTIME_CHILD_PROFILE_UNAVAILABLE")?
        )?
        .directory_identity()?
            == native.profile()?.directory_identity()?
            && PrivateDirectory::open_existing(&engine.state.cwd())?.directory_identity()?
                == native.workspace_directory_identity()?,
        "RUNTIME_CHILD_NATIVE_OWNER_CHANGED"
    );
    store.verify()?;
    ensure!(
        store
            .bindings()
            .get(&operation)?
            .is_some_and(|current| current.child_intents.contains(record)
                && current.acceptance == binding.acceptance),
        "RUNTIME_CHILD_ACCEPTANCE_CHANGED"
    );
    Ok(())
}

#[cfg(test)]
mod tests;
