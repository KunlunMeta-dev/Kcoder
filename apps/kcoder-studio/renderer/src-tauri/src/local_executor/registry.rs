//! Single shared executor state, pending requests, generations, and backend identity.

use super::*;

pub(super) type PendingSender = mpsc::Sender<Result<Value, String>>;
pub(super) type SharedExecutorInner = Arc<Mutex<LocalExecutorInner>>;

pub struct LocalExecutorState {
    pub(super) inner: SharedExecutorInner,
    pub(super) next_id: Arc<AtomicU64>,
    pub(super) start_lock: Arc<AsyncMutex<()>>,
    pub(super) backend_connection_lock: Arc<AsyncMutex<()>>,
}

impl Clone for LocalExecutorState {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            next_id: self.next_id.clone(),
            start_lock: self.start_lock.clone(),
            backend_connection_lock: self.backend_connection_lock.clone(),
        }
    }
}

#[derive(Default)]
pub(super) struct LocalExecutorInner {
    pub(super) child: Option<LocalExecutorChild>,
    pub(super) pending: HashMap<String, PendingSender>,
    pub(super) backend_connection: Option<LocalExecutorBackendConnection>,
    pub(super) running: bool,
    pub(super) ready: bool,
    pub(super) device_id: Option<String>,
    pub(super) runtime_instance_id: Option<String>,
    pub(super) version: Option<String>,
    pub(super) error: Option<String>,
    pub(super) generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LocalExecutorBackendConnection {
    pub(super) backend_url: String,
    pub(super) auth_token: String,
}

impl Default for LocalExecutorState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(LocalExecutorInner::default())),
            next_id: Arc::new(AtomicU64::new(1)),
            start_lock: Arc::new(AsyncMutex::new(())),
            backend_connection_lock: Arc::new(AsyncMutex::new(())),
        }
    }
}

pub(super) fn next_request_id(state: &LocalExecutorState) -> String {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    format!("local-req-{id}")
}

pub(super) fn status_from_inner(inner: &LocalExecutorInner) -> LocalExecutorStatus {
    LocalExecutorStatus {
        running: inner.running,
        ready: inner.ready,
        device_id: inner.device_id.clone(),
        runtime_instance_id: inner.runtime_instance_id.clone(),
        version: inner.version.clone(),
        error: inner.error.clone(),
    }
}

pub(super) fn status_from_state(state: &LocalExecutorState) -> Result<LocalExecutorStatus, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock local executor state".to_string())?;
    Ok(status_from_inner(&inner))
}

pub(super) fn normalize_command_arg(value: String, name: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(format!("{name} must not be empty"))
    } else {
        Ok(trimmed.to_string())
    }
}

pub(super) fn response_error(response: ExecutorResponse) -> String {
    response
        .error
        .map(|error| {
            if error.code.is_empty() {
                error.message
            } else {
                format!("{}: {}", error.code, error.message)
            }
        })
        .unwrap_or_else(|| "Local executor request failed".to_string())
}

pub(super) fn resolve_response_inner(inner: &SharedExecutorInner, response: ExecutorResponse) {
    let sender = inner
        .lock()
        .ok()
        .and_then(|mut inner| inner.pending.remove(&response.id));

    if let Some(sender) = sender {
        let result = if response.ok {
            Ok(response.result.unwrap_or(Value::Null))
        } else {
            Err(response_error(response))
        };
        let _ = sender.send(result);
    }
}

pub(super) fn fail_pending_requests(state: &LocalExecutorState, message: String) {
    fail_pending_requests_inner(&state.inner, message);
}

pub(super) fn fail_pending_requests_inner(inner: &SharedExecutorInner, message: String) {
    let pending = inner
        .lock()
        .map(|mut inner| {
            inner
                .pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    for sender in pending {
        let _ = sender.send(Err(message.clone()));
    }
}

pub(super) fn fail_pending_requests_for_generation(
    inner: &SharedExecutorInner,
    generation: u64,
    message: String,
) {
    let pending = inner
        .lock()
        .map(|mut inner| {
            if inner.generation != generation {
                return Vec::new();
            }
            inner
                .pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    for sender in pending {
        let _ = sender.send(Err(message.clone()));
    }
}

pub(super) fn remove_pending_request(inner: &SharedExecutorInner, request_id: &str) {
    if let Ok(mut inner) = inner.lock() {
        inner.pending.remove(request_id);
    }
}

pub(super) fn set_executor_error(state: &LocalExecutorState, error: String) {
    set_executor_error_inner(&state.inner, error);
}

pub(super) fn set_executor_error_inner(inner: &SharedExecutorInner, error: String) {
    if let Ok(mut inner) = inner.lock() {
        inner.running = false;
        inner.ready = false;
        inner.error = Some(error);
    }
}

pub(super) fn mark_child_terminated_for_generation(
    inner: &SharedExecutorInner,
    generation: u64,
    message: String,
) -> Option<LocalExecutorChild> {
    if let Ok(mut inner) = inner.lock() {
        if inner.generation != generation {
            return None;
        }
        let child = inner.child.take();
        inner.running = false;
        inner.ready = false;
        inner.error = Some(message);
        return child;
    }
    None
}

pub(super) fn update_ready_event_inner(
    inner: &SharedExecutorInner,
    event: &ExecutorEvent,
) -> Option<(String, String)> {
    if event.event != "executor.ready" {
        return None;
    }

    let ready = event
        .payload
        .get("ready")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let device_id = event
        .payload
        .get("device_id")
        .or_else(|| event.payload.get("deviceId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let version = event
        .payload
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string);
    let runtime_instance_id = event
        .payload
        .get("runtime_instance_id")
        .or_else(|| event.payload.get("runtimeInstanceId"))
        .and_then(Value::as_str)
        .map(str::to_string);

    if let Ok(mut inner) = inner.lock() {
        let replaced_runtime = inner
            .runtime_instance_id
            .as_ref()
            .zip(runtime_instance_id.as_ref())
            .filter(|(previous, current)| previous != current)
            .map(|(previous, current)| (previous.clone(), current.clone()));
        inner.running = true;
        inner.ready = ready;
        if device_id.is_some() {
            inner.device_id = device_id;
        }
        if runtime_instance_id.is_some() {
            inner.runtime_instance_id = runtime_instance_id;
        }
        if version.is_some() {
            inner.version = version;
        }
        if ready {
            inner.error = None;
        }
        return replaced_runtime;
    }

    None
}

pub(super) fn register_spawned_child(
    state: &LocalExecutorState,
    child: LocalExecutorChild,
) -> Result<u64, String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock local executor state".to_string())?;
    inner.generation = inner.generation.saturating_add(1);
    inner.child = Some(child);
    inner.running = true;
    inner.ready = false;
    inner.device_id = Some(
        inner
            .device_id
            .clone()
            .unwrap_or_else(|| LOCAL_EXECUTOR_DEVICE_ID.to_string()),
    );
    inner.error = None;
    Ok(inner.generation)
}

pub(super) fn replace_backend_connection(
    inner: &mut LocalExecutorInner,
    connection: Option<LocalExecutorBackendConnection>,
) -> bool {
    if inner.backend_connection == connection {
        return false;
    }
    inner.backend_connection = connection;
    true
}
