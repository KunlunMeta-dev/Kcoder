//! One supervised worker per desktop lease. Stop has a separate watch channel;
//! it never waits for a blocked MCP exchange or silently replays a side effect.
use async_trait::async_trait;
use serde_json::Value;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerError {
    Busy,
    Stopped,
    Unavailable(&'static str),
    Timeout,
    Failed(String),
    Execution {
        detail: String,
        cleanup_confirmed: bool,
    },
    CleanupFailed(String),
}

#[async_trait]
pub trait DesktopWorker: Send + 'static {
    /// Cancellation of this future does not prove the underlying process stopped.
    async fn call(&mut self, tool: &str, arguments: Value) -> Result<Value, WorkerError>;
    /// Host-side proof only. Called after a complete tool-error reply; never
    /// after cancellation, a timeout or a lost transport. Default fails closed.
    fn can_continue_after_tool_error(&self) -> bool {
        false
    }
    /// Kill/reap the owned process tree. Success means it cannot inject more input.
    /// Must remain valid after cancellation of call().
    async fn shutdown(&mut self) -> Result<(), WorkerError>;
}
struct Call {
    tool: String,
    arguments: Value,
    reply: oneshot::Sender<Result<Value, WorkerError>>,
}

/// Not Clone: ownership follows a single desktop lease. Dropping this handle
/// requests cleanup; callers must await stop() before granting another lease.
pub struct WorkerHandle {
    gate: tokio::sync::Semaphore,
    calls: mpsc::Sender<Call>,
    stop: watch::Sender<bool>,
    result: watch::Receiver<Option<Result<(), WorkerError>>>,
}
impl Drop for WorkerHandle {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}
impl WorkerHandle {
    pub fn spawn<W: DesktopWorker>(worker: W, timeout: Duration) -> Self {
        let (calls, receiver) = mpsc::channel(1);
        let (stop, stopped) = watch::channel(false);
        let (completion, result) = watch::channel(None);
        tokio::spawn(run_worker(worker, receiver, stopped, completion, timeout));
        Self {
            gate: tokio::sync::Semaphore::new(1),
            calls,
            stop,
            result,
        }
    }
    pub async fn call(&self, tool: &str, arguments: Value) -> Result<Value, WorkerError> {
        if *self.stop.borrow() || self.result.borrow().is_some() {
            return Err(WorkerError::Stopped);
        }
        if !crate::policy::TOOLS.contains(&tool) || !arguments.is_object() {
            return Err(WorkerError::Failed("tool or arguments not allowed".into()));
        }
        let _permit = self.gate.try_acquire().map_err(|_| WorkerError::Busy)?;
        let (reply, response) = oneshot::channel();
        self.calls
            .try_send(Call {
                tool: tool.into(),
                arguments,
                reply,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => WorkerError::Busy,
                mpsc::error::TrySendError::Closed(_) => WorkerError::Stopped,
            })?;
        response.await.unwrap_or(Err(WorkerError::Stopped))
    }
    pub async fn stop(&self) -> Result<(), WorkerError> {
        let _ = self.stop.send(true);
        let mut result = self.result.clone();
        loop {
            if let Some(value) = result.borrow().clone() {
                return value;
            }
            result.changed().await.map_err(|_| {
                WorkerError::CleanupFailed("supervisor exited without cleanup receipt".into())
            })?;
        }
    }
}

