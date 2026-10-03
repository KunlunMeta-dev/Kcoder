//! Line protocol parsing, stdout/stderr forwarding, request matching and timeouts.

use super::*;

pub fn parse_executor_line(line: &str) -> Result<ExecutorLine, String> {
    serde_json::from_str::<ExecutorLine>(line).map_err(|error| error.to_string())
}

pub(super) fn handle_executor_line_inner(
    app: &tauri::AppHandle,
    inner: &SharedExecutorInner,
    line: &str,
) -> Result<(), String> {
    if line.trim().is_empty() {
        return Ok(());
    }

    match parse_executor_line(line)? {
        ExecutorLine::Response(response) => {
            resolve_response_inner(inner, response);
        }
        ExecutorLine::Event(event) => {
            app.state::<crate::system_sleep::SystemSleepState>()
                .handle_runtime_event(
                    &event.event,
                    event.payload.get("taskId").and_then(Value::as_str),
                );
            if let Some((previous_runtime_instance_id, runtime_instance_id)) =
                update_ready_event_inner(inner, &event)
            {
                log::warn!(
                    "Local executor runtime replaced: previous_runtime_instance_id={}, runtime_instance_id={}",
                    previous_runtime_instance_id,
                    runtime_instance_id
                );
                app.emit(
                    LOCAL_EXECUTOR_EVENT,
                    ExecutorEvent {
                        event: "executor.runtime_replaced".to_string(),
                        payload: json!({
                            "previousRuntimeInstanceId": previous_runtime_instance_id,
                            "runtimeInstanceId": runtime_instance_id,
                        }),
                    },
                )
                .map_err(|error| error.to_string())?;
            }
            let terminal = is_terminal_response_event(&event.event);
            let terminal_event = event.event.clone();
            let terminal_task_id = event
                .payload
                .get("taskId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let terminal_subtask_id = event
                .payload
                .get("subtaskId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let terminal_device_id = event
                .payload
                .get("deviceId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if terminal {
                log::info!(
                    "Received runtime terminal event from executor: event={}, task_id={:?}, subtask_id={:?}, device_id={:?}",
                    terminal_event,
                    terminal_task_id,
                    terminal_subtask_id,
                    terminal_device_id
                );
            }
            if event.event == "runtime.plan.updated" {
                log::info!(
                    "Forwarding runtime task plan event to frontend: task_id={:?}, device_id={:?}",
                    event.payload.get("taskId"),
                    event.payload.get("deviceId")
                );
            }
            if let Err(error) = app.emit(LOCAL_EXECUTOR_EVENT, event) {
                if terminal {
                    log::warn!(
                        "Failed to forward runtime terminal event to frontend: event={}, task_id={:?}, subtask_id={:?}, device_id={:?}, error={}",
                        terminal_event,
                        terminal_task_id,
                        terminal_subtask_id,
                        terminal_device_id,
                        error
                    );
                }
                return Err(error.to_string());
            }
            if terminal {
                log::info!(
                    "Forwarded runtime terminal event to frontend event bus: event={}, task_id={:?}, subtask_id={:?}, device_id={:?}",
                    terminal_event,
                    terminal_task_id,
                    terminal_subtask_id,
                    terminal_device_id
                );
            }
        }
    }

    Ok(())
}

pub(super) fn is_terminal_response_event(event: &str) -> bool {
    matches!(
        event,
        "response.completed" | "response.failed" | "response.incomplete"
    )
}

pub(super) fn write_request_line(inner: &mut LocalExecutorInner, line: &str) -> Result<(), String> {
    let Some(child) = inner.child.as_mut() else {
        return Err("Local executor stdio is not connected".to_string());
    };
    child.write(line.as_bytes())
}

pub(super) fn drain_process_output(
    stream: LocalExecutorOutputStream,
    output: impl std::io::Read + Send + 'static,
) {
    thread::spawn(move || {
        let reader = BufReader::new(output);
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                stream.log_line(trimmed);
            }
        }
    });
}

