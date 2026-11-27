//! Native proof of the manager future that currently owns delegated work.

use super::BackgroundJobManager;
use kcoder_state::{AppState, AppStateLifecycleIdentity, TaskKind, TaskStatus};
use kcoder_types::BackgroundRunKey;
use sha2::{Digest, Sha256};
use std::future::Future;

pub(crate) struct WorkflowRecoveryClaim {
    state: AppStateLifecycleIdentity,
    workflow: BackgroundRunKey,
    previous: BackgroundRunKey,
    task_sha256: String,
}
impl WorkflowRecoveryClaim {
    pub(super) fn verify(
        &self,
        manager: &BackgroundJobManager,
        task: &kcoder_state::Task,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.state.matches(&manager.state)
                && manager.current_owned_workflow_run().as_ref() == Some(&self.workflow)
                && task.background_run.as_ref() == Some(&self.previous)
                && task.id == self.previous.agent_id
                && task.kind == TaskKind::Subagent
                && task.managed
                && task.status == TaskStatus::Failed
                && task.delivery == kcoder_state::TaskDelivery::Foreground
                && !task.notify_parent_on_completion
                && self.previous.parent_session_id == manager.state.session_id()
                && !manager.has_live_run(&task.id, &self.previous)
                && manager
                    .state
                    .background_run_record(&self.previous)
                    .is_some_and(|record| record.status == TaskStatus::Failed
                        && record.terminal.is_some()
                        && !record.imported_history)
                && self.task_sha256 == task_sha(task)?,
            "WORKFLOW_RECOVERY_ORIGINAL_OWNER_CHANGED"
        );
        Ok(())
    }
}
fn task_sha(task: &kcoder_state::Task) -> anyhow::Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(task)?)))
}

struct OwnedRun {
    state: AppStateLifecycleIdentity,
    run: BackgroundRunKey,
}

tokio::task_local! {
    static CURRENT_RUN: OwnedRun;
}

pub(super) async fn scope<T>(
    state: &AppState,
    run: BackgroundRunKey,
    work: impl Future<Output = T>,
) -> T {
    CURRENT_RUN
        .scope(
            OwnedRun {
                state: state.inspection_lifecycle_identity(),
                run,
            },
            work,
        )
        .await
}

