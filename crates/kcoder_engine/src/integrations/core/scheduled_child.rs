//! Freeze a real manager-owned run while its original spawning tool is active.
use super::NativeToolExecutionWitness;
use crate::QueryEngine;
use anyhow::{Result, ensure};
use kcoder_types::BackgroundRunKey;

pub struct NativeScheduledChildRequest<'a> {
    parent: &'a QueryEngine,
    execution: &'a NativeToolExecutionWitness,
    run: &'a BackgroundRunKey,
}

#[cfg(test)]
#[path = "scheduled_child_tests.rs"]
mod tests;
impl<'a> NativeScheduledChildRequest<'a> {
    pub fn parent(&self) -> &QueryEngine {
        self.parent
    }
    pub fn parent_execution(&self) -> &NativeToolExecutionWitness {
        self.execution
    }
    pub fn run(&self) -> &BackgroundRunKey {
        self.run
    }
    pub(crate) fn capture(
        parent: &'a QueryEngine,
        execution: &'a NativeToolExecutionWitness,
        run: &'a BackgroundRunKey,
    ) -> Result<Self> {
        ensure!(
            execution.matches_state(&parent.state) && execution.session_id() == parent.session_id(),
            "NATIVE_SCHEDULED_PARENT_CHANGED"
        );
        ensure!(
            run.parent_session_id == parent.session_id()
                && parent.background_jobs.has_live_run(&run.agent_id, run),
            "NATIVE_SCHEDULED_RUN_REQUIRED"
        );
        ensure!(
            parent
                .state
                .task_for_background_run(run)
                .is_some_and(|task| task.managed
                    && task.kind == kcoder_state::TaskKind::Subagent
                    && task.parent_session_id.as_deref() == Some(run.parent_session_id.as_str())
                    && task.background_run.as_ref() == Some(run)
                    && matches!(
                        task.status,
                        kcoder_types::TaskStatus::Pending | kcoder_types::TaskStatus::Running
                    )),
            "NATIVE_SCHEDULED_RUN_CHANGED"
        );
        ensure!(
            parent
                .state
                .background_run_record(run)
                .is_some_and(|record| record.terminal.is_none() && !record.imported_history),
            "NATIVE_SCHEDULED_RUN_CHANGED"
        );
        uuid::Uuid::parse_str(&run.run_id)?;
        Ok(Self {
            parent,
            execution,
            run,
        })
    }
}