async fn run_worker<W: DesktopWorker>(
    mut worker: W,
    mut calls: mpsc::Receiver<Call>,
    mut stop: watch::Receiver<bool>,
    completion: watch::Sender<Option<Result<(), WorkerError>>>,
    timeout: Duration,
) {
    let mut observation_required = false;
    loop {
        if *stop.borrow() {
            break;
        }
        let call = tokio::select! {
            biased;
            _ = stop.changed() => break,
            call = calls.recv() => match call { Some(call)=>call, None=>break },
        };
        let Call {
            tool,
            arguments,
            mut reply,
        } = call;
        let observation = matches!(
            tool.as_str(),
            "Snapshot" | "Screenshot" | "DisplayInventory"
        );
        let full_observation = crate::policy::supplies_full_observation(&tool, &arguments);
        if observation_required && !observation {
            let _ = reply.send(Ok(serde_json::json!({"isError":true,"content":[{"type":"text","text":"desktop_observation_required: An earlier operation failed. Observe the desktop with Snapshot, Screenshot or DisplayInventory before issuing another action. This action was not executed."}]})));
            continue;
        }
        // Cancelled callers may have lost their connection; never continue acting
        // in the background after their response channel has been dropped.
        // These operations cannot leave synthetic keys/buttons held. A tool-level
        // error is a received reply, not a broken transport. Keep observations
        // available after a denied/failed foreground activation.
        let observation_safe_error = matches!(
            tool.as_str(),
            "Snapshot" | "Screenshot" | "DisplayInventory"
        ) || (tool == "App"
            && arguments.get("mode").and_then(Value::as_str) == Some("switch"));
        let result = tokio::select! {
            biased;
            _ = stop.changed() => Err(WorkerError::Stopped),
            _ = reply.closed() => Err(WorkerError::Stopped),
            result = tokio::time::timeout(timeout, worker.call(&tool, arguments)) =>
                result.unwrap_or(Err(WorkerError::Timeout)),
        };
        // Input failures still retire the worker to release potentially held
        // input. A replied observation/window activation failure does not.
        let result = result.and_then(|mut value| {
            if value.get("isError").and_then(Value::as_bool) == Some(true) {
                if observation_safe_error || worker.can_continue_after_tool_error() {
                    if let Some(content) = value.get_mut("content").and_then(Value::as_array_mut) {
                        content.push(serde_json::json!({"type":"text", "text":
                            "The desktop worker replied with an operation error; the channel remains available. The action may have partially taken effect. Observe the current desktop before deciding what to do next; do not automatically repeat clicks, typing, or window switching."}));
                    }
                    Ok(value)
                } else {
                    Err(WorkerError::Execution { detail: tool_error_detail(&value), cleanup_confirmed: false })
                }
            } else {
                Ok(value)
            }
        });
        if let Ok(value) = &result {
            if value.get("isError").and_then(Value::as_bool) == Some(true) {
                observation_required = true;
            } else if full_observation {
                observation_required = false;
            }
        }
        let failed = result.is_err();
        let _ = reply.send(result);
        if failed {
            break;
        }
    }
    calls.close();
    while let Ok(call) = calls.try_recv() {
        let _ = call.reply.send(Err(WorkerError::Stopped));
    }
    let cleanup = match tokio::time::timeout(Duration::from_secs(35), worker.shutdown()).await {
        Ok(result) => result,
        Err(_) => Err(WorkerError::CleanupFailed(
            "worker termination was not confirmed".into(),
        )),
    };
    // Release owned reservations and input observers before the host sees the
    // receipt. A successor must never race a still-held exclusive resource.
    drop(worker);
    // A failure receipt cannot be treated as permission to start a new worker.
    let _ = completion.send(Some(cleanup));
}

