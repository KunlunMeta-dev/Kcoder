//! Read-only acceptance and terminal evidence. Absence is not proof of completion.

use super::QueryEngine;
pub(super) use kcoder_turn_lifecycle::receipts::{submitted_turn_id, terminal_status};
use kcoder_turn_lifecycle::turn_artifacts::continuation_turns_for_operation;

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
                TurnAttemptStatus::Unknown(_) => TurnReceiptStatus::Unknown,
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
    let mut matches = if let Some(identity) = params.client_message_id {
        submitted_turn_id(engine, &params.thread_id, &identity)?
            .into_iter()
            .collect()
    } else if let Some(identity) = params.retry_operation_id {
        continuation_turns_for_operation(engine, &params.thread_id, &identity)?
    } else {
        Vec::new()
    };
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
    let attempts: Vec<_> = super::turn_attempts::records(engine, &params.thread_id)?
        .into_iter()
        .filter(|record| record.identity.turn_id == turn_id)
        .collect();
    // A client-message receipt can identify an attempt only if it is unique.
    // Legacy sessions and continuation trees retain the old optional contract.
    let attempt_id = (attempts.len() == 1).then(|| attempts[0].identity.attempt_id.clone());
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
            attempt_id,
        }),
    })
}
