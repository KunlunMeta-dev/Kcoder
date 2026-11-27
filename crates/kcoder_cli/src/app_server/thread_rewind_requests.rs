//! Manual compaction and rollback as owned per-thread maintenance.
//!
//! Admission runs on the dispatch loop under the thread's activity gate; the
//! long work (summary generation, checkpoint restore) runs as a task owned by
//! the thread runtime. The request's response is still sent when the work is
//! final, so the wire contract of `thread/compact` and `thread/rollback` is
//! unchanged, but every other request on this app-server keeps being served.

use super::*;
use kcoder_app_protocol::{
    METHOD_THREAD_MAINTENANCE_CANCEL, THREAD_COMPACTION_CANCELLED_KIND,
    ThreadMaintenanceCancelParams, ThreadMaintenanceCancelResult, ThreadMaintenanceOperation,
    ThreadMaintenanceStatus,
};

pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &mut ThreadManager,
    state: &ConnectionState,
) -> Result<DispatchControl> {
    match method {
        METHOD_THREAD_MAINTENANCE_CANCEL => {
            let reply = cancel_compaction(id, params, thread_manager, state);
            send(outbound_tx, reply).await?;
        }
        method::THREAD_COMPACT => {
            let prepared = kcoder_app_rpc_codec::decode::<ThreadCompactParams>(params)
                .context("invalid thread/compact params")
                .and_then(|params| {
                    let engine = resident_engine(thread_manager, &params.thread_id, "compact")?;
                    Ok((params.thread_id, engine))
                });
            let (thread_id, engine) = match prepared {
                Ok(prepared) => prepared,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32030, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            let Some(owner) = claim(
                thread_manager,
                &thread_id,
                ThreadMaintenanceOperation::Compact,
                &id,
                -32030,
                state,
                outbound_tx,
            )
            .await?
            else {
                return Ok(DispatchControl::Continue);
            };
            let outbound = outbound_tx.clone();
            let task_owner = owner.clone();
            let handle = task_spawn::spawn(async move {
                let result = engine
                    .compact_conversation_cancellable(task_owner.cancel.clone())
                    .await;
                let (response, status) = match result {
                    Ok(result) => match serde_json::to_value(ThreadCompactResult {
                        thread_id: task_owner.thread_id.clone(),
                        compacted: result.did_compact,
                        pre_tokens: result.pre_compact_tokens,
                        post_tokens: result.post_compact_tokens,
                    }) {
                        Ok(value) => (
                            success_response(id, value),
                            ThreadMaintenanceStatus::Completed,
                        ),
                        Err(error) => (
                            error_response(id, -32030, &error.to_string()),
                            ThreadMaintenanceStatus::Failed,
                        ),
                    },
                    Err(error) if error.is::<kcoder_engine::CompactionCancelled>() => {
                        let mut response = error_response(id, -32030, "compaction cancelled");
                        if task_owner.notify_identity {
                            response["error"]["data"] =
                                json!({ "kind": THREAD_COMPACTION_CANCELLED_KIND });
                        }
                        (response, ThreadMaintenanceStatus::Cancelled)
                    }
                    Err(error) => (
                        error_response(id, -32030, &error.to_string()),
                        ThreadMaintenanceStatus::Failed,
                    ),
                };
                task_owner.finish(&outbound, response, status).await;
            });
            owner.attach(handle);
        }
        method::THREAD_ROLLBACK => {
            let prepared = kcoder_app_rpc_codec::decode::<ThreadRollbackParams>(params)
                .context("invalid thread/rollback params")
                .and_then(|params| {
                    let engine = resident_engine(thread_manager, &params.thread_id, "rollback")?;
                    let turn = params
                        .turn
                        .or_else(|| {
                            engine
                                .user_request_turn_previews()
                                .last()
                                .map(|(turn, _)| *turn)
                        })
                        .context("thread has no user turn to rollback")?;
                    let followups = thread_manager
                        .followups(&params.thread_id)
                        .context("thread/start or thread/resume is required")?;
                    Ok((params.thread_id, turn, engine, followups))
                });
            let (thread_id, turn, engine, followups) = match prepared {
                Ok(prepared) => prepared,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32031, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            let Some(owner) = claim(
                thread_manager,
                &thread_id,
                ThreadMaintenanceOperation::Rollback,
                &id,
                -32031,
                state,
                outbound_tx,
            )
            .await?
            else {
                return Ok(DispatchControl::Continue);
            };
            let outbound = outbound_tx.clone();
            let task_owner = owner.clone();
            // File restoration and the durable rewind boundary are not
            // interruptible: a partial restore would leave the workspace and
            // transcript out of step. Shutdown waits for it instead.
            let handle = task_spawn::spawn(async move {
                let (response, status) = match engine.checkpoints_rewind(turn).await {
                    Ok((report, conversation)) => {
                        match update_client_turn_count_after_rewind(
                            &engine,
                            &followups,
                            conversation,
                        ) {
                            Err(error) => (
                                error_response(id, -32031, &error.to_string()),
                                ThreadMaintenanceStatus::Failed,
                            ),
                            Ok(()) => match serde_json::to_value(ThreadRollbackResult {
                                thread_id: task_owner.thread_id.clone(),
                                turn,
                                removed_messages: conversation
                                    .map(|value| value.removed)
                                    .unwrap_or(0),
                                restored_files: report.restored.len(),
                                deleted_files: report.deleted.len(),
                                failed_files: report.failed.len(),
                            }) {
                                Ok(value) => (
                                    success_response(id, value),
                                    ThreadMaintenanceStatus::Completed,
                                ),
                                Err(error) => (
                                    error_response(id, -32031, &error.to_string()),
                                    ThreadMaintenanceStatus::Failed,
                                ),
                            },
                        }
                    }
                    Err(error) => {
                        // Rewind may already have changed memory before a durable write fails.
                        followups.client_turn_count.invalidate();
                        (
                            error_response(id, -32031, &error.to_string()),
                            ThreadMaintenanceStatus::Failed,
                        )
                    }
                };
                task_owner.finish(&outbound, response, status).await;
            });
            owner.attach(handle);
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}

fn resident_engine(
    thread_manager: &mut ThreadManager,
    thread_id: &str,
    operation: &str,
) -> Result<QueryEngine> {
    if thread_manager.is_turn_running(thread_id) {
        anyhow::bail!("cannot {operation} while a turn is running")
    }
    let engine = thread_manager
        .select(thread_id)
        .context("thread/start or thread/resume is required")?;
    ensure_active_thread(&engine, thread_manager.lease(thread_id), thread_id)?;
    Ok(engine)
}

/// Owner of one admitted maintenance operation.
fn cancel_compaction(
    id: Value,
    params: Value,
    thread_manager: &ThreadManager,
    state: &ConnectionState,
) -> Value {
    if !state.thread_maintenance_cancel_v1 {
        return error_response(
            id,
            -32601,
            "threadMaintenanceCancelV1 negotiation is required",
        );
    }
    let Ok(params) = serde_json::from_value::<ThreadMaintenanceCancelParams>(params) else {
        return error_response(id, -32602, "invalid thread/maintenance/cancel params");
    };
    let Ok(identity) = uuid::Uuid::parse_str(&params.maintenance_id) else {
        return error_response(id, -32602, "invalid maintenanceId");
    };
    if identity.get_variant() != uuid::Variant::RFC4122
        || identity.get_version() != Some(uuid::Version::Random)
        || identity.to_string() != params.maintenance_id
        || validate_thread_id(&params.thread_id).is_err()
    {
        return error_response(id, -32602, "invalid thread or maintenance identity");
    }
    let cancellation_requested = thread_manager
        .turn_state(&params.thread_id)
        .is_some_and(|turn| turn.cancel_compaction(Some(identity)));
    success_response(
        id,
        json!(ThreadMaintenanceCancelResult {
            cancellation_requested
        }),
    )
}

#[derive(Clone)]
struct MaintenanceOwner {
    thread_id: String,
    operation: ThreadMaintenanceOperation,
    claim_id: uuid::Uuid,
    cancel: CancellationToken,
    turn_state: ResidentTurnState,
    followups: Arc<BackgroundFollowupState>,
    notify: bool,
    notify_identity: bool,
}

impl MaintenanceOwner {
    fn attach(&self, handle: tokio::task::JoinHandle<()>) {
        self.turn_state
            .attach_maintenance_handle(self.claim_id, handle);
    }

    /// Release the claim under the activity gate, then publish the response
    /// before the terminal notification and wake deferred schedulers.
    async fn finish(
        &self,
        outbound: &mpsc::Sender<Value>,
        response: Value,
        status: ThreadMaintenanceStatus,
    ) {
        {
            let _gate = self.turn_state.activity_gate.lock().await;
            self.turn_state.finish_maintenance(self.claim_id);
        }
        // The connection may already be closing; the outcome stays in State.
        let _ = send(outbound, response).await;
        if self.notify {
            let _ = send(
                outbound,
                maintenance_notification(
                    &self.thread_id,
                    self.operation,
                    status,
                    self.notify_identity.then_some(self.claim_id),
                ),
            )
            .await;
        }
        self.followups.notify.notify_waiters();
    }
}

fn maintenance_notification(
    thread_id: &str,
    operation: ThreadMaintenanceOperation,
    status: ThreadMaintenanceStatus,
    identity: Option<uuid::Uuid>,
) -> Value {
    notification(
        kcoder_app_protocol::METHOD_THREAD_MAINTENANCE,
        serde_json::to_value(kcoder_app_protocol::ThreadMaintenanceParams {
            thread_id: thread_id.to_owned(),
            operation,
            status,
            maintenance_id: identity.map(|id| id.to_string()),
        })
        .unwrap_or(Value::Null),
    )
}

/// Admit one maintenance operation under the thread's activity gate or send
/// the rejection. A rejection precedes any mutation of the thread.
async fn claim(
    thread_manager: &ThreadManager,
    thread_id: &str,
    operation: ThreadMaintenanceOperation,
    id: &Value,
    legacy_code: i64,
    state: &ConnectionState,
    outbound_tx: &mpsc::Sender<Value>,
) -> Result<Option<MaintenanceOwner>> {
    let (Some(turn_state), Some(followups)) = (
        thread_manager.turn_state(thread_id),
        thread_manager.followups(thread_id),
    ) else {
        send(
            outbound_tx,
            error_response(
                id.clone(),
                legacy_code,
                "thread/start or thread/resume is required",
            ),
        )
        .await?;
        return Ok(None);
    };
    let claimed = {
        let _activity = turn_state.activity_gate.lock().await;
        if turn_state.running.load(Ordering::SeqCst) {
            Err(None)
        } else if let Some(running) = turn_state.maintenance_operation() {
            Err(Some(running))
        } else {
            turn_state.try_begin_maintenance(operation).ok_or(None)
        }
    };
    match claimed {
        Ok(claim) => {
            let notify_identity = state.thread_maintenance_cancel_v1
                && operation == ThreadMaintenanceOperation::Compact;
            if state.thread_maintenance_v1
                && let Err(error) = send(
                    outbound_tx,
                    maintenance_notification(
                        thread_id,
                        operation,
                        ThreadMaintenanceStatus::Started,
                        notify_identity.then_some(claim.id),
                    ),
                )
                .await
            {
                let _gate = turn_state.activity_gate.lock().await;
                turn_state.finish_maintenance(claim.id);
                followups.notify.notify_waiters();
                return Err(error);
            }
            Ok(Some(MaintenanceOwner {
                thread_id: thread_id.to_owned(),
                operation,
                claim_id: claim.id,
                cancel: claim.cancel,
                turn_state,
                followups,
                notify: state.thread_maintenance_v1,
                notify_identity,
            }))
        }
        Err(Some(running)) => {
            send(
                outbound_tx,
                maintenance_busy_response(
                    id.clone(),
                    thread_id,
                    running,
                    legacy_code,
                    state.thread_maintenance_v1,
                ),
            )
            .await?;
            Ok(None)
        }
        Err(None) => {
            let message = format!("cannot {} while a turn is running", operation.as_str());
            send(
                outbound_tx,
                error_response(id.clone(), legacy_code, &message),
            )
            .await?;
            Ok(None)
        }
    }
}

/// The typed rejection for a request that conflicts with the thread's running
/// maintenance. Clients without `threadMaintenanceV1` keep `legacy_code`.
pub(super) fn maintenance_busy_response(
    id: Value,
    thread_id: &str,
    running: ThreadMaintenanceOperation,
    legacy_code: i64,
    maintenance_v1: bool,
) -> Value {
    let message = format!(
        "thread {} is in progress; retry after it completes",
        running.as_str()
    );
    if !maintenance_v1 {
        // Legacy turn admission keeps its retry-safe busy contract verbatim.
        if legacy_code == TURN_ALREADY_RUNNING {
            return error_response(
                id,
                legacy_code,
                kcoder_runtime_driver::TURN_BUSY_BEFORE_REGISTRATION_MESSAGE,
            );
        }
        return error_response(id, legacy_code, &message);
    }
    let mut response = error_response(id, kcoder_app_protocol::THREAD_MAINTENANCE_BUSY, &message);
    if let Ok(data) = serde_json::to_value(kcoder_app_protocol::ThreadMaintenanceBusyErrorDataV1 {
        thread_id: thread_id.to_owned(),
        operation: running,
    }) {
        response["error"]["data"] = data;
    }
    response
}
