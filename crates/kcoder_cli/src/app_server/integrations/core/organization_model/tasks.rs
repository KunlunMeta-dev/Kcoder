//! Original Accepted lineage and task-slot observations; the root State journal owns balances.
use super::*;
use kcoder_engine::integrations::core::{NativeChildAdmissionRequest, NativeScheduledChildRequest};
use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
use std::collections::BTreeMap;

pub(super) struct TaskFacts {
    pub operation: String,
    pub task: kcoder_types::integrations::core::IntegrationEntityRef,
    pub receipt_id: String,
    pub slot: String,
    pub accepted_sha256: String,
}
struct OriginalTask {
    facts: TaskFacts,
    identity: TurnAttemptIdentity,
    store: Arc<TurnAttemptStore>,
    children: BTreeMap<String, (Arc<TurnAttemptStore>, TurnAttemptIdentity)>,
    scheduled: BTreeMap<String, Scheduled>,
    auxiliary: Vec<std::sync::Weak<()>>,
}
struct Scheduled {
    parent: TurnAttemptIdentity,
    accepted_sha256: String,
    parent_state: kcoder_state::AppState,
    run: kcoder_types::BackgroundRunKey,
}
struct Child {
    root: String,
    identity: TurnAttemptIdentity,
    state: kcoder_state::AppStateLifecycleIdentity,
    accepted: bool,
}
#[derive(Default)]
pub(super) struct OrganizationTasks {
    roots: BTreeMap<String, OriginalTask>,
    children: BTreeMap<String, Child>,
    workflows: workflow::WorkflowRoots,
}
fn actual_store(
    engine: &QueryEngine,
    identity: &TurnAttemptIdentity,
) -> Result<Arc<TurnAttemptStore>> {
    Ok(Arc::new(
        TurnAttemptStore::open_existing(
            &engine.session_storage_dir_for(&identity.thread_id),
            &identity.thread_id,
        )?
        .context("ORGANIZATION_ACCEPTED_STORE_REQUIRED")?,
    ))
}
fn accepted(store: &TurnAttemptStore, identity: &TurnAttemptIdentity) -> Result<TurnAttemptRecord> {
    let record = store
        .load(identity)?
        .context("ORGANIZATION_ACCEPTED_REQUIRED")?;
    ensure!(
        record.status == TurnAttemptStatus::Accepted && record.completion.is_none(),
        "ORGANIZATION_ACCEPTED_NOT_ACTIVE"
    );
    Ok(record)
}
impl OrganizationTasks {
    pub(super) fn accept_workflow(
        &mut self,
        native: &NativeIntegrationContext,
        request: &NativeWorkflowRootRequest<'_>,
    ) -> Result<()> {
        self.reconcile(native)?;
        self.workflows.accept(native, request)
    }
    pub(super) fn for_model(
        &mut self,
        native: &NativeIntegrationContext,
        context: &NativeModelRequestContext,
        attempt: &TurnAttemptIdentity,
    ) -> Result<TaskFacts> {
        self.reconcile(native)?;
        let operation = if context.execution().parent().is_some() {
            let child = self
                .children
                .get(context.execution().session_id())
                .context("ORGANIZATION_CHILD_BINDING_REQUIRED")?;
            ensure!(
                child.accepted
                    && child.identity == *attempt
                    && child.state.matches(context.state()),
                "ORGANIZATION_CHILD_ACCEPTED_CHANGED"
            );
            child.root.clone()
        } else {
            format!("org-turn-{}", digest(attempt)?)
        };
        if let Some(facts) = self.workflows.for_model(native, &operation)? {
            return Ok(facts);
        }
        if !self.roots.contains_key(&operation) {
            ensure!(
                context.execution().parent().is_none(),
                "ORGANIZATION_PARENT_TASK_REQUIRED"
            );
            ensure!(self.roots.len() < 1024, "ORGANIZATION_TASK_CAPACITY");
            let store = Arc::new(
                TurnAttemptStore::open_existing(context.session_directory(), &attempt.thread_id)?
                    .context("ORGANIZATION_ACCEPTED_STORE_REQUIRED")?,
            );
            let record = accepted(&store, attempt)?;
            let slot = format!("slot-{}", digest(attempt)?);
            let raw=native.organization_budget_request(&operation,json!({"kind":"reserve","reservation_id":slot,"operation_id":operation,"unit":"task_slot",
                "task":{"rootOperationId":operation,"rootTask":{"kind":"turn","id":attempt.turn_id,"revision":null},"actor":"main","actorAttemptId":attempt.attempt_id,"parentReservationId":null},
                "estimate":BudgetCharge::zero()}))?;
            let reserved = receipt(raw)?;
            if reserved.phase == kcoder_state::integrations::core::budgets::BudgetPhase::Reserved {
                native.organization_budget_request(&operation,json!({"kind":"dispatch","reservation_id":slot,"expected_revision":reserved.revision}))?;
            }
            self.roots.insert(
                operation.clone(),
                OriginalTask {
                    facts: TaskFacts {
                        operation: operation.clone(),
                        task: kcoder_types::integrations::core::IntegrationEntityRef {
                            kind: kcoder_types::integrations::core::IntegrationEntityKind::Turn,
                            id: attempt.turn_id.clone(),
                            revision: None,
                        },
                        receipt_id: attempt.attempt_id.clone(),
                        slot,
                        accepted_sha256: digest(&record)?,
                    },
                    identity: attempt.clone(),
                    store,
                    children: BTreeMap::new(),
                    scheduled: BTreeMap::new(),
                    auxiliary: Vec::new(),
                },
            );
        }
        let root = self
            .roots
            .get(&operation)
            .context("ORGANIZATION_PARENT_TASK_REQUIRED")?;
        let slot = receipt(native.organization_budget_request(
            &operation,
            json!({"kind":"read","reservation_id":root.facts.slot}),
        )?)?;
        ensure!(
            !slot.execution_confirmed_terminal
                && slot.unit == kcoder_state::integrations::core::budgets::BudgetUnit::TaskSlot,
            "ORGANIZATION_PARENT_TASK_NOT_ACTIVE"
        );
        Ok(TaskFacts {
            operation: root.facts.operation.clone(),
            task: root.facts.task.clone(),
            receipt_id: root.facts.receipt_id.clone(),
            slot: root.facts.slot.clone(),
            accepted_sha256: root.facts.accepted_sha256.clone(),
        })
    }
    pub(super) fn prepare_child(
        &mut self,
        native: &NativeIntegrationContext,
        request: &NativeChildAdmissionRequest<'_>,
    ) -> Result<()> {
        native.verify()?;
        if request.parent_execution().attempt().is_none() {
            return self
                .workflows
                .prepare_child(native, request, &mut self.children);
        }
        let parent = request
            .parent_execution()
            .attempt()
            .context("ORGANIZATION_CHILD_ORIGINAL_PARENT_REQUIRED")?;
        let operation = if let Some(child) = self.children.get(&request.parent().session_id()) {
            ensure!(
                child.accepted
                    && child.identity == *parent
                    && child.state.matches(&request.parent().state),
                "ORGANIZATION_CHILD_PARENT_CHANGED"
            );
            child.root.clone()
        } else {
            format!("org-turn-{}", digest(parent)?)
        };
        let root = self
            .roots
            .get(&operation)
            .context("ORGANIZATION_PARENT_TASK_REQUIRED")?;
        let current = receipt(native.organization_budget_request(
            &operation,
            json!({"kind":"check","reservation_id":root.facts.slot}),
        )?)?;
        ensure!(
            !current.execution_confirmed_terminal,
            "ORGANIZATION_PARENT_TASK_NOT_ACTIVE"
        );
        ensure!(
            request
                .parent_execution()
                .matches_state(&request.parent().state)
                && request.parent().session_id() == parent.thread_id,
            "ORGANIZATION_PARENT_TASK_CHANGED"
        );
        let parent_store = actual_store(request.parent(), parent)?;
        let scheduled = root
            .scheduled
            .get(&request.run().run_id)
            .context("ORGANIZATION_ORIGINAL_SCHEDULED_RUN_REQUIRED")?;
        ensure!(
            scheduled.run == *request.run()
                && scheduled.parent == *parent
                && scheduled
                    .parent_state
                    .inspection_lifecycle_identity()
                    .matches(&request.parent().state),
            "ORGANIZATION_SCHEDULED_PARENT_CHANGED"
        );
        let mut parent_record = parent_store
            .load(parent)?
            .context("ORGANIZATION_ACCEPTED_REQUIRED")?;
        ensure!(
            (parent_record.status == TurnAttemptStatus::Accepted
                && parent_record.completion.is_none())
                || (parent_record.status.is_terminal() && parent_record.completion.is_some()),
            "ORGANIZATION_ACCEPTED_CHANGED"
        );
        parent_record.status = TurnAttemptStatus::Accepted;
        parent_record.completion = None;
        ensure!(
            digest(&parent_record)? == scheduled.accepted_sha256,
            "ORGANIZATION_ACCEPTED_CHANGED"
        );
        ensure!(
            self.children.len() < 1024
                && !self.children.contains_key(&request.child().session_id()),
            "ORGANIZATION_CHILD_BINDING_CONFLICT"
        );
        self.children.insert(
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
    pub(super) fn observe_child(
        &mut self,
        request: &NativeChildAdmissionRequest<'_>,
    ) -> Result<()> {
        let child = self
            .children
            .get_mut(&request.child().session_id())
            .context("ORGANIZATION_CHILD_BINDING_REQUIRED")?;
        ensure!(
            child.identity == *request.identity() && child.state.matches(&request.child().state),
            "ORGANIZATION_CHILD_ACCEPTED_CHANGED"
        );
        let store = actual_store(request.child(), request.identity())?;
        accepted(&store, request.identity())?;
        let children = if let Some(root) = self.roots.get_mut(&child.root) {
            &mut root.children
        } else {
            self.workflows.children(&child.root)?
        };
        children.insert(
            request.run().run_id.clone(),
            (store, request.identity().clone()),
        );
        child.accepted = true;
        Ok(())
    }
    pub(super) fn reconcile(&mut self, native: &NativeIntegrationContext) -> Result<()> {
        let mut ended = self.workflows.reconcile(native)?;
        for (operation, root) in &self.roots {
            let Some(record) = root.store.load(&root.identity)? else {
                continue;
            };
            if record.completion.is_none() || !record.status.is_terminal() {
                continue;
            }
            if root.auxiliary.iter().any(|work| work.strong_count() > 0) {
                continue;
            }
            if root.scheduled.values().any(|child| {
                child
                    .parent_state
                    .background_run_record(&child.run)
                    .is_none_or(|run| run.terminal.is_none())
            }) {
                continue;
            }
            let mut children_closed = true;
            for (store, identity) in root.children.values() {
                if !store
                    .load(identity)?
                    .is_some_and(|r| r.completion.is_some() && r.status.is_terminal())
                {
                    children_closed = false;
                    break;
                }
            }
            if !children_closed {
                continue;
            }
            let closed = native.organization_budget_request(
                operation,
                json!({"kind":"calls_closed","reservation_id":root.facts.slot}),
            )?;
            if closed["closed"] != true {
                continue;
            }
            let current = receipt(native.organization_budget_request(
                operation,
                json!({"kind":"read","reservation_id":root.facts.slot}),
            )?)?;
            native.organization_budget_request(operation,json!({"kind":"observe","reservation_id":root.facts.slot,"expected_revision":current.revision,
                "update_id":"original-turn-and-owned-children-terminal","coverage":"complete","usage":BudgetCharge::zero(),
                "terminal":{"receiptId":root.facts.receipt_id,"receiptSha256":digest(&record)?,"kind":"completed"}}))?;
            ended.push(operation.clone());
        }
        for id in ended {
            self.roots.remove(&id);
            self.children.retain(|_, child| child.root != id);
        }
        Ok(())
    }
}

#[path = "tasks/auxiliary.rs"]
mod auxiliary;
#[path = "tasks/scheduling.rs"]
mod scheduling;
#[path = "tasks/workflow.rs"]
mod workflow;
