//! Original Core Workflow facts from private receipts, the actual State and node run.
use anyhow::{Context, Result, ensure};
use kcoder_engine::{
    QueryEngine,
    integrations::core::{NativeToolExecutionWitness, NativeWorkflowParentFacts},
};
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_runtime_driver::{NativeRuntimeDriver, RuntimePhase, RuntimeStorage, hash};
use kcoder_state::{AppState, AppStateLifecycleIdentity};
use kcoder_types::integrations::core::{
    IntegrationOperationPhase, IntegrationOwner, IntegrationRuntimeAcceptance,
};
use kcoder_types::{BackgroundRunKey, TaskStatus};
use kcoder_workflow_observations::workflow_runs;
use std::sync::Arc;

pub(crate) struct NativeCoreWorkflowRootFacts {
    pub operation_id: String,
    pub receipt_revision: u64,
    pub runtime_acceptance_sha256: String,
    pub workflow_task_id: String,
    pub definition_id: String,
    pub definition_version: u64,
    pub source_revision: String,
}
pub(crate) struct NativeCoreWorkflowRoot {
    storage: Arc<RuntimeStorage>,
    operation: String,
    intent: String,
    acceptance: IntegrationRuntimeAcceptance,
    state: AppState,
    lifecycle: AppStateLifecycleIdentity,
    pub(crate) facts: NativeCoreWorkflowRootFacts,
}
impl NativeCoreWorkflowRoot {
    pub(crate) fn capture(
        native: &NativeIntegrationContext,
        parent: &QueryEngine,
        execution: &NativeToolExecutionWitness,
        workflow_run: &str,
        operation: Option<&str>,
    ) -> Result<Self> {
        native.verify()?;
        ensure!(
            execution.attempt().is_none()
                && execution.matches_state(&parent.state)
                && execution.session_id() == parent.session_id()
                && execution.parent().is_none(),
            "ORGANIZATION_WORKFLOW_ORIGINAL_PARENT_CHANGED"
        );
        let settings = parent
            .settings_persistence_path()
            .context("RUNTIME_WORKFLOW_PROFILE_UNAVAILABLE")?;
        ensure!(
            kcoder_config::PrivateDirectory::open_existing(
                settings
                    .parent()
                    .context("RUNTIME_WORKFLOW_PROFILE_UNAVAILABLE")?
            )?
            .directory_identity()?
                == native.profile()?.directory_identity()?
                && kcoder_config::PrivateDirectory::open_existing(&parent.state.cwd())?
                    .directory_identity()?
                    == native.workspace_directory_identity()?,
            "ORGANIZATION_WORKFLOW_OWNER_CHANGED"
        );
        let driver =
            NativeRuntimeDriver::load(native)?.context("ORGANIZATION_WORKFLOW_CORE_REQUIRED")?;
        let mut found = None;
        driver.storage().bindings().visit(|binding| {
            if operation.is_some_and(|id| id != binding.operation_id)
                || binding.acceptance.as_ref().is_none_or(|a| {
                    a.thread_id != parent.session_id()
                        || a.turn_id.is_some()
                        || a.task_id.as_deref() != Some(workflow_run)
                })
            {
                return Ok(());
            }
            let Some(workflow) = &binding.spec.configuration.workflow else {
                return Ok(());
            };
            let Some(acceptance) = &binding.acceptance else {
                return Ok(());
            };
            let Some(workflow_run) = &acceptance.task_id else {
                return Ok(());
            };
            let observed = workflow_runs::observe_read(
                native.profile_path()?.join("workflow-runs"),
                workflow_run,
            )?;
            native.validate_scope(&binding.source_scope)?;
            let receipt = driver
                .storage()
                .read_receipt(&binding.operation_id)?
                .context("ORGANIZATION_WORKFLOW_CORE_REQUIRED")?;
            workflow.resolve_pinned(native)?;
            ensure!(
                binding.phase == RuntimePhase::Accepted
                    && receipt.phase == IntegrationOperationPhase::Accepted
                    && receipt.port == "P-RUNTIME"
                    && receipt.method == "acceptTask"
                    && receipt.scope == binding.source_scope
                    && receipt.runtime_acceptance.as_ref() == Some(acceptance)
                    && observed.status == "running"
                    && observed.thread_id == parent.session_id()
                    && observed.run_id == *workflow_run
                    && observed.definition_id.as_deref() == Some(workflow.definition_id.as_str())
                    && observed.version == Some(workflow.version)
                    && parent.active_model_configuration_summary()?.revision
                        == binding.spec.configuration.model.model.revision,
                "ORGANIZATION_WORKFLOW_CORE_CHANGED"
            );
            ensure!(found.is_none(), "ORGANIZATION_WORKFLOW_CORE_AMBIGUOUS");
            found = Some(Self {
                storage: driver.storage().clone(),
                operation: binding.operation_id.clone(),
                intent: binding.intent_sha256.clone(),
                acceptance: acceptance.clone(),
                state: parent.state.clone(),
                lifecycle: parent.state.inspection_lifecycle_identity(),
                facts: NativeCoreWorkflowRootFacts {
                    operation_id: binding.operation_id.clone(),
                    receipt_revision: receipt.revision,
                    runtime_acceptance_sha256: hash(&serde_json::to_vec(&(
                        IntegrationOwner::from(native.scope()),
                        &binding.operation_id,
                        acceptance,
                    ))?),
                    workflow_task_id: workflow_run.clone(),
                    definition_id: workflow.definition_id.clone(),
                    definition_version: workflow.version,
                    source_revision: binding.intent_sha256.clone(),
                },
            });
            Ok(())
        })?;
        found.context("ORGANIZATION_WORKFLOW_CORE_REQUIRED")
    }
    pub(crate) fn same_root(&self, other: &Self) -> bool {
        self.operation == other.operation
            && self.intent == other.intent
            && self.acceptance == other.acceptance
            && self.lifecycle.matches(&other.state)
            && other.lifecycle.matches(&self.state)
    }
    pub(crate) fn terminal(
        &self,
        native: &NativeIntegrationContext,
    ) -> Result<Option<serde_json::Value>> {
        native.verify()?;
        self.storage.verify()?;
        ensure!(
            self.lifecycle.matches(&self.state),
            "ORGANIZATION_WORKFLOW_OWNER_CHANGED"
        );
        let binding = self
            .storage
            .bindings()
            .get(&self.operation)?
            .context("ORGANIZATION_WORKFLOW_CORE_REQUIRED")?;
        native.validate_scope(&binding.source_scope)?;
        let receipt = self
            .storage
            .read_receipt(&self.operation)?
            .context("ORGANIZATION_WORKFLOW_CORE_REQUIRED")?;
        ensure!(
            binding.intent_sha256 == self.intent
                && binding.acceptance.as_ref() == Some(&self.acceptance)
                && receipt.runtime_acceptance.as_ref() == Some(&self.acceptance)
                && receipt.scope == binding.source_scope
                && receipt.port == "P-RUNTIME"
                && receipt.method == "acceptTask",
            "ORGANIZATION_WORKFLOW_CORE_CHANGED"
        );
        let observed = workflow_runs::observe_read(
            native.profile_path()?.join("workflow-runs"),
            &self.facts.workflow_task_id,
        )?;
        ensure!(
            observed.thread_id == self.acceptance.thread_id
                && observed.run_id == self.facts.workflow_task_id
                && observed.definition_id.as_deref() == Some(self.facts.definition_id.as_str())
                && observed.version == Some(self.facts.definition_version),
            "ORGANIZATION_WORKFLOW_CORE_CHANGED"
        );
        if !matches!(
            observed.status.as_str(),
            "completed" | "failed" | "cancelled"
        ) {
            return Ok(None);
        }
        Ok(Some(
            serde_json::json!({"coreAcceptance":self.acceptance,"workflow":observed}),
        ))
    }
}

