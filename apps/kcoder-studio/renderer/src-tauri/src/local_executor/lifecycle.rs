//! Single-owner sidecar startup/readiness, restart, failure and shutdown lifecycle.

use super::*;

pub fn shutdown_local_executor(state: &LocalExecutorState, reason: &str) {
    audit_local_executor_signal(format!(
        "event=executor_shutdown_entered sender_pid={} reason={reason}",
        std::process::id()
    ));
    let child = state.inner.lock().ok().and_then(|mut inner| {
        inner.running = false;
        inner.ready = false;
        inner.generation = inner.generation.saturating_add(1);
        inner.error = Some("Local executor stopped".to_string());
        inner.child.take()
    });

    if let Some(child) = child {
        child.kill();
    } else {
        audit_local_executor_signal(format!(
            "event=executor_shutdown_no_owned_child sender_pid={} reason={reason}",
            std::process::id()
        ));
    }

    fail_pending_requests_inner(&state.inner, "Local executor stopped".to_string());
    audit_local_executor_signal(format!(
        "event=executor_shutdown_finished sender_pid={} reason={reason}",
        std::process::id()
    ));
}

pub(super) fn spawn_configured_sidecar(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
    path: PathBuf,
    envs: &[(String, String)],
) -> Result<mpsc::Receiver<Result<(), String>>, String> {
    if !path.exists() {
        return Err(format!(
            "Configured local executor sidecar does not exist: {}",
            path.display()
        ));
    }

    let mut command = Command::new(&path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.envs(envs.iter().map(|(key, value)| (key, value)));
    configure_managed_process_group(&mut command);
    let mut child = command.spawn().map_err(|error| {
        format!(
            "Failed to start local executor sidecar {}: {error}",
            path.display()
        )
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Local executor stdout is unavailable".to_string())?;
    if let Some(stderr) = child.stderr.take() {
        drain_process_output(LocalExecutorOutputStream::Stderr, stderr);
    }
    let generation = register_spawned_child(
        state,
        LocalExecutorChild::Process(ManagedProcessChild::new(child)),
    )?;
    let state_handle = state.inner.clone();
    let (ready_sender, ready_receiver) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut ready_sender = Some(ready_sender);
        for line in reader.lines() {
            match line {
                Ok(line) => handle_stdio_line(&app, &state_handle, &mut ready_sender, &line),
                Err(error) => {
                    let message = format!("Local executor stdout read failed: {error}");
                    finish_stdio_reader(
                        &app,
                        &state_handle,
                        generation,
                        &mut ready_sender,
                        message,
                        true,
                    );
                    return;
                }
            }
        }
        finish_stdio_reader(
            &app,
            &state_handle,
            generation,
            &mut ready_sender,
            "Local executor stdout closed".to_string(),
            true,
        );
    });
    Ok(ready_receiver)
}

pub(super) fn spawn_bundled_sidecar(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
    envs: &[(String, String)],
) -> Result<mpsc::Receiver<Result<(), String>>, String> {
    let sidecar = app
        .shell()
        .sidecar(LOCAL_EXECUTOR_SIDECAR)
        .map_err(|error| {
            format!("Failed to resolve local executor sidecar {LOCAL_EXECUTOR_SIDECAR}: {error}")
        })?
        .envs(envs.iter().map(|(key, value)| (key, value)));
    let (mut rx, child) = sidecar.spawn().map_err(|error| {
        format!("Failed to start local executor sidecar {LOCAL_EXECUTOR_SIDECAR}: {error}")
    })?;

    let generation = register_spawned_child(state, LocalExecutorChild::Tauri(child))?;
    let state_handle = state.inner.clone();
    let (ready_sender, ready_receiver) = mpsc::channel();
    tauri::async_runtime::spawn(async move {
        let mut ready_sender = Some(ready_sender);
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    if !text.trim().is_empty() {
                        handle_stdio_line(&app, &state_handle, &mut ready_sender, text.trim());
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    if !text.trim().is_empty() {
                        LocalExecutorOutputStream::Stderr.log_line(text.trim());
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let message = format!("Local executor exited: {payload:?}");
                    finish_stdio_reader(
                        &app,
                        &state_handle,
                        generation,
                        &mut ready_sender,
                        message,
                        false,
                    );
                    return;
                }
                CommandEvent::Error(error) => {
                    let message = format!("Local executor stdio failed: {error}");
                    finish_stdio_reader(
                        &app,
                        &state_handle,
                        generation,
                        &mut ready_sender,
                        message,
                        true,
                    );
                    return;
                }
                _ => {}
            }
        }
        finish_stdio_reader(
            &app,
            &state_handle,
            generation,
            &mut ready_sender,
            "Local executor stdio closed".to_string(),
            true,
        );
    });
    Ok(ready_receiver)
}

pub(super) async fn wait_for_executor_ready(
    receiver: mpsc::Receiver<Result<(), String>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(LOCAL_EXECUTOR_READY_TIMEOUT_SECS))
            .unwrap_or_else(|_| Err("Timed out waiting for local executor ready event".to_string()))
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(super) fn stop_failed_sidecar_start(state: &LocalExecutorState, error: &str) {
    let child = state.inner.lock().ok().and_then(|mut inner| {
        inner.running = false;
        inner.ready = false;
        inner.error = Some(error.to_string());
        inner.generation = inner.generation.saturating_add(1);
        inner.child.take()
    });
    if let Some(child) = child {
        child.kill();
    }
    fail_pending_requests(state, error.to_string());
}

pub(super) async fn spawn_sidecar(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
) -> Result<(), String> {
    let envs = {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        local_executor_sidecar_env(&inner, &app)
    };
    prepare_local_executor_codex_auth(&envs)?;
    let receiver = if let Some(path) = configured_sidecar_path() {
        spawn_configured_sidecar(app, state, path, &envs)?
    } else {
        spawn_bundled_sidecar(app, state, &envs)?
    };
    if let Err(error) = wait_for_executor_ready(receiver).await {
        stop_failed_sidecar_start(state, &error);
        return Err(error);
    }
    let ready = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock local executor state".to_string())?
        .ready;
    if !ready {
        let error = "Local executor did not report ready".to_string();
        stop_failed_sidecar_start(state, &error);
        return Err(error);
    }
    Ok(())
}

pub(super) async fn start_executor_if_needed_unlocked(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
) -> Result<(), String> {
    let child_to_kill = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        if inner.running && inner.ready {
            if inner
                .child
                .as_mut()
                .map(LocalExecutorChild::is_running)
                .unwrap_or(false)
            {
                return Ok(());
            }
        }
        inner.running = false;
        inner.ready = false;
        inner.child.take()
    };
    if let Some(child) = child_to_kill {
        child.kill();
    }
    if let Err(error) = spawn_sidecar(app, state).await {
        set_executor_error(state, error.clone());
        return Err(error);
    }
    Ok(())
}

pub(super) async fn start_executor_if_needed(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
) -> Result<(), String> {
    let _guard = state.start_lock.lock().await;
    start_executor_if_needed_unlocked(app, state).await
}
