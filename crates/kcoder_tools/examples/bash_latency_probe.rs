//! Measure real Bash tool execution without an Engine or model.
//! The caller supplies an isolated workspace and the same native owner program
//! for both builds. A minimal task adapter enables production live log capture.
use kcoder_state::{AppState, Task};
use kcoder_tools::{
    BackgroundJobSpawner, SpawnError, Tool, ToolContext, ToolOutput,
    background::BackgroundJobEvent, bash::BashTool,
};
use kcoder_types::ContentBlock;
use serde_json::json;
use std::{
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::sync::broadcast;

type Cancellation = Arc<dyn Fn() + Send + Sync>;

struct Jobs {
    state: AppState,
    output_path: PathBuf,
    events: broadcast::Sender<BackgroundJobEvent>,
    cancellation: Mutex<Option<Cancellation>>,
    worker: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl BackgroundJobSpawner for Jobs {
    fn spawn(
        &self,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_cancellable(description, work, Arc::new(|| {}), max_concurrent)
    }

    fn spawn_cancellable(
        &self,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Cancellation,
        _max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let id = "benchmark-owned-shell".to_owned();
        let mut task = Task::new(&id, &description);
        task.output_path = Some(self.output_path.clone());
        self.state.upsert_task(task);
        *self.cancellation.lock().unwrap() = Some(cancel);
        let events = self.events.clone();
        let task_id = id.clone();
        *self.worker.lock().unwrap() = Some(tokio::spawn(async move {
            let output = work.await;
            let _ = events.send(BackgroundJobEvent::Completed {
                id: task_id,
                output,
            });
        }));
        Ok(id)
    }

    fn subscribe(&self) -> broadcast::Receiver<BackgroundJobEvent> {
        self.events.subscribe()
    }

    fn abort(&self, _id: &str) -> bool {
        if let Some(cancel) = self.cancellation.lock().unwrap().take() {
            cancel();
            true
        } else {
            false
        }
    }
}

impl Drop for Jobs {
    fn drop(&mut self) {
        self.abort("benchmark-owned-shell");
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let workspace = PathBuf::from(args.next().expect("isolated workspace"));
    let owner = PathBuf::from(args.next().expect("native command owner executable"));
    let variant = args.next().expect("quiet, burst or paced");
    anyhow::ensure!(workspace.is_absolute() && owner.is_absolute() && args.next().is_none());
    anyhow::ensure!(matches!(variant.as_str(), "quiet" | "burst" | "paced"));
    let output_path = workspace.join("task-output.txt");
    let state = AppState::new(&workspace);
    let (events, _) = broadcast::channel(16);
    let jobs = Arc::new(Jobs {
        state: state.clone(),
        output_path: output_path.clone(),
        events,
        cancellation: Mutex::new(None),
        worker: Mutex::new(None),
    });
    let ctx = ToolContext::new(state)
        .with_background_job_manager(jobs.clone())
        .with_owned_command_program(Some(owner))
        .with_output_limits(102400, 61440, 40960);
    let started = Instant::now();
    let output = BashTool
        .call(
            json!({
                "command": format!("python3 producer.py {variant}"), "timeout": 30000,
            }),
            &ctx,
        )
        .await?;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    let worker = jobs.worker.lock().unwrap().take();
    if let Some(worker) = worker {
        worker.await?;
    }
    let text: String = output
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    let snapshot = tokio::fs::read_to_string(&output_path).await?;
    let valid =
        !output.is_error && text.contains("BASH_PROBE_END") && snapshot.contains("BASH_PROBE_END");
    println!(
        "{}",
        json!({
            "variant": variant, "elapsed_ms": elapsed_ms, "valid": valid,
            "result_bytes": text.len(), "snapshot_bytes": snapshot.len(),
            "owned_worker_settled": true,
        })
    );
    anyhow::ensure!(valid, "Bash result or final live snapshot was incomplete");
    Ok(())
}