impl BackgroundJobManager {
    pub(crate) fn respawn_original_subagent(
        &self,
        expected: &BackgroundRunKey,
        description: String,
        work: std::pin::Pin<Box<dyn Future<Output = kcoder_tools::ToolOutput> + Send>>,
        cancel: std::sync::Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, kcoder_tools::SpawnError> {
        let max_concurrent = Some(
            max_concurrent
                .filter(|value| *value > 0)
                .unwrap_or(super::MAX_CONCURRENT_SUBAGENTS)
                .min(super::MAX_CONCURRENT_SUBAGENTS),
        );
        self.spawn_with_id_and_kind_for_run(
            expected.agent_id.clone(),
            description,
            work,
            super::SpawnPolicy {
                cancel: Some(cancel),
                max_concurrent,
                kind: TaskKind::Subagent,
                count_subagents_only: true,
                reuse_existing: true,
                adopt_unstarted: false,
                workflow_recovery: None,
                notify_parent_on_completion: true,
            },
            Some(expected),
        )
    }
    pub(crate) fn can_cancel_paused_run(&self, expected: &BackgroundRunKey) -> bool {
        !crate::recover_read_lock(&self.cancelled, "background_job_cancelled")
            .contains(&expected.agent_id)
            && !crate::recover_read_lock(&self.handles, "background_job_handles")
                .contains_key(&expected.agent_id)
            && self.state.task(&expected.agent_id).is_some_and(|task| {
                task.managed
                    && task.kind == TaskKind::Subagent
                    && task.status == TaskStatus::Paused
                    && task.background_run.as_ref() == Some(expected)
                    && task.background_runs.iter().any(|record| {
                        &record.key == expected
                            && !record.imported_history
                            && record.terminal.is_none()
                    })
            })
    }

    /// Hold the original admission claim through the paused run's atomic close.
    pub(crate) fn cancel_paused_for_run(
        &self,
        expected: &BackgroundRunKey,
    ) -> anyhow::Result<bool> {
        let _admission = self
            .admission
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        anyhow::ensure!(
            expected.parent_session_id == self.state.session_id(),
            "agent_stop_identity_conflict"
        );
        if !self.can_cancel_paused_run(expected) {
            return Ok(false);
        }
        let cancelled = self.state.cancel_paused_subagent_run(expected)?;
        if cancelled {
            self.publish(super::BackgroundJobEvent::Cancelled {
                id: expected.agent_id.clone(),
                reason: "cancelled by user".into(),
            })?;
        }
        Ok(cancelled)
    }

    pub(crate) fn current_owned_workflow_run(&self) -> Option<BackgroundRunKey> {
        CURRENT_RUN
            .try_with(|owner| {
                (owner.state.matches(&self.state)
                    && self.has_live_run(&owner.run.agent_id, &owner.run)
                    && self
                        .state
                        .task_for_background_run(&owner.run)
                        .is_some_and(|task| {
                            task.managed
                                && task.kind == TaskKind::Workflow
                                && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
                        })
                    && self
                        .state
                        .background_run_record(&owner.run)
                        .is_some_and(|record| {
                            record.terminal.is_none() && !record.imported_history
                        }))
                .then(|| owner.run.clone())
            })
            .ok()
            .flatten()
    }
    pub(crate) fn workflow_recovery_claim(
        &self,
        previous: &BackgroundRunKey,
    ) -> anyhow::Result<WorkflowRecoveryClaim> {
        let workflow = self
            .current_owned_workflow_run()
            .ok_or_else(|| anyhow::anyhow!("WORKFLOW_RECOVERY_NATIVE_OWNER_REQUIRED"))?;
        let task = self
            .state
            .task(&previous.agent_id)
            .ok_or_else(|| anyhow::anyhow!("WORKFLOW_RECOVERY_ORIGINAL_TASK_REQUIRED"))?;
        let claim = WorkflowRecoveryClaim {
            state: self.state.inspection_lifecycle_identity(),
            workflow,
            previous: previous.clone(),
            task_sha256: task_sha(&task)?,
        };
        claim.verify(self, &task)?;
        Ok(claim)
    }
    pub(crate) fn spawn_recovered_workflow_foreground(
        &self,
        id: String,
        description: String,
        work: std::pin::Pin<Box<dyn Future<Output = kcoder_tools::ToolOutput> + Send>>,
        cancel: std::sync::Arc<dyn Fn() + Send + Sync>,
        cap: usize,
        claim: WorkflowRecoveryClaim,
    ) -> Result<String, kcoder_tools::SpawnError> {
        self.spawn_with_id_and_kind(
            id,
            description,
            work,
            super::SpawnPolicy {
                cancel: Some(cancel),
                max_concurrent: Some(cap),
                kind: TaskKind::Subagent,
                count_subagents_only: true,
                reuse_existing: true,
                adopt_unstarted: false,
                workflow_recovery: Some(claim),
                notify_parent_on_completion: false,
            },
        )
    }
    pub(crate) fn spawn_declared_subagent_foreground(
        &self,
        id: String,
        description: String,
        work: std::pin::Pin<Box<dyn Future<Output = kcoder_tools::ToolOutput> + Send>>,
        cancel: std::sync::Arc<dyn Fn() + Send + Sync>,
        cap: usize,
    ) -> Result<String, kcoder_tools::SpawnError> {
        self.spawn_with_id_and_kind(
            id,
            description,
            work,
            super::SpawnPolicy {
                cancel: Some(cancel),
                max_concurrent: Some(cap),
                kind: TaskKind::Subagent,
                count_subagents_only: true,
                reuse_existing: true,
                adopt_unstarted: true,
                workflow_recovery: None,
                notify_parent_on_completion: false,
            },
        )
    }

    pub(crate) fn abort_owned_foreground(&self, run: &BackgroundRunKey) -> bool {
        self.abort_checked(&run.agent_id, Some(run))
    }

    pub(crate) async fn abort_owned_foreground_and_wait(
        &self,
        run: &BackgroundRunKey,
    ) -> anyhow::Result<bool> {
        self.abort_and_wait_checked(
            &run.agent_id,
            Some((run, kcoder_state::TaskDelivery::Foreground)),
        )
        .await
    }

    pub(crate) fn current_work_owns_subagent(&self, id: &str) -> bool {
        CURRENT_RUN
            .try_with(|owner| {
                owner.state.matches(&self.state)
                    && owner.run.agent_id == id
                    && self.has_live_run(id, &owner.run)
                    && self
                        .state
                        .task_for_background_run(&owner.run)
                        .is_some_and(|task| {
                            task.managed
                                && task.kind == TaskKind::Subagent
                                && task.parent_session_id.as_deref()
                                    == Some(owner.run.parent_session_id.as_str())
                                && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
                        })
            })
            .unwrap_or(false)
    }
}
