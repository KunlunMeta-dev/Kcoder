//! Read-only acceptance and terminal evidence. Absence is not proof of completion.

use super::{QueryEngine, TurnOutcomeArtifact, hex_sha256};
use std::io::Read;

pub(super) fn terminal_status(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
) -> Option<String> {
    let path = engine
        .session_storage_dir_for(thread_id)
        .join("turn-outcomes")
        .join(format!("{}.json", hex_sha256(turn_id.as_bytes())));
    let directory = kcoder_config::PrivateDirectory::open_existing(path.parent()?).ok()?;
    let mut bytes = Vec::new();
    directory
        .open_regular_file(path.file_name()?)
        .ok()?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 64 * 1024 {
        return None;
    }
    let outcome: TurnOutcomeArtifact = serde_json::from_slice(&bytes).ok()?;
    (outcome.version == 1
        && outcome.thread_id == thread_id
        && outcome.turn_id == turn_id
        && matches!(
            outcome.status.as_str(),
            "completed" | "failed" | "interrupted"
        ))
    .then_some(outcome.status)
}

pub(super) async fn query(
    params: serde_json::Value,
    manager: &super::thread_runtime::ThreadManager,
    workspace: &QueryEngine,
) -> anyhow::Result<kcoder_app_protocol::TurnReceiptReadResult> {
    use anyhow::{Context, ensure};
    use kcoder_app_protocol::{
        TurnAcceptanceReceipt, TurnReceiptReadParams, TurnReceiptReadResult, TurnReceiptStatus,
    };
    let params: TurnReceiptReadParams =
        serde_json::from_value(params).context("invalid receipt query")?;
    params.validate().map_err(anyhow::Error::msg)?;
    let resident = manager.engine(&params.thread_id);
    let engine = resident.as_ref().unwrap_or(workspace);
    // Same ownership/workspace boundary as thread/read; no thread activation or lease claim.
    super::thread_history_path(engine, &params.thread_id)?;
    if let Some(operation) = params.retry_operation_id.as_deref() {
        let matches = super::turn_attempts::records(engine, &params.thread_id)?
            .into_iter()
            .filter(|record| record.retry_operation_id.as_deref() == Some(operation))
            .collect::<Vec<_>>();
        ensure!(
            matches.len() <= 1,
            "operation identity names multiple attempts"
        );
        if let Some(record) = matches.into_iter().next() {
            use kcoder_types::TurnAttemptStatus;
            let status = match record.status {
                TurnAttemptStatus::Completed => TurnReceiptStatus::Completed,
                TurnAttemptStatus::Failed => TurnReceiptStatus::Failed,
                TurnAttemptStatus::Interrupted => TurnReceiptStatus::Interrupted,
                TurnAttemptStatus::Accepted => {
                    let running = if let Some(state) = manager.turn_state(&params.thread_id) {
                        state
                            .active_turn
                            .lock()
                            .await
                            .as_ref()
                            .is_some_and(|active| {
                                active.turn_id == record.identity.turn_id
                                    && !active.handle.is_finished()
                            })
                    } else {
                        false
                    };
                    if running {
                        TurnReceiptStatus::Running
                    } else {
                        TurnReceiptStatus::Unknown
                    }
                }
            };
            return Ok(TurnReceiptReadResult {
                receipt: Some(TurnAcceptanceReceipt {
                    thread_id: params.thread_id,
                    turn_id: record.identity.turn_id,
                    attempt_id: Some(record.identity.attempt_id),
                    status,
                }),
            });
        }
    }
    let root = engine.session_storage_dir_for(&params.thread_id);
    let mut matches = Vec::new();
    if let Some(identity) = params.client_message_id {
        for record in
            read_records::<super::TurnClientMessageArtifact>(&root.join("turn-client-messages"))?
        {
            ensure!(
                record.version == 1 && record.thread_id == params.thread_id,
                "invalid submission receipt identity"
            );
            if record.client_message_id == identity {
                matches.push(record.turn_id);
            }
        }
    } else if let Some(identity) = params.retry_operation_id {
        for record in
            read_records::<super::TurnContinuationArtifact>(&root.join("turn-continuations"))?
        {
            ensure!(
                record.version == 1 && record.thread_id == params.thread_id,
                "invalid continuation receipt identity"
            );
            if record.retry_operation_id.as_deref() == Some(identity.as_str()) {
                matches.push(record.turn_id);
            }
        }
    }
    // An explicit re-submission may deliberately reuse a client id. Do not choose an arbitrary attempt.
    ensure!(
        matches.len() <= 1,
        "operation identity names multiple attempts; inspect thread history"
    );
    let Some(turn_id) = matches.pop() else {
        return Ok(TurnReceiptReadResult { receipt: None });
    };
    let running = if let Some(state) = manager.turn_state(&params.thread_id) {
        state
            .active_turn
            .lock()
            .await
            .as_ref()
            .is_some_and(|active| active.turn_id == turn_id && !active.handle.is_finished())
    } else {
        false
    };
    let status = if running {
        TurnReceiptStatus::Running
    } else {
        match terminal_status(engine, &params.thread_id, &turn_id).as_deref() {
            Some("completed") => TurnReceiptStatus::Completed,
            Some("failed") => TurnReceiptStatus::Failed,
            Some("interrupted") => TurnReceiptStatus::Interrupted,
            _ => TurnReceiptStatus::Unknown,
        }
    };
    Ok(TurnReceiptReadResult {
        receipt: Some(TurnAcceptanceReceipt {
            thread_id: params.thread_id,
            turn_id,
            status,
            attempt_id: None,
        }),
    })
}

pub(super) fn read_records<T: serde::de::DeserializeOwned>(
    directory: &std::path::Path,
) -> anyhow::Result<Vec<T>> {
    use anyhow::{Context, ensure};
    match std::fs::symlink_metadata(directory) {
        Ok(metadata) => ensure!(
            metadata.file_type().is_dir(),
            "invalid acceptance receipt directory"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("cannot inspect acceptance receipt directory"),
    }
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("cannot read acceptance receipts"),
    };
    let handle = kcoder_config::PrivateDirectory::open_existing(directory)?;
    let mut records = Vec::new();
    let mut total_bytes = 0usize;
    for (index, entry) in entries.enumerate() {
        ensure!(index < 10_000, "acceptance receipt lookup limit exceeded");
        let path = entry?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let mut bytes = Vec::new();
        handle
            .open_regular_file(path.file_name().context("missing receipt filename")?)?
            .take(64 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 64 * 1024,
            "acceptance receipt exceeds size limit"
        );
        total_bytes = total_bytes.saturating_add(bytes.len());
        ensure!(
            total_bytes <= 64 * 1024 * 1024,
            "acceptance receipt collection exceeds size limit"
        );
        records.push(serde_json::from_slice(&bytes).context("cannot decode acceptance receipt")?);
    }
    Ok(records)
}
