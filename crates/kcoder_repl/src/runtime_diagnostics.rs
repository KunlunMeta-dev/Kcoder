//! Runtime diagnostic records and platform signal listeners.

use super::*;

pub(super) fn append_repl_exit_diagnostic(engine: &QueryEngine, event: &str, reason: &str) {
    let Some(history_path) = engine.state.history_path() else {
        return;
    };
    let path = history_path.with_extension("exit.jsonl");
    let settings = recover_read_lock(&engine.settings, "engine.settings");
    let active_tasks = engine
        .state
        .tasks()
        .into_values()
        .filter(|task| matches!(task.status, TaskStatus::Pending | TaskStatus::Running))
        .map(|task| {
            serde_json::json!({
                "id": task.id,
                "description": task.description,
                "status": task.status,
                "updated_at_ms": task.updated_at_ms,
            })
        })
        .collect::<Vec<_>>();
    let entry = serde_json::json!({
        "session_id": engine.session_id(),
        "timestamp_ms": current_timestamp_ms(),
        "pid": std::process::id(),
        "cwd": engine.state.cwd(),
        "history_path": history_path,
        "model": settings.model.clone(),
        "provider": settings.provider.clone(),
        "event": event,
        "reason": reason,
        "active_tasks": active_tasks,
    });

    let result = (|| -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        writeln!(file, "{}", serde_json::to_string(&entry)?)?;
        Ok(())
    })();
    if let Err(error) = result {
        warn!(
            "failed to append REPL exit diagnostic {:?}: {}",
            path, error
        );
    }
}

pub(super) fn append_repl_engine_event_diagnostic(engine: &QueryEngine, event: &EngineEvent) {
    match event {
        EngineEvent::Error(error) => append_repl_exit_diagnostic(engine, "engine_error", error),
        EngineEvent::ProviderFailed { message, details } => {
            append_repl_exit_diagnostic(engine, details.category.as_str(), message)
        }
        EngineEvent::StreamAborted { reason } => {
            append_repl_exit_diagnostic(engine, "stream_aborted", reason)
        }
        EngineEvent::CompactionFailed { error, .. } => {
            append_repl_exit_diagnostic(engine, "compaction_failed", error)
        }
        EngineEvent::BackgroundJobFailed { id, error } => {
            append_repl_exit_diagnostic(engine, "background_job_failed", &format!("{id}: {error}"));
        }
        _ => {}
    }
}

pub(super) fn spawn_signal_listener(tx: AppEventSender) {
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut sigterm) => {
                    tokio::select! {
                        result = tokio::signal::ctrl_c() => {
                            let reason = result
                                .map(|_| "Ctrl+C".to_string())
                                .unwrap_or_else(|error| format!("Ctrl+C listener failed: {error}"));
                            warn!(%reason, "signal listener requested exit");
                            let _ = tx.send_ordered(AppEvent::Fatal(format!("exit requested by {reason}"))).await;
                        }
                        _ = sigterm.recv() => {
                            warn!("signal listener requested exit by SIGTERM");
                            let _ = tx.send_ordered(AppEvent::Fatal("exit requested by SIGTERM".to_string())).await;
                        }
                    }
                }
                Err(error) => {
                    warn!(%error, "failed to install SIGTERM listener");
                    let reason = tokio::signal::ctrl_c()
                        .await
                        .map(|_| "Ctrl+C".to_string())
                        .unwrap_or_else(|error| format!("Ctrl+C listener failed: {error}"));
                    warn!(%reason, "signal listener requested exit");
                    let _ = tx
                        .send_ordered(AppEvent::Fatal(format!("exit requested by {reason}")))
                        .await;
                }
            }
        }

        #[cfg(not(unix))]
        {
            let reason = tokio::signal::ctrl_c()
                .await
                .map(|_| "Ctrl+C".to_string())
                .unwrap_or_else(|error| format!("Ctrl+C listener failed: {error}"));
            warn!(%reason, "signal listener requested exit");
            let _ = tx
                .send_ordered(AppEvent::Fatal(format!("exit requested by {reason}")))
                .await;
        }
    });
}