/// Return bounded tool diagnostic text, not stderr or environment contents.
fn tool_error_detail(value: &Value) -> String {
    let mut detail = String::new();
    if let Some(content) = value.get("content").and_then(Value::as_array) {
        for block in content {
            if block.get("type").and_then(Value::as_str) == Some("text")
                && let Some(text) = block.get("text").and_then(Value::as_str)
            {
                if !detail.is_empty() {
                    detail.push('\n');
                }
                detail.extend(
                    text.chars()
                        .take(4096usize.saturating_sub(detail.chars().count())),
                );
                if detail.chars().count() >= 4096 {
                    break;
                }
            }
        }
    }
    if detail.is_empty() {
        "Desktop tool returned an execution error without diagnostic text".into()
    } else {
        detail
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    struct Blocked {
        entered: Arc<tokio::sync::Notify>,
        exited: Arc<AtomicBool>,
        cleanup_failure: bool,
    }
    struct ToolFailure(Arc<AtomicBool>);
    #[async_trait]
    impl DesktopWorker for ToolFailure {
        async fn call(&mut self, _: &str, _: Value) -> Result<Value, WorkerError> {
            Ok(serde_json::json!({
                "isError": true,
                "content": [{"type":"text", "text":"private upstream diagnostic"}]
            }))
        }
        async fn shutdown(&mut self) -> Result<(), WorkerError> {
            self.0.store(true, Ordering::SeqCst);
            Ok(())
        }
    }
    #[tokio::test]
    async fn cleanup_receipt_follows_exclusive_resource_release() {
        struct Reserved(Arc<AtomicBool>);
        impl Drop for Reserved {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        #[async_trait]
        impl DesktopWorker for Reserved {
            async fn call(&mut self, _: &str, _: Value) -> Result<Value, WorkerError> {
                Ok(serde_json::json!({}))
            }
            async fn shutdown(&mut self) -> Result<(), WorkerError> {
                Ok(())
            }
        }
        let released = Arc::new(AtomicBool::new(false));
        let worker = WorkerHandle::spawn(Reserved(released.clone()), Duration::from_secs(1));
        worker.stop().await.unwrap();
        assert!(released.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn mcp_execution_error_retires_worker_and_requires_cleanup() {
        let cleaned = Arc::new(AtomicBool::new(false));
        let handle = WorkerHandle::spawn(ToolFailure(cleaned.clone()), Duration::from_secs(1));
        assert_eq!(
            handle.call("Type", serde_json::json!({})).await,
            Err(WorkerError::Execution {
                detail: "private upstream diagnostic".into(),
                cleanup_confirmed: false
            })
        );
        handle.stop().await.unwrap();
        assert!(cleaned.load(Ordering::SeqCst));
        assert_eq!(
            handle.call("Type", serde_json::json!({})).await,
            Err(WorkerError::Stopped)
        );
    }
    #[tokio::test]
    async fn window_switch_error_preserves_reply_and_followup_observations() {
        let cleaned = Arc::new(AtomicBool::new(false));
        let handle = WorkerHandle::spawn(ToolFailure(cleaned.clone()), Duration::from_secs(1));
        let result = handle
            .call("App", serde_json::json!({"mode":"switch","name":"fixture"}))
            .await
            .unwrap();
        assert_eq!(result["isError"], true);
        assert!(result.to_string().contains("private upstream diagnostic"));
        assert!(result.to_string().contains("do not automatically repeat"));
        assert!(!cleaned.load(Ordering::SeqCst));
        for tool in ["Snapshot", "Screenshot", "DisplayInventory"] {
            assert_eq!(
                handle.call(tool, serde_json::json!({})).await.unwrap()["isError"],
                true
            );
        }
        handle.stop().await.unwrap();
        assert!(cleaned.load(Ordering::SeqCst));
    }

    struct RecoverableFailure(std::sync::Arc<std::sync::atomic::AtomicUsize>);
    #[async_trait]
    impl DesktopWorker for RecoverableFailure {
        fn can_continue_after_tool_error(&self) -> bool {
            true
        }
        async fn call(&mut self, tool: &str, _: Value) -> Result<Value, WorkerError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(
                serde_json::json!({"isError":tool == "Click", "content":[{"type":"text","text":if tool == "Click" {"SendInput rejected by Windows"} else {"desktop observed"}}]}),
            )
        }
        async fn shutdown(&mut self) -> Result<(), WorkerError> {
            Ok(())
        }
    }
    #[tokio::test]
    async fn replied_click_error_with_quiescent_input_keeps_observations_and_blocks_blind_replay() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handle = WorkerHandle::spawn(RecoverableFailure(calls.clone()), Duration::from_secs(1));
        let error = handle.call("Click", serde_json::json!({})).await.unwrap();
        assert!(error.to_string().contains("SendInput rejected"));
        let blocked = handle.call("Click", serde_json::json!({})).await.unwrap();
        assert!(blocked.to_string().contains("desktop_observation_required"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        handle
            .call("DisplayInventory", serde_json::json!({}))
            .await
            .unwrap();
        handle
            .call("Screenshot", serde_json::json!({"region":[0,0,10,10]}))
            .await
            .unwrap();
        assert!(
            handle
                .call("Type", serde_json::json!({}))
                .await
                .unwrap()
                .to_string()
                .contains("desktop_observation_required")
        );
        let observed = handle
            .call("Snapshot", serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(observed["isError"], false);
        handle.call("Click", serde_json::json!({})).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 5);
        handle.stop().await.unwrap();
    }

    #[async_trait]
    impl DesktopWorker for Blocked {
        async fn call(&mut self, _: &str, _: Value) -> Result<Value, WorkerError> {
            self.entered.notify_one();
            std::future::pending().await
        }
        async fn shutdown(&mut self) -> Result<(), WorkerError> {
            self.exited.store(true, Ordering::SeqCst);
            if self.cleanup_failure {
                Err(WorkerError::CleanupFailed("fixture".into()))
            } else {
                Ok(())
            }
        }
    }
    #[tokio::test]
    async fn stop_bypasses_blocked_call_and_waits_for_cleanup() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let exited = Arc::new(AtomicBool::new(false));
        let handle = Arc::new(WorkerHandle::spawn(
            Blocked {
                entered: entered.clone(),
                exited: exited.clone(),
                cleanup_failure: false,
            },
            Duration::from_secs(300),
        ));
        let call = tokio::spawn({
            let handle = handle.clone();
            async move { handle.call("Screenshot", serde_json::json!({})).await }
        });
        entered.notified().await;
        assert_eq!(
            handle.call("Click", serde_json::json!({})).await,
            Err(WorkerError::Busy)
        );
        tokio::time::timeout(Duration::from_secs(1), handle.stop())
            .await
            .unwrap()
            .unwrap();
        assert!(exited.load(Ordering::SeqCst));
        assert_eq!(call.await.unwrap(), Err(WorkerError::Stopped));
        assert_eq!(
            handle.call("Click", serde_json::json!({})).await,
            Err(WorkerError::Stopped)
        );
    }
    #[tokio::test]
    async fn timeout_preserves_cleanup_failure_and_does_not_replay() {
        let exited = Arc::new(AtomicBool::new(false));
        let handle = WorkerHandle::spawn(
            Blocked {
                entered: Arc::new(tokio::sync::Notify::new()),
                exited: exited.clone(),
                cleanup_failure: true,
            },
            Duration::from_millis(5),
        );
        assert_eq!(
            handle.call("Screenshot", serde_json::json!({})).await,
            Err(WorkerError::Timeout)
        );
        assert!(matches!(
            handle.stop().await,
            Err(WorkerError::CleanupFailed(_))
        ));
        assert!(exited.load(Ordering::SeqCst));
    }
    #[tokio::test(start_paused = true)]
    async fn stop_allows_sequential_process_and_clipboard_cleanup() {
        struct SlowCleanup;
        #[async_trait]
        impl DesktopWorker for SlowCleanup {
            async fn call(&mut self, _: &str, _: Value) -> Result<Value, WorkerError> {
                Ok(serde_json::json!({}))
            }
            async fn shutdown(&mut self) -> Result<(), WorkerError> {
                // Local reap followed by recovery reap, clipboard and reply.
                tokio::time::sleep(Duration::from_secs(21)).await;
                Ok(())
            }
        }
        let handle = WorkerHandle::spawn(SlowCleanup, Duration::from_secs(60));
        handle.stop().await.unwrap();
    }
}