pub(super) fn report_ready_from_protocol(
    state: &SharedExecutorInner,
    sender: &mut Option<mpsc::Sender<Result<(), String>>>,
) {
    let ready = state.lock().map(|inner| inner.ready).unwrap_or(false);
    if ready {
        if let Some(sender) = sender.take() {
            let _ = sender.send(Ok(()));
        }
    }
}

pub(super) fn handle_stdio_line(
    app: &tauri::AppHandle,
    state: &SharedExecutorInner,
    sender: &mut Option<mpsc::Sender<Result<(), String>>>,
    line: &str,
) {
    if let Err(error) = handle_executor_line_inner(app, state, line) {
        log::warn!("Failed to handle local executor stdio line: {error}");
        if let Some(sender) = sender.take() {
            let _ = sender.send(Err(error));
        }
        return;
    }
    report_ready_from_protocol(state, sender);
}

pub(super) fn finish_stdio_reader(
    app: &tauri::AppHandle,
    state: &SharedExecutorInner,
    generation: u64,
    sender: &mut Option<mpsc::Sender<Result<(), String>>>,
    message: String,
    terminate_child: bool,
) {
    app.state::<crate::system_sleep::SystemSleepState>()
        .clear_running_tasks();
    if let Some(sender) = sender.take() {
        let _ = sender.send(Err(message.clone()));
    }
    let child = mark_child_terminated_for_generation(state, generation, message.clone());
    fail_pending_requests_for_generation(state, generation, message);
    if terminate_child {
        if let Some(child) = child {
            child.kill();
        }
    }
}

pub(super) async fn send_executor_request(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
    request: LocalExecutorRequest,
) -> Result<Value, String> {
    send_executor_request_with_timeout(
        app,
        state,
        request,
        Duration::from_secs(LOCAL_EXECUTOR_REQUEST_TIMEOUT_SECONDS),
    )
    .await
}

pub(super) async fn send_executor_request_with_timeout(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
    request: LocalExecutorRequest,
    timeout: Duration,
) -> Result<Value, String> {
    start_executor_if_needed(app, state).await?;

    let request_id = next_request_id(state);
    let method = request.method.clone();
    let log_request = method != "executor.health";
    let started_at = Instant::now();
    let (sender, receiver) = mpsc::channel::<Result<Value, String>>();
    let message = json!({
        "type": "request",
        "id": request_id,
        "method": method,
        "params": request.params,
    });
    let line = format!(
        "{}\n",
        serde_json::to_string(&message).map_err(|error| error.to_string())?
    );

    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        inner.pending.insert(request_id.clone(), sender);
        let pending_count = inner.pending.len();
        if log_request {
            log::info!(
                "Local executor IPC request started: request_id={request_id}, method={method}, pending_count={pending_count}"
            );
        }
        if let Err(error) = write_request_line(&mut inner, &line) {
            inner.pending.remove(&request_id);
            log::warn!(
                "Local executor IPC request write failed: request_id={request_id}, method={method}, error={error}"
            );
            return Err(error);
        }
    }

    let inner = state.inner.clone();
    let wait_request_id = request_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        match receiver.recv_timeout(timeout) {
            Ok(result) => {
                if log_request {
                    log::info!(
                        "Local executor IPC request finished: request_id={wait_request_id}, method={method}, elapsed_ms={}",
                        started_at.elapsed().as_millis()
                    );
                }
                result
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                log::warn!(
                    "Local executor IPC request disconnected: request_id={wait_request_id}, method={method}, elapsed_ms={}",
                    started_at.elapsed().as_millis()
                );
                Err("Local executor disconnected".to_string())
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let message = format!(
                    "Local executor request {method} timed out after {}s",
                    timeout.as_secs()
                );
                log::warn!(
                    "Local executor IPC request timed out: request_id={wait_request_id}, method={method}, elapsed_ms={}",
                    started_at.elapsed().as_millis()
                );
                remove_pending_request(&inner, &wait_request_id);
                Err(message)
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}
