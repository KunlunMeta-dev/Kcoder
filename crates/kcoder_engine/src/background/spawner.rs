use super::{BackgroundJobEvent, BackgroundJobManager, SpawnPolicy, now_millis};
use kcoder_state::{TaskDelivery, TaskKind};
use kcoder_tools::{BackgroundJobSpawner, SpawnError, ToolOutput};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::broadcast;

impl BackgroundJobSpawner for BackgroundJobManager {
    fn spawn(
        &self,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_with_cap(description, work, max_concurrent)
    }

    fn spawn_cancellable(
        &self,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_cancellable_with_cap(description, work, cancel, max_concurrent)
    }

    fn spawn_foreground(
        &self,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_foreground_with_cap(description, work, max_concurrent)
    }

    fn spawn_cancellable_foreground(
        &self,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_cancellable_foreground_with_cap(description, work, cancel, max_concurrent)
    }

    fn spawn_subagent(
        &self,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_subagent_with_cap(description, work, max_concurrent)
    }

    fn spawn_subagent_with_id(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_subagent_with_id_with_cap(id, description, work, max_concurrent)
    }

    fn spawn_cancellable_subagent_with_id(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_cancellable_subagent_with_id_with_cap(
            id,
            description,
            work,
            cancel,
            max_concurrent,
        )
    }

    fn spawn_workflow_with_id(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_workflow_with_id_with_cap(id, description, work, max_concurrent)
    }

    fn spawn_workflow_cancellable_with_id(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_with_id_and_kind(
            id,
            description,
            work,
            SpawnPolicy {
                cancel: Some(cancel),
                max_concurrent,
                kind: TaskKind::Workflow,
                count_subagents_only: false,
                reuse_existing: false,
                notify_parent_on_completion: true,
            },
        )
    }

    fn respawn_workflow(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.respawn_workflow_with_id_with_cap(id, description, work, max_concurrent)
    }

    fn respawn_workflow_cancellable(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_with_id_and_kind(
            id,
            description,
            work,
            SpawnPolicy {
                cancel: Some(cancel),
                max_concurrent,
                kind: TaskKind::Workflow,
                count_subagents_only: false,
                reuse_existing: true,
                notify_parent_on_completion: true,
            },
        )
    }

    fn spawn_subagent_foreground_with_id(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_subagent_foreground_with_id_with_cap(id, description, work, max_concurrent)
    }

    fn spawn_cancellable_subagent_foreground_with_id(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_cancellable_subagent_foreground_with_id_with_cap(
            id,
            description,
            work,
            cancel,
            max_concurrent,
        )
    }

    fn respawn_subagent(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.respawn_subagent_with_cap(id, description, work, max_concurrent)
    }

    fn respawn_cancellable_subagent(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.respawn_cancellable_subagent_with_cap(id, description, work, cancel, max_concurrent)
    }

    fn subscribe(&self) -> broadcast::Receiver<BackgroundJobEvent> {
        self.subscribe()
    }

    fn abort(&self, id: &str) -> bool {
        self.abort(id)
    }

    fn abort_and_wait<'a>(
        &'a self,
        id: &'a str,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(BackgroundJobManager::abort_and_wait(self, id))
    }

    fn promote_to_background(&self, id: &str) -> Result<(), SpawnError> {
        self.promote_to_background_delivery(id)
    }

    fn associate_subagent_tool_call(
        &self,
        id: &str,
        tool_call_id: &str,
        run_in_background: bool,
    ) -> Result<(), SpawnError> {
        BackgroundJobManager::associate_subagent_tool_call(
            self,
            id,
            tool_call_id,
            run_in_background,
        )
    }

    fn finish_foreground_delivery(&self, id: &str) {
        let foreground_task = self.state.task(id).filter(|task| {
            task.managed
                && matches!(task.kind, TaskKind::Generic)
                && matches!(task.delivery, TaskDelivery::Foreground)
        });
        if let Some(task) = foreground_task {
            self.state.remove_task(id);
            if let Some(path) = task.output_path {
                let _ = std::fs::remove_file(&path);
                if let Some(task_dir) = path.parent() {
                    let _ = std::fs::remove_dir(task_dir);
                }
            }
        } else {
            self.state.update_task(id, |task| {
                task.notification_injected_at_ms = Some(now_millis());
                task.notify_parent_on_completion = false;
            });
        }
    }

    fn is_running(&self, id: &str) -> bool {
        crate::recover_read_lock(&self.handles, "background_job_handles").contains_key(id)
    }
}
