use super::*;
use crate::background::BackgroundJobEvent;
use crate::{BackgroundJobSpawner, SpawnError};
use kcoder_state::AppState;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

#[derive(Default)]
struct FakeBackgroundJobManager {
    spawned: Mutex<Vec<String>>,
}

impl BackgroundJobSpawner for FakeBackgroundJobManager {
    fn spawn(
        &self,
        description: String,
        _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        _max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawned.lock().unwrap().push(description);
        Ok("job-bash".to_string())
    }

    fn subscribe(&self) -> tokio::sync::broadcast::Receiver<BackgroundJobEvent> {
        let (_, rx) = tokio::sync::broadcast::channel(1);
        rx
    }

    fn abort(&self, _id: &str) -> bool {
        false
    }
}

struct ExecutingBackgroundJobManager {
    outputs: Mutex<HashMap<String, oneshot::Receiver<ToolOutput>>>,
    cancellations: Mutex<HashMap<String, Arc<dyn Fn() + Send + Sync>>>,
    events: tokio::sync::broadcast::Sender<BackgroundJobEvent>,
}

impl Default for ExecutingBackgroundJobManager {
    fn default() -> Self {
        let (events, _) = tokio::sync::broadcast::channel(16);
        Self {
            outputs: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            events,
        }
    }
}

impl ExecutingBackgroundJobManager {
    async fn output(&self, id: &str) -> ToolOutput {
        let receiver = self.outputs.lock().unwrap().remove(id).unwrap();
        receiver.await.unwrap()
    }
}

impl BackgroundJobSpawner for ExecutingBackgroundJobManager {
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
        _description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        _max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let id = format!("job-{}", self.outputs.lock().unwrap().len() + 1);
        let (tx, rx) = oneshot::channel();
        let event_tx = self.events.clone();
        let event_id = id.clone();
        let _ = self.events.send(BackgroundJobEvent::Started {
            id: id.clone(),
            description: "test command".to_string(),
            continuation: false,
        });
        tokio::spawn(async move {
            let output = work.await;
            let _ = event_tx.send(BackgroundJobEvent::Completed {
                id: event_id,
                output: output.clone(),
            });
            let _ = tx.send(output);
        });
        self.outputs.lock().unwrap().insert(id.clone(), rx);
        self.cancellations
            .lock()
            .unwrap()
            .insert(id.clone(), cancel);
        Ok(id)
    }

    fn subscribe(&self) -> tokio::sync::broadcast::Receiver<BackgroundJobEvent> {
        self.events.subscribe()
    }

    fn abort(&self, id: &str) -> bool {
        if let Some(cancel) = self.cancellations.lock().unwrap().remove(id) {
            cancel();
            true
        } else {
            false
        }
    }

    fn promote_to_background(&self, _id: &str) -> Result<(), SpawnError> {
        Ok(())
    }
}

fn output_text(output: &ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|block| match block {
            kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

mod verification;

#[cfg(unix)]
mod native_verifier;

#[cfg(windows)]
mod windows;

mod scope;

mod runtime;

mod snapshot;

mod output;

mod contract;
