//! One original Core Workflow slot spans all actual scheduled node runs.
use super::*;
use crate::workflow_origin::{NativeCoreWorkflowOrigin, NativeCoreWorkflowRoot};
use kcoder_types::{
    BackgroundRunKey,
    integrations::core::{IntegrationEntityKind, IntegrationEntityRef},
};

struct WorkflowTask {
    origin: NativeCoreWorkflowRoot,
    facts: TaskFacts,
    scheduled: BTreeMap<String, (kcoder_state::AppState, BackgroundRunKey)>,
    children: BTreeMap<String, (Arc<TurnAttemptStore>, TurnAttemptIdentity)>,
    auxiliary: Vec<std::sync::Weak<()>>,
}
#[derive(Default)]
pub(super) struct WorkflowRoots {
    roots: BTreeMap<String, WorkflowTask>,
}
impl WorkflowRoots {
    fn key(origin: &NativeCoreWorkflowRoot) -> Result<String> {
        Ok(format!(
            "org-workflow-{}",
            digest(&(
                &origin.facts.operation_id,
                &origin.facts.workflow_task_id,
                &origin.facts.runtime_acceptance_sha256
            ))?
        ))
    }
    fn active(native: &NativeIntegrationContext, facts: &TaskFacts) -> Result<()> {
        let slot = receipt(native.organization_budget_request(
            &facts.operation,
            json!({"kind":"check","reservation_id":facts.slot}),
        )?)?;
        ensure!(
            !slot.execution_confirmed_terminal,
            "ORGANIZATION_PARENT_TASK_NOT_ACTIVE"
        );
        Ok(())
    }
    pub(super) fn accept(
        &mut self,
        native: &NativeIntegrationContext,
        request: &kcoder_engine::native_model_requests::NativeWorkflowRootRequest<'_>,
    ) -> Result<()> {
        let origin = NativeCoreWorkflowRoot::capture(
            native,
            request.engine(),
            request.execution(),
            request.workflow_run(),
            None,
        )?;
        let operation = Self::key(&origin)?;
        if !self.roots.contains_key(&operation) {
            ensure!(self.roots.len() < 1024, "ORGANIZATION_TASK_CAPACITY");
            let slot = format!("slot-{}", digest(&operation)?);
            // The actual Core acceptance is a taskId naming this Workflow run.
            // It is never relabelled as a synthetic turn attempt.
            let task = IntegrationEntityRef {
                kind: IntegrationEntityKind::Task,
                id: origin.facts.workflow_task_id.clone(),
                revision: None,
            };
            let receipt_id = format!("runtime-accept-{}", origin.facts.operation_id);
            let reserved=receipt(native.organization_budget_request(&operation,json!({"kind":"reserve","reservation_id":slot,
                "operation_id":operation,"unit":"task_slot","task":{"rootOperationId":operation,"rootTask":task,
                "actor":"main","actorAttemptId":receipt_id,"parentReservationId":null},"estimate":BudgetCharge::zero()}))?)?;
            if reserved.phase == kcoder_state::integrations::core::budgets::BudgetPhase::Reserved {
                native.organization_budget_request(&operation,json!({"kind":"dispatch","reservation_id":slot,"expected_revision":reserved.revision}))?;
            }
            self.roots.insert(
                operation.clone(),
                WorkflowTask {
                    facts: TaskFacts {
                        operation: operation.clone(),
                        task,
                        receipt_id,
                        slot,
                        accepted_sha256: origin.facts.runtime_acceptance_sha256.clone(),
                    },
                    origin,
                    scheduled: BTreeMap::new(),
                    children: BTreeMap::new(),
                    auxiliary: Vec::new(),
                },
            );
        } else {
            ensure!(
                self.roots[&operation].origin.same_root(&origin),
                "ORGANIZATION_WORKFLOW_CORE_CHANGED"
            );
        }
        Self::active(native, &self.roots[&operation].facts)
    }
    pub(super) fn schedule(
        &mut self,
        native: &NativeIntegrationContext,
        request: &NativeScheduledChildRequest<'_>,
    ) -> Result<()> {
        let origin = NativeCoreWorkflowOrigin::capture(
            native,
            request.parent(),
            request.parent_execution(),
            request.run(),
            None,
        )?;
        let operation = Self::key(&origin.root)?;
        let root = self
            .roots
            .get_mut(&operation)
            .context("ORGANIZATION_PARENT_TASK_REQUIRED")?;
        ensure!(
            root.origin.same_root(&origin.root),
            "ORGANIZATION_WORKFLOW_CORE_CHANGED"
        );
        Self::active(native, &root.facts)?;
        if let Some((state, run)) = root.scheduled.get(&request.run().run_id) {
            ensure!(
                run == request.run()
                    && state
                        .inspection_lifecycle_identity()
                        .matches(&request.parent().state),
                "ORGANIZATION_SCHEDULED_RUN_CONFLICT"
            );
            return Ok(());
        }
        ensure!(root.scheduled.len() < 1024, "ORGANIZATION_CHILD_CAPACITY");
        root.scheduled.insert(
            request.run().run_id.clone(),
            (request.parent().state.clone(), request.run().clone()),
        );
        Ok(())
    }
    pub(super) fn prepare_child(
        &self,
        native: &NativeIntegrationContext,
        request: &NativeChildAdmissionRequest<'_>,
        children: &mut BTreeMap<String, Child>,
    ) -> Result<()> {
        let origin = NativeCoreWorkflowOrigin::capture(
            native,
            request.parent(),
            request.parent_execution(),
            request.run(),
            None,
        )?;
        let seal = request
            .workflow_parent()
            .context("ORGANIZATION_WORKFLOW_SEAL_REQUIRED")?;
        ensure!(
            seal.matches_parent(request.parent())
                && seal.matches_run(request.run())
                && seal.facts() == &origin.facts,
            "ORGANIZATION_WORKFLOW_SEAL_CHANGED"
        );
        let operation = Self::key(&origin.root)?;
        let root = self
            .roots
            .get(&operation)
            .context("ORGANIZATION_PARENT_TASK_REQUIRED")?;
        ensure!(
            root.origin.same_root(&origin.root),
            "ORGANIZATION_WORKFLOW_CORE_CHANGED"
        );
        Self::active(native, &root.facts)?;
        let (state, run) = root
            .scheduled
            .get(&request.run().run_id)
            .context("ORGANIZATION_ORIGINAL_SCHEDULED_RUN_REQUIRED")?;
        ensure!(
            run == request.run()
                && state
                    .inspection_lifecycle_identity()
                    .matches(&request.parent().state),
            "ORGANIZATION_SCHEDULED_PARENT_CHANGED"
        );
        ensure!(
            children.len() < 1024 && !children.contains_key(&request.child().session_id()),
            "ORGANIZATION_CHILD_BINDING_CONFLICT"
        );
        children.insert(
            request.child().session_id(),
            Child {
                root: operation,
                identity: request.identity().clone(),
                state: request.child().state.inspection_lifecycle_identity(),
                accepted: false,
            },
        );
        Ok(())
    }
    pub(super) fn for_model(
        &self,
        native: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<TaskFacts>> {
        let Some(root) = self.roots.get(operation) else {
            return Ok(None);
        };
        ensure!(
            root.origin.terminal(native)?.is_none(),
            "ORGANIZATION_PARENT_TASK_NOT_ACTIVE"
        );
        Self::active(native, &root.facts)?;
        Ok(Some(TaskFacts {
            operation: root.facts.operation.clone(),
            task: root.facts.task.clone(),
            receipt_id: root.facts.receipt_id.clone(),
            slot: root.facts.slot.clone(),
            accepted_sha256: root.facts.accepted_sha256.clone(),
        }))
    }
    pub(super) fn children(
        &mut self,
        operation: &str,
    ) -> Result<&mut BTreeMap<String, (Arc<TurnAttemptStore>, TurnAttemptIdentity)>> {
        Ok(&mut self
            .roots
            .get_mut(operation)
            .context("ORGANIZATION_PARENT_TASK_REQUIRED")?
            .children)
    }
    pub(super) fn retain(
        &mut self,
        native: &NativeIntegrationContext,
        operation: &str,
        token: &Arc<()>,
    ) -> Result<bool> {
        let Some(root) = self.roots.get_mut(operation) else {
            return Ok(false);
        };
        Self::active(native, &root.facts)?;
        root.auxiliary.retain(|work| work.strong_count() > 0);
        ensure!(
            root.auxiliary.len() < 1024,
            "ORGANIZATION_AUXILIARY_CAPACITY"
        );
        root.auxiliary.push(Arc::downgrade(token));
        Ok(true)
    }
    pub(super) fn reconcile(&mut self, native: &NativeIntegrationContext) -> Result<Vec<String>> {
        let mut ended = Vec::new();
        for (operation, root) in &self.roots {
            // A child terminal cannot end the Workflow root while another node
            // is pending: only the original persistent Workflow may end it.
            let Some(terminal) = root.origin.terminal(native)? else {
                continue;
            };
            if root.auxiliary.iter().any(|work| work.strong_count() > 0)
                || root.scheduled.values().any(|(state, run)| {
                    state
                        .background_run_record(run)
                        .is_none_or(|record| record.terminal.is_none())
                })
            {
                continue;
            }
            let mut closed = true;
            for (store, identity) in root.children.values() {
                if !store.load(identity)?.is_some_and(|record| {
                    record.status.is_terminal() && record.completion.is_some()
                }) {
                    closed = false;
                    break;
                }
            }
            if !closed {
                continue;
            }
            if native.organization_budget_request(
                operation,
                json!({"kind":"calls_closed","reservation_id":root.facts.slot}),
            )?["closed"]
                != true
            {
                continue;
            }
            let current = receipt(native.organization_budget_request(
                operation,
                json!({"kind":"read","reservation_id":root.facts.slot}),
            )?)?;
            native.organization_budget_request(operation,json!({"kind":"observe","reservation_id":root.facts.slot,"expected_revision":current.revision,
                "update_id":"original-core-workflow-and-owned-children-terminal","coverage":"complete","usage":BudgetCharge::zero(),
                "terminal":{"receiptId":root.facts.receipt_id,"receiptSha256":digest(&terminal)?,"kind":terminal["workflow"]["status"]}}))?;
            ended.push(operation.clone());
        }
        for operation in &ended {
            self.roots.remove(operation);
        }
        Ok(ended)
    }
}
