use super::*;
use crate::app_server::integrations::core::NativeOperations;
use kcoder_engine::native_model_requests::NativeModelRequestContext;
use kcoder_state::{AppState, AppStateLifecycleIdentity};
use kcoder_types::{ModelConfigurationSummary, TaskStatus};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(super) fn now() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}
pub(super) fn digest(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
pub(super) fn revalidate_runtime_source(
    source: &NativeAutomationSource,
    known: &mut Option<String>,
) -> Result<()> {
    for _ in 0..3 {
        let current = source.change_epoch()?;
        if known.as_ref() == Some(&current) {
            return Ok(());
        }
        source.verify(
            source.native(),
            source.original_request(),
            &CancellationToken::new(),
        )?;
        let after = source.change_epoch()?;
        if after == current {
            *known = Some(after);
            return Ok(());
        }
        // A shared journal stamp can change for an unrelated run/subscription.
        // Never cache that observation or infer permission from the stamp:
        // re-read the original persisted intent and current native policy.
        *known = None;
    }
    anyhow::bail!("AUTOMATION_SOURCE_REVALIDATION_BUSY")
}

struct RootFrame {
    engine: QueryEngine,
    identity: AppStateLifecycleIdentity,
}
struct Actor {
    state: AppState,
    identity: AppStateLifecycleIdentity,
    background: kcoder_types::BackgroundRunKey,
}
#[derive(Clone)]
pub(super) struct RuntimeFacts {
    pub task: IntegrationEntityRef,
    pub receipt_id: String,
    pub receipt_sha256: String,
    pub receipt_revision: u64,
    pub started_at_ms: u64,
}
pub(super) struct ExecutionSafety {
    pub source: Arc<NativeAutomationSource>,
    pub service: Arc<NativeBudgetService>,
    pub model: ModelConfigurationSummary,
    pub code_allowance_ms: u64,
    root: Mutex<Option<RootFrame>>,
    actors: Mutex<Vec<Actor>>,
    source_epoch: Mutex<Option<String>>,
    deadline: Mutex<Option<(String, Instant)>>,
}
impl ExecutionSafety {
    pub fn new(
        source: Arc<NativeAutomationSource>,
        service: Arc<NativeBudgetService>,
        model: ModelConfigurationSummary,
        code_allowance_ms: u64,
    ) -> Result<Self> {
        ensure!(
            source.is_native_personal_policy(),
            "AUTOMATION_NATIVE_POLICY_LEASE_UNAVAILABLE"
        );
        source.verify(
            source.native(),
            source.original_request(),
            &CancellationToken::new(),
        )?;
        Ok(Self {
            source,
            service,
            model,
            code_allowance_ms,
            root: Mutex::new(None),
            actors: Mutex::new(vec![]),
            source_epoch: Mutex::new(None),
            deadline: Mutex::new(None),
        })
    }
    pub fn bind_root(&self, engine: &QueryEngine) -> Result<()> {
        let mut root = self
            .root
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_ACTOR_UNAVAILABLE"))?;
        if let Some(original) = root.as_ref() {
            ensure!(
                original.identity.matches(&engine.state),
                "AUTOMATION_ROOT_STATE_CHANGED"
            );
            return Ok(());
        }
        *root = Some(RootFrame {
            engine: engine.clone(),
            identity: engine.state.inspection_lifecycle_identity(),
        });
        Ok(())
    }
    pub(super) fn original_model_engine(&self) -> Result<QueryEngine> {
        let root = self
            .root
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_ACTOR_UNAVAILABLE"))?;
        let root = root.as_ref().context("AUTOMATION_ACTOR_NOT_BOUND")?;
        ensure!(
            root.identity.matches(&root.engine.state),
            "AUTOMATION_ROOT_STATE_CHANGED"
        );
        Ok(root.engine.clone())
    }
    pub(super) fn is_bound_model_engine(&self, engine: &QueryEngine) -> Result<bool> {
        let root = self
            .root
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_ACTOR_UNAVAILABLE"))?;
        let Some(root) = root.as_ref() else {
            return Ok(false);
        };
        let original = kcoder_engine::native_model_requests::admission_identity(
            &root.engine.current_provider(),
        );
        let actual =
            kcoder_engine::native_model_requests::admission_identity(&engine.current_provider());
        Ok(root.identity.matches(&engine.state) && Arc::ptr_eq(&original, &actual))
    }
    pub fn root_operation(&self) -> Result<String> {
        Ok(format!(
            "automation-budget-{}",
            digest(&(
                IntegrationOwner::from(&self.source.original_request().scope),
                &self.source.original_request().operation_id
            ))?
        ))
    }
    pub fn subscription_key(&self) -> Result<String> {
        Ok(format!(
            "automation-sub-{}",
            digest(&(
                IntegrationOwner::from(&self.source.original_request().scope),
                &self.source.original_request().payload["source"]["subscriptionId"]
            ))?
        ))
    }
    pub fn full_check_source(&self) -> Result<()> {
        self.source.verify(
            self.source.native(),
            self.source.original_request(),
            &CancellationToken::new(),
        )?;
        self.check_source()
    }
    pub fn check_source(&self) -> Result<()> {
        let mut known = self
            .source_epoch
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_SOURCE_UNAVAILABLE"))?;
        revalidate_runtime_source(&self.source, &mut known)
    }
    pub fn runtime_facts(&self) -> Result<RuntimeFacts> {
        let native = self.source.native();
        let operations =
            NativeOperations::load(native)?.context("AUTOMATION_NATIVE_RECEIPT_UNAVAILABLE")?;
        let operation = self
            .source
            .original_request()
            .operation_id
            .as_deref()
            .context("AUTOMATION_OPERATION_REQUIRED")?;
        let receipt = operations
            .read(native, operation)?
            .context("AUTOMATION_NATIVE_RECEIPT_UNAVAILABLE")?;
        ensure!(
            receipt.port == "P-RUNTIME"
                && receipt.method == "acceptTask"
                && receipt.phase == IntegrationOperationPhase::Accepted
                && receipt.operation_id == operation
                && IntegrationOwner::from(&receipt.scope) == IntegrationOwner::from(native.scope()),
            "AUTOMATION_NATIVE_RECEIPT_MISMATCH"
        );
        let accepted = receipt
            .runtime_acceptance
            .context("AUTOMATION_NATIVE_RECEIPT_UNAVAILABLE")?;
        accepted.validate()?;
        let task_id = accepted
            .task_id
            .as_ref()
            .context("AUTOMATION_NATIVE_WORKFLOW_REQUIRED")?;
        let observation = kcoder_tools::workflow_runs::observe_read(
            native.profile_path()?.join("workflow-runs"),
            task_id,
        )?;
        ensure!(
            observation.run_id == *task_id
                && observation.thread_id == accepted.thread_id
                && observation.definition_id.as_deref()
                    == Some(self.source.pin().definition().id.as_str())
                && observation.version == self.source.pin().definition().saved_version,
            "AUTOMATION_NATIVE_WORKFLOW_MISMATCH"
        );
        ensure!(
            observation.status == "running",
            "AUTOMATION_NATIVE_WORKFLOW_NOT_RUNNING"
        );
        let root = self
            .root
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_ACTOR_UNAVAILABLE"))?;
        let root = root.as_ref().context("AUTOMATION_ACTOR_NOT_BOUND")?;
        ensure!(
            root.identity.matches(&root.engine.state)
                && root.engine.session_id() == accepted.thread_id,
            "AUTOMATION_ROOT_STATE_CHANGED"
        );
        Ok(RuntimeFacts {
            receipt_revision: receipt.revision,
            task: IntegrationEntityRef {
                kind: IntegrationEntityKind::Task,
                id: task_id.clone(),
                revision: None,
            },
            receipt_id: format!("runtime-accept-{}", self.root_operation()?),
            receipt_sha256: digest(&(
                IntegrationOwner::from(native.scope()),
                operation,
                &accepted,
            ))?,
            started_at_ms: observation.started_at_ms,
        })
    }
    pub fn deadline(&self, facts: &RuntimeFacts) -> Result<Instant> {
        let mut known = self
            .deadline
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_ACTOR_UNAVAILABLE"))?;
        if let Some((task, deadline)) = known.as_ref() {
            ensure!(task == &facts.task.id, "AUTOMATION_NATIVE_RECEIPT_MISMATCH");
            return Ok(*deadline);
        }
        let end = facts
            .started_at_ms
            .checked_add(
                self.source
                    .maximum_runtime_seconds()
                    .checked_mul(1000)
                    .context("AUTOMATION_RUNTIME_LIMIT_INVALID")?,
            )
            .and_then(|end| end.checked_sub(self.code_allowance_ms))
            .context("AUTOMATION_RUNTIME_LIMIT_INVALID")?;
        let end = self
            .source
            .expires_at_ms()
            .map_or(end, |expiry| end.min(expiry));
        let current = now()?;
        ensure!(
            facts.started_at_ms <= current && current < end,
            "AUTOMATION_RUNTIME_DEADLINE"
        );
        let deadline = Instant::now() + Duration::from_millis(end - current);
        *known = Some((facts.task.id.clone(), deadline));
        Ok(deadline)
    }
    pub(super) fn workflow_parent_facts(
        &self,
        parent: &QueryEngine,
        original: &NativeToolExecutionWitness,
        run: &kcoder_types::BackgroundRunKey,
        agent_id: &str,
    ) -> Result<kcoder_engine::integrations::core::NativeWorkflowParentFacts> {
        self.full_check_source()?;
        let facts = self.runtime_facts()?;
        let root = self
            .root
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_ACTOR_UNAVAILABLE"))?;
        let root = root.as_ref().context("AUTOMATION_ACTOR_NOT_BOUND")?;
        ensure!(
            root.identity.matches(&root.engine.state)
                && root.identity.matches(&parent.state)
                && original.matches_state(&parent.state)
                && original.session_id() == parent.session_id()
                && parent.session_id() == root.engine.session_id()
                && run.parent_session_id == parent.session_id()
                && run.agent_id == agent_id,
            "AUTOMATION_WORKFLOW_PARENT_CHANGED"
        );
        super::super::rpc::configuration::EngineSnapshot::capture(parent)?
            .verify_binding(parent, self.source.native())?;
        let record = parent
            .state
            .background_run_record(run)
            .context("AUTOMATION_ACTOR_RUN_UNAVAILABLE")?;
        let task = parent
            .state
            .task_for_background_run(run)
            .context("AUTOMATION_ACTOR_RUN_UNAVAILABLE")?;
        ensure!(
            record.terminal.is_none()
                && !record.imported_history
                && task.background_run.as_ref() == Some(run)
                && matches!(task.status, TaskStatus::Pending | TaskStatus::Running),
            "AUTOMATION_ACTOR_NOT_RUNNING"
        );
        let observed = kcoder_tools::workflow_runs::observe_read(
            self.source.native().profile_path()?.join("workflow-runs"),
            &facts.task.id,
        )?;
        let node = observed
            .node_states
            .iter()
            .find(|node| {
                node.agent_id.as_deref() == Some(agent_id)
                    && matches!(node.status.as_str(), "running" | "retrying" | "waiting")
            })
            .context("AUTOMATION_ACTOR_NOT_IN_WORKFLOW")?;
        ensure!(
            self.source
                .pin()
                .definition()
                .nodes
                .iter()
                .any(|definition| definition.id == node.node_id
                    && definition.kind == WorkflowNodeKind::Agent),
            "AUTOMATION_ACTOR_NOT_IN_WORKFLOW"
        );
        Ok(
            kcoder_engine::integrations::core::NativeWorkflowParentFacts {
                operation_id: self
                    .source
                    .original_request()
                    .operation_id
                    .clone()
                    .context("AUTOMATION_OPERATION_REQUIRED")?,
                receipt_revision: facts.receipt_revision,
                runtime_acceptance_sha256: facts.receipt_sha256,
                workflow_task_id: facts.task.id,
                definition_id: self.source.pin().definition().id.clone(),
                definition_version: self
                    .source
                    .pin()
                    .definition()
                    .saved_version
                    .context("AUTOMATION_WORKFLOW_PIN_UNAVAILABLE")?,
                node_id: node.node_id.clone(),
                source_revision: self.source.source_revision().into(),
            },
        )
    }
    pub fn verify_witness(
        &self,
        witness: &NativeToolExecutionWitness,
    ) -> Result<kcoder_types::BackgroundRunKey> {
        let native = self.source.native();
        native.verify()?;
        let facts = self.runtime_facts()?;
        let root = self
            .root
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_ACTOR_UNAVAILABLE"))?;
        let root = root.as_ref().context("AUTOMATION_ACTOR_NOT_BOUND")?;
        let parent = witness
            .parent()
            .context("AUTOMATION_ACTOR_LINEAGE_REQUIRED")?;
        ensure!(
            parent.matches_state(&root.engine.state)
                && parent.session_id() == root.engine.session_id(),
            "AUTOMATION_ACTOR_LINEAGE_MISMATCH"
        );
        let run = parent
            .background_run()
            .context("AUTOMATION_ACTOR_RUN_REQUIRED")?;
        ensure!(
            run.parent_session_id == root.engine.session_id() && run.agent_id == parent.agent_id(),
            "AUTOMATION_ACTOR_LINEAGE_MISMATCH"
        );
        let record = root
            .engine
            .state
            .background_run_record(run)
            .context("AUTOMATION_ACTOR_RUN_UNAVAILABLE")?;
        let task = root
            .engine
            .state
            .task_for_background_run(run)
            .context("AUTOMATION_ACTOR_RUN_UNAVAILABLE")?;
        ensure!(
            record.terminal.is_none()
                && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
                && task.background_run.as_ref() == Some(run),
            "AUTOMATION_ACTOR_NOT_RUNNING"
        );
        let observation = kcoder_tools::workflow_runs::observe_read(
            native.profile_path()?.join("workflow-runs"),
            &facts.task.id,
        )?;
        ensure!(
            observation
                .node_states
                .iter()
                .any(
                    |node| node.agent_id.as_deref() == Some(run.agent_id.as_str())
                        && matches!(node.status.as_str(), "running" | "retrying" | "waiting")
                ),
            "AUTOMATION_ACTOR_NOT_IN_WORKFLOW"
        );
        if let Some(attempt) = witness.attempt() {
            ensure!(
                attempt.thread_id == witness.session_id(),
                "AUTOMATION_ACTOR_ATTEMPT_MISMATCH"
            )
        }
        Ok(run.clone())
    }
    pub fn register_actor(
        &self,
        context: &NativeModelRequestContext,
    ) -> Result<kcoder_types::BackgroundRunKey> {
        ensure!(
            context.execution().matches_state(context.state()),
            "AUTOMATION_ACTOR_STATE_MISMATCH"
        );
        let run = self.verify_witness(context.execution())?;
        {
            let root = self
                .root
                .lock()
                .map_err(|_| anyhow::anyhow!("AUTOMATION_ACTOR_UNAVAILABLE"))?;
            let root = root.as_ref().context("AUTOMATION_ACTOR_NOT_BOUND")?;
            ensure!(
                context.state().cwd().canonicalize()? == root.engine.state.cwd().canonicalize()?,
                "AUTOMATION_ACTOR_WORKSPACE_MISMATCH"
            );
            if let Some(identity) = context.execution().attempt() {
                ensure!(
                    context.state().current_history_attempt_identity().as_ref() == Some(identity),
                    "AUTOMATION_ACTOR_ATTEMPT_MISMATCH"
                );
                let path = root.engine.session_storage_dir_for(&identity.thread_id);
                let store = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
                    &path,
                    &identity.thread_id,
                )?
                .context("AUTOMATION_ACTOR_ACCEPTANCE_UNAVAILABLE")?;
                let record = store
                    .load(identity)?
                    .context("AUTOMATION_ACTOR_ACCEPTANCE_UNAVAILABLE")?;
                ensure!(
                    record.status == kcoder_types::TurnAttemptStatus::Accepted
                        && record.completion.is_none()
                        && record.request_fingerprint.is_some(),
                    "AUTOMATION_ACTOR_ACCEPTANCE_UNAVAILABLE"
                );
            }
        }
        let parent = context
            .parent_state()
            .context("AUTOMATION_ACTOR_LINEAGE_REQUIRED")?;
        ensure!(
            context
                .execution()
                .parent()
                .is_some_and(|witness| witness.matches_state(parent)),
            "AUTOMATION_ACTOR_LINEAGE_MISMATCH"
        );
        let mut actors = self
            .actors
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_ACTOR_UNAVAILABLE"))?;
        if !actors
            .iter()
            .any(|actor| actor.identity.matches(context.state()))
        {
            ensure!(actors.len() < 64, "AUTOMATION_ACTOR_CAPACITY");
            actors.push(Actor {
                state: context.state().clone(),
                identity: context.state().inspection_lifecycle_identity(),
                background: run.clone(),
            });
        }
        Ok(run)
    }
    pub(super) fn verify_office_child_run(
        &self,
        state: &AppState,
        run: &kcoder_types::BackgroundRunKey,
    ) -> Result<()> {
        self.full_check_source()?;
        let root = self
            .root
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_ACTOR_UNAVAILABLE"))?;
        let root = root.as_ref().context("AUTOMATION_ACTOR_NOT_BOUND")?;
        ensure!(
            root.identity.matches(&root.engine.state)
                && run.parent_session_id == root.engine.session_id()
                && state.cwd().canonicalize()? == root.engine.state.cwd().canonicalize()?,
            "AUTOMATION_ACTOR_LINEAGE_MISMATCH"
        );
        let task = root
            .engine
            .state
            .task_for_background_run(run)
            .context("AUTOMATION_ACTOR_RUN_UNAVAILABLE")?;
        let record = root
            .engine
            .state
            .background_run_record(run)
            .context("AUTOMATION_ACTOR_RUN_UNAVAILABLE")?;
        ensure!(
            task.background_run.as_ref() == Some(run)
                && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
                && record.key == *run
                && record.terminal.is_none()
                && !record.imported_history,
            "AUTOMATION_ACTOR_NOT_RUNNING"
        );
        Ok(())
    }
    pub fn verify_tool_state(&self, state: &AppState) -> Result<()> {
        let actors = self
            .actors
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_ACTOR_UNAVAILABLE"))?;
        let actor = actors
            .iter()
            .find(|actor| actor.identity.matches(state))
            .context("AUTOMATION_ACTOR_NOT_ADMITTED")?;
        ensure!(
            actor.identity.matches(&actor.state),
            "AUTOMATION_ACTOR_STATE_MISMATCH"
        );
        let root = self
            .root
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_ACTOR_UNAVAILABLE"))?;
        let root = root.as_ref().context("AUTOMATION_ACTOR_NOT_BOUND")?;
        ensure!(
            root.engine
                .state
                .background_run_record(&actor.background)
                .is_some_and(|record| record.terminal.is_none()),
            "AUTOMATION_ACTOR_NOT_RUNNING"
        );
        self.check_source()
    }
}