pub struct NativeCoreWorkflowOrigin {
    pub(crate) root: NativeCoreWorkflowRoot,
    pub facts: NativeWorkflowParentFacts,
}
impl NativeCoreWorkflowOrigin {
    pub fn capture(
        native: &NativeIntegrationContext,
        parent: &QueryEngine,
        execution: &NativeToolExecutionWitness,
        run: &BackgroundRunKey,
        operation: Option<&str>,
    ) -> Result<Self> {
        ensure!(
            run.parent_session_id == parent.session_id(),
            "ORGANIZATION_WORKFLOW_RUN_CHANGED"
        );
        let task = parent
            .state
            .task_for_background_run(run)
            .context("ORGANIZATION_WORKFLOW_RUN_REQUIRED")?;
        ensure!(
            task.background_run.as_ref() == Some(run)
                && task
                    .parent_session_id
                    .as_deref()
                    .is_none_or(|id| id == parent.session_id())
                && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
                && parent
                    .state
                    .background_run_record(run)
                    .is_some_and(|r| r.terminal.is_none() && !r.imported_history),
            "ORGANIZATION_WORKFLOW_RUN_CHANGED"
        );
        let driver =
            NativeRuntimeDriver::load(native)?.context("ORGANIZATION_WORKFLOW_CORE_REQUIRED")?;
        let mut found = None;
        driver.storage().bindings().visit(|binding| {
            if operation.is_some_and(|id| id != binding.operation_id)
                || binding
                    .acceptance
                    .as_ref()
                    .is_none_or(|a| a.thread_id != parent.session_id() || a.turn_id.is_some())
            {
                return Ok(());
            }
            let Some(workflow) = &binding.spec.configuration.workflow else {
                return Ok(());
            };
            let Some(workflow_run) = binding
                .acceptance
                .as_ref()
                .and_then(|a| a.task_id.as_deref())
            else {
                return Ok(());
            };
            let observed = workflow_runs::observe_read(
                native.profile_path()?.join("workflow-runs"),
                workflow_run,
            )?;
            let Some(node) = observed.node_states.iter().find(|node| {
                node.agent_id.as_deref() == Some(run.agent_id.as_str())
                    && matches!(node.status.as_str(), "running" | "retrying" | "waiting")
            }) else {
                return Ok(());
            };
            ensure!(
                workflow
                    .resolve_pinned(native)?
                    .definition()
                    .nodes
                    .iter()
                    .any(|definition| definition.id == node.node_id
                        && definition.kind == kcoder_types::workflow::WorkflowNodeKind::Agent),
                "ORGANIZATION_WORKFLOW_CORE_CHANGED"
            );
            let root = NativeCoreWorkflowRoot::capture(
                native,
                parent,
                execution,
                workflow_run,
                operation,
            )?;
            let facts = NativeWorkflowParentFacts {
                operation_id: root.facts.operation_id.clone(),
                receipt_revision: root.facts.receipt_revision,
                runtime_acceptance_sha256: root.facts.runtime_acceptance_sha256.clone(),
                workflow_task_id: root.facts.workflow_task_id.clone(),
                definition_id: root.facts.definition_id.clone(),
                definition_version: root.facts.definition_version,
                node_id: node.node_id.clone(),
                source_revision: root.facts.source_revision.clone(),
            };
            ensure!(found.is_none(), "ORGANIZATION_WORKFLOW_CORE_AMBIGUOUS");
            found = Some(Self { root, facts });
            Ok(())
        })?;
        found.context("ORGANIZATION_WORKFLOW_CORE_REQUIRED")
    }
}
