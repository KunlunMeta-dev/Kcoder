//! Persisted asynchronous question RPCs and their ordinary-turn delivery route.

mod admission;

use super::*;
use kcoder_app_interactions::async_questions::{
    QuestionTurnLifecycle, claim_delivery, classify_question_turns, current_question,
    reconcile_persisted_claim, safe_turn_start_rejection,
};
pub(super) use kcoder_app_interactions::async_questions::{
    async_question_message_text, publish_changed,
};
use kcoder_app_protocol::{
    AsyncQuestionAnswerParams, AsyncQuestionAnswerResult, AsyncQuestionCancelParams,
    AsyncQuestionCancelResult, AsyncQuestionListParams, AsyncQuestionListResult,
};
use kcoder_types::async_user_questions::{AsyncQuestionDeliveryClaim, AsyncQuestionRecord};

pub(super) fn supports(method: &str) -> bool {
    matches!(
        method,
        kcoder_app_protocol::method::ASYNC_QUESTION_LIST
            | kcoder_app_protocol::method::ASYNC_QUESTION_ANSWER
            | kcoder_app_protocol::method::ASYNC_QUESTION_CANCEL
    )
}

#[expect(
    clippy::too_many_arguments,
    reason = "Async answer admission must reuse the owning app-server turn resources explicitly"
)]
pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    engine: &mut QueryEngine,
    engine_factory: &AppServerEngineFactory,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &mut ThreadManager,
    server_id: &str,
    sequence: &Arc<AtomicU64>,
    state: &mut ConnectionState,
    attachment_directories: &mut AttachmentDirectories,
    next_interaction_id: &Arc<AtomicU64>,
    retained_authority: Option<retained_turn::Authority<'_>>,
) -> Result<DispatchControl> {
    if !state.async_user_questions_v1 {
        send(
            outbound_tx,
            error_response(id, -32601, "asyncUserQuestionsV1 negotiation is required"),
        )
        .await?;
        return Ok(DispatchControl::Continue);
    }

    match method {
        kcoder_app_protocol::method::ASYNC_QUESTION_LIST => {
            let params = match kcoder_app_rpc_codec::decode::<AsyncQuestionListParams>(params) {
                Ok(params) if params.validate().is_ok() => params,
                _ => {
                    send(
                        outbound_tx,
                        error_response(id, -32602, "invalid async question list params"),
                    )
                    .await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            let Some(thread_engine) = owned_thread_engine(thread_manager, &params.thread_id) else {
                send(
                    outbound_tx,
                    error_response(
                        id,
                        -32025,
                        "async question thread is not owned by this connection",
                    ),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            };
            let owner = thread_engine.state.inspection_lifecycle_identity();
            match reconcile_orphaned_deliveries(
                &thread_engine,
                thread_manager,
                outbound_tx,
                &params.thread_id,
            )
            .await
            {
                Ok(()) => match thread_engine
                    .state
                    .list_async_questions(&owner, params.include_terminal.unwrap_or(false))
                {
                    Ok(questions) => {
                        send(
                            outbound_tx,
                            success_response(
                                id,
                                kcoder_app_rpc_codec::encode(AsyncQuestionListResult {
                                    thread_id: params.thread_id,
                                    questions,
                                })?,
                            ),
                        )
                        .await?
                    }
                    Err(_) => {
                        send(
                            outbound_tx,
                            error_response(id, -32063, "async question state is unavailable"),
                        )
                        .await?
                    }
                },
                Err(_) => {
                    send(
                        outbound_tx,
                        error_response(id, -32063, "async question delivery state is unavailable"),
                    )
                    .await?
                }
            }
        }
        kcoder_app_protocol::method::ASYNC_QUESTION_CANCEL => {
            let params = match kcoder_app_rpc_codec::decode::<AsyncQuestionCancelParams>(params) {
                Ok(params) if params.validate().is_ok() => params,
                _ => {
                    send(
                        outbound_tx,
                        error_response(id, -32602, "invalid async question cancel params"),
                    )
                    .await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            let Some(thread_engine) = owned_thread_engine(thread_manager, &params.thread_id) else {
                send(
                    outbound_tx,
                    error_response(
                        id,
                        -32025,
                        "async question thread is not owned by this connection",
                    ),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            };
            let owner = thread_engine.state.inspection_lifecycle_identity();
            match thread_engine.state.cancel_async_question(
                &owner,
                &params.question_id,
                params.expected_revision,
            ) {
                Ok(question) => {
                    publish_changed(outbound_tx, &question).await;
                    send(
                        outbound_tx,
                        success_response(
                            id,
                            kcoder_app_rpc_codec::encode(AsyncQuestionCancelResult {
                                thread_id: params.thread_id,
                                question,
                            })?,
                        ),
                    )
                    .await?;
                }
                Err(_) => {
                    send(
                        outbound_tx,
                        error_response(id, -32064, "async question could not be cancelled"),
                    )
                    .await?
                }
            }
        }
        kcoder_app_protocol::method::ASYNC_QUESTION_ANSWER => {
            let params = match kcoder_app_rpc_codec::decode::<AsyncQuestionAnswerParams>(params) {
                Ok(params) if params.validate().is_ok() => params,
                _ => {
                    send(
                        outbound_tx,
                        error_response(id, -32602, "invalid async question answer params"),
                    )
                    .await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            if params.async_user_questions == Some(false) {
                send(
                    outbound_tx,
                    error_response(
                        id,
                        -32601,
                        "asyncUserQuestionsV1 was not enabled by this client",
                    ),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            let Some(thread_engine) = owned_thread_engine(thread_manager, &params.thread_id) else {
                send(
                    outbound_tx,
                    error_response(
                        id,
                        -32025,
                        "async question thread is not owned by this connection",
                    ),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            };
            if !thread_accepts_answer_delivery(&thread_engine) {
                send(
                    outbound_tx,
                    error_response(
                        id,
                        -32064,
                        "async question answer is unavailable for this thread",
                    ),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            let owner = thread_engine.state.inspection_lifecycle_identity();
            let receipt = match thread_engine.state.answer_async_question(
                &owner,
                &params.question_id,
                params.expected_revision,
                &params.submission_id,
                params.answers.clone(),
            ) {
                Ok(receipt) => receipt,
                Err(_) => {
                    send(
                        outbound_tx,
                        error_response(id, -32064, "async question answer was rejected"),
                    )
                    .await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            let can_route_or_reconcile = receipt.accepted
                && (!receipt.duplicate
                    || matches!(
                        receipt.question.status,
                        kcoder_types::async_user_questions::AsyncQuestionStatus::Queued
                            | kcoder_types::async_user_questions::AsyncQuestionStatus::DeliveryUnknown
                    ));
            let mut route = if can_route_or_reconcile {
                route_first_answer(
                    &params,
                    receipt.question.clone(),
                    receipt.duplicate,
                    &thread_engine,
                    engine,
                    engine_factory,
                    thread_manager,
                    server_id,
                    sequence,
                    state,
                    attachment_directories,
                    next_interaction_id,
                    retained_authority,
                )
                .await?
            } else {
                AnswerRouteOutcome::default()
            };
            let question = route
                .question
                .take()
                .unwrap_or_else(|| receipt.question.clone());
            send(
                outbound_tx,
                success_response(
                    id,
                    kcoder_app_rpc_codec::encode(AsyncQuestionAnswerResult {
                        thread_id: params.thread_id,
                        question: question.clone(),
                        accepted: receipt.accepted,
                        duplicate: receipt.duplicate,
                        started_turn: route.started_turn.clone(),
                    })?,
                ),
            )
            .await?;
            if receipt.accepted && (!receipt.duplicate || route.question_changed) {
                publish_changed(outbound_tx, &question).await;
            }
            // Keep active-turn event projection behind the answer receipt. Idle
            // turn notifications are buffered on this RPC's private channel and
            // begin forwarding only after the same response has been sent.
            drop(route.response_guard.take());
            if let Some(mut notifications) = route.deferred_notifications.take() {
                let forwarded = outbound_tx.clone();
                tokio::spawn(async move {
                    while let Some(message) = notifications.recv().await {
                        if send(&forwarded, message).await.is_err() {
                            break;
                        }
                    }
                });
            }
        }
        _ => unreachable!("async question supports() guards dispatch"),
    }
    Ok(DispatchControl::Continue)
}

fn owned_thread_engine(manager: &ThreadManager, thread_id: &str) -> Option<QueryEngine> {
    manager
        .owns(thread_id)
        .then(|| manager.engine(thread_id))
        .flatten()
}

pub(super) async fn publish_changed_by_id(
    state: &kcoder_state::AppState,
    outbound: &mpsc::Sender<Value>,
    thread_id: &str,
    question_id: &str,
) {
    let owner = state.inspection_lifecycle_identity();
    let Ok(questions) = state.list_async_questions(&owner, true) else {
        return;
    };
    if let Some(question) = questions
        .iter()
        .find(|question| question.thread_id == thread_id && question.question_id == question_id)
    {
        publish_changed(outbound, question).await;
    }
}

async fn reconcile_orphaned_deliveries(
    engine: &QueryEngine,
    thread_manager: &ThreadManager,
    outbound: &mpsc::Sender<Value>,
    thread_id: &str,
) -> Result<()> {
    let turn_state = thread_manager.turn_state(thread_id);
    kcoder_app_interactions::async_questions::reconcile_orphaned_deliveries(
        &engine.state,
        outbound,
        |question_id| {
            turn_state
                .as_ref()
                .is_some_and(|turn| has_local_async_question_delivery(turn, question_id))
        },
    )
    .await
}

#[derive(Default)]
struct AnswerRouteOutcome {
    question: Option<AsyncQuestionRecord>,
    question_changed: bool,
    started_turn: Option<kcoder_app_protocol::Turn>,
    deferred_notifications: Option<mpsc::Receiver<Value>>,
    response_guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}

struct AsyncQuestionRouteGuard {
    in_flight: Arc<StdMutex<HashSet<String>>>,
    question_id: String,
}

impl AsyncQuestionRouteGuard {
    fn new(in_flight: Arc<StdMutex<HashSet<String>>>, question_id: String) -> Self {
        in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(question_id.clone());
        Self {
            in_flight,
            question_id,
        }
    }
}

impl Drop for AsyncQuestionRouteGuard {
    fn drop(&mut self) {
        self.in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.question_id);
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "Answer routing retains the exact State owner and serialized ordinary-turn admission"
)]
async fn route_first_answer(
    params: &AsyncQuestionAnswerParams,
    question: AsyncQuestionRecord,
    duplicate: bool,
    thread_engine: &QueryEngine,
    engine: &mut QueryEngine,
    engine_factory: &AppServerEngineFactory,
    thread_manager: &mut ThreadManager,
    server_id: &str,
    sequence: &Arc<AtomicU64>,
    connection_state: &mut ConnectionState,
    attachment_directories: &mut AttachmentDirectories,
    next_interaction_id: &Arc<AtomicU64>,
    retained_authority: Option<retained_turn::Authority<'_>>,
) -> Result<AnswerRouteOutcome> {
    let Some(turn_state) = thread_manager.turn_state(&params.thread_id) else {
        return Ok(AnswerRouteOutcome::default());
    };
    let owner = thread_engine.state.inspection_lifecycle_identity();
    if duplicate
        && question.status
            == kcoder_types::async_user_questions::AsyncQuestionStatus::DeliveryUnknown
    {
        if !has_local_async_question_delivery(&turn_state, &question.question_id)
            && let Ok(Some(claim)) = thread_engine
                .state
                .get_async_question_delivery_claim(&owner, &question.question_id)
        {
            let _ = reconcile_persisted_claim(&thread_engine.state, &owner, &claim).await;
        }
        return Ok(answer_route_outcome(
            thread_engine,
            &owner,
            &question,
            None,
            None,
            None,
            true,
        ));
    }
    let claim_id = format!("async-question-claim-{}", uuid::Uuid::new_v4());
    let mut claim: Option<AsyncQuestionDeliveryClaim> = None;
    let mut _route_guard: Option<AsyncQuestionRouteGuard> = None;
    loop {
        let gate = Arc::clone(&turn_state.activity_gate).lock_owned().await;
        if !turn_state.accepting_turns.load(Ordering::SeqCst) {
            clear_async_question_steer(&turn_state, &question.question_id);
            return Ok(AnswerRouteOutcome::default());
        }
        if !thread_accepts_answer_delivery(thread_engine) {
            clear_async_question_steer(&turn_state, &question.question_id);
            return Ok(AnswerRouteOutcome::default());
        }
        let is_running = turn_state.running.load(Ordering::SeqCst);
        let (active_present, active_matches_source, active_is_cancelled) = {
            let active = turn_state.active_turn.lock().await;
            active.as_ref().map_or((false, false, false), |active| {
                (
                    true,
                    active.turn_id == question.source_turn_id,
                    active.cancel.is_cancelled(),
                )
            })
        };
        let lifecycle = question_turn_lifecycle(thread_engine, &question);
        if lifecycle.interrupted_after_question {
            // The task-wide stale write can fail transiently (for example, while
            // another process holds the ledger lock). The durable attempt record
            // still proves that a later turn was explicitly interrupted, so do
            // not route an older answer into a fresh turn. Retry the stale write
            // here when possible so the UI also gets the durable terminal state.
            let stale_questions = match thread_engine
                .state
                .mark_async_questions_stale_for_task(&owner)
            {
                Ok(questions) => questions,
                Err(_) => {
                    tracing::warn!(
                        code = "ASYNC_QUESTION_STALE_PERSISTENCE_UNCERTAIN",
                        "interrupted task questions could not be marked stale during answer routing"
                    );
                    Vec::new()
                }
            };
            clear_async_question_steer(&turn_state, &question.question_id);
            drop(gate);
            return Ok(answer_route_outcome(
                thread_engine,
                &owner,
                &question,
                None,
                None,
                None,
                stale_questions
                    .iter()
                    .any(|stale| stale.question_id == question.question_id),
            ));
        }
        let source_completed = lifecycle.source_completed;
        if is_running
            && (active_is_cancelled
                || !(active_matches_source || source_completed)
                || (!active_present && lifecycle.unsettled_after_question))
        {
            // A live source may receive its answer directly. An earlier
            // naturally completed source may steer the current same-thread
            // turn; interrupted/failed sources never enter a newer turn.
            clear_async_question_steer(&turn_state, &question.question_id);
            return Ok(AnswerRouteOutcome::default());
        }
        if claim.is_none() {
            if !is_running && !source_allows_idle_delivery(thread_engine, &question) {
                clear_async_question_steer(&turn_state, &question.question_id);
                return Ok(AnswerRouteOutcome::default());
            }
            let existing_claim = if duplicate {
                match thread_engine
                    .state
                    .get_async_question_delivery_claim(&owner, &question.question_id)
                {
                    Ok(claim) => claim,
                    Err(_) => {
                        clear_async_question_steer(&turn_state, &question.question_id);
                        return Ok(AnswerRouteOutcome::default());
                    }
                }
            } else {
                None
            };
            if let Some(existing_claim) = existing_claim {
                if !has_local_async_question_delivery(&turn_state, &question.question_id) {
                    let _ =
                        reconcile_persisted_claim(&thread_engine.state, &owner, &existing_claim)
                            .await;
                }
                return Ok(answer_route_outcome(
                    thread_engine,
                    &owner,
                    &question,
                    None,
                    None,
                    None,
                    true,
                ));
            }

            claim = claim_delivery(
                &thread_engine.state,
                &owner,
                &question.question_id,
                &claim_id,
                || has_local_async_question_delivery(&turn_state, &question.question_id),
            )
            .await;
            if claim.is_none() {
                if let Ok(Some(existing_claim)) = thread_engine
                    .state
                    .get_async_question_delivery_claim(&owner, &question.question_id)
                    && !has_local_async_question_delivery(&turn_state, &question.question_id)
                {
                    let _ =
                        reconcile_persisted_claim(&thread_engine.state, &owner, &existing_claim)
                            .await;
                    return Ok(answer_route_outcome(
                        thread_engine,
                        &owner,
                        &question,
                        None,
                        None,
                        None,
                        true,
                    ));
                }
                clear_async_question_steer(&turn_state, &question.question_id);
                return Ok(AnswerRouteOutcome::default());
            }
            _route_guard = Some(AsyncQuestionRouteGuard::new(
                Arc::clone(&turn_state.async_question_routes_in_flight),
                question.question_id.clone(),
            ));
        }
        let current_claim = claim
            .as_ref()
            .expect("claim is initialized before delivery admission");
        let existing_receipt_id = turn_state
            .async_question_steers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find_map(|(receipt_id, question_id)| {
                (question_id == &current_claim.question_id).then_some(*receipt_id)
            });
        let Some(receipt_id) =
            existing_receipt_id.or_else(|| allocate_receipt_id(next_interaction_id))
        else {
            let _ = thread_engine.state.mark_async_question_delivery_unknown(
                &owner,
                current_claim,
                "delivery identity allocation failed",
            );
            clear_async_question_steer(&turn_state, &question.question_id);
            return Ok(answer_route_outcome(
                thread_engine,
                &owner,
                &question,
                None,
                None,
                None,
                true,
            ));
        };
        // Register before the next await so concurrent list/recovery sees an
        // in-flight claim and cannot fence it while Engine is admitting input.
        turn_state
            .async_question_steers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(receipt_id, current_claim.question_id.clone());

        if is_running {
            let response_guard = Arc::clone(&turn_state.async_question_response_gate)
                .lock_owned()
                .await;
            match thread_engine.try_enqueue_async_question_delivery(
                &owner,
                receipt_id,
                current_claim,
            ) {
                kcoder_engine::GuardedTurnSteer::Queued => {
                    let routed_question = current_question(&thread_engine.state, &owner, &question);
                    return Ok(AnswerRouteOutcome {
                        question_changed: routed_question != question,
                        question: Some(routed_question),
                        response_guard: Some(response_guard),
                        ..AnswerRouteOutcome::default()
                    });
                }
                kcoder_engine::GuardedTurnSteer::NoActiveTurn => {
                    drop(response_guard);
                    drop(gate);
                    if tokio::time::timeout(Duration::from_secs(1), wait_until_idle(&turn_state))
                        .await
                        .is_err()
                    {
                        let _ = thread_engine.state.mark_async_question_delivery_unknown(
                            &owner,
                            current_claim,
                            "active turn did not reach a known idle boundary",
                        );
                        clear_async_question_steer(&turn_state, &question.question_id);
                        return Ok(answer_route_outcome(
                            thread_engine,
                            &owner,
                            &question,
                            None,
                            None,
                            None,
                            true,
                        ));
                    }
                    // NoActiveTurn proves that this attempt was not enqueued. The
                    // same fresh claim may enter normal idle turn/start admission.
                    continue;
                }
                kcoder_engine::GuardedTurnSteer::Busy
                | kcoder_engine::GuardedTurnSteer::OwnerChanged
                | kcoder_engine::GuardedTurnSteer::QueueFull { .. } => {
                    clear_async_question_steer(&turn_state, &question.question_id);
                    drop(response_guard);
                    let _ = thread_engine.state.mark_async_question_delivery_failed(
                        &owner,
                        current_claim,
                        "active turn could not accept the saved answer",
                    );
                    return Ok(answer_route_outcome(
                        thread_engine,
                        &owner,
                        &question,
                        None,
                        None,
                        None,
                        true,
                    ));
                }
            }
        }

        // Keep the execution gate from the idle/source checks through the
        // ordinary turn/start admission. Interrupt and competing turn starts use
        // the same gate, so neither can slip into the check/admit gap.
        if !source_allows_idle_delivery(thread_engine, &question) {
            clear_async_question_steer(&turn_state, &question.question_id);
            return Ok(answer_route_outcome(
                thread_engine,
                &owner,
                &question,
                None,
                None,
                None,
                true,
            ));
        }
        let claim = claim.take().expect("idle delivery has a persisted claim");
        let prompt = match async_question_message_text(&claim.message) {
            Ok(prompt) => prompt,
            Err(_) => {
                let _ = thread_engine.state.mark_async_question_delivery_failed(
                    &owner,
                    &claim,
                    "saved answer could not be converted to user input",
                );
                clear_async_question_steer(&turn_state, &question.question_id);
                return Ok(answer_route_outcome(
                    thread_engine,
                    &owner,
                    &question,
                    None,
                    None,
                    None,
                    true,
                ));
            }
        };
        let turn_params = serde_json::json!({
            "threadId": params.thread_id,
            "input": [{"type": "text", "text": prompt}],
            "asyncUserQuestions": params
                .async_user_questions
                .unwrap_or(connection_state.async_user_questions_v1),
        });
        let (internal_tx, mut internal_rx) = mpsc::channel(1024);
        let dispatch_result = turn_requests::dispatch_async_question_claim(
            json!({"asyncQuestion": params.submission_id}),
            turn_params,
            engine,
            engine_factory,
            &internal_tx,
            thread_manager,
            server_id,
            sequence,
            connection_state,
            attachment_directories,
            retained_authority,
            claim.clone(),
            receipt_id,
            gate,
        )
        .await;
        let internal_response =
            admission::receive_admission_receipt(dispatch_result, internal_tx, &mut internal_rx)
                .await;
        if internal_response.is_none() {
            let _ = thread_engine.state.mark_async_question_delivery_unknown(
                &owner,
                &claim,
                "turn admission receipt is uncertain",
            );
            clear_async_question_steer(&turn_state, &question.question_id);
            return Ok(answer_route_outcome(
                thread_engine,
                &owner,
                &question,
                None,
                None,
                None,
                true,
            ));
        }
        let internal_response = internal_response.expect("checked above");
        let started_turn = internal_response
            .get("result")
            .and_then(|result| result.get("turn"))
            .cloned()
            .and_then(|turn| kcoder_app_rpc_codec::decode::<kcoder_app_protocol::Turn>(turn).ok())
            .filter(|turn| turn.status == kcoder_app_protocol::TurnStatus::Running);
        if started_turn.is_none() {
            clear_async_question_steer(&turn_state, &question.question_id);
            let rejection_reason = safe_turn_start_rejection(&internal_response);
            let _ = thread_engine.state.mark_async_question_delivery_failed(
                &owner,
                &claim,
                &rejection_reason,
            );
            return Ok(answer_route_outcome(
                thread_engine,
                &owner,
                &question,
                None,
                None,
                None,
                true,
            ));
        }
        return Ok(answer_route_outcome(
            thread_engine,
            &owner,
            &question,
            started_turn,
            Some(internal_rx),
            None,
            true,
        ));
    }
}

fn answer_route_outcome(
    engine: &QueryEngine,
    owner: &kcoder_state::AppStateLifecycleIdentity,
    original: &AsyncQuestionRecord,
    started_turn: Option<kcoder_app_protocol::Turn>,
    deferred_notifications: Option<mpsc::Receiver<Value>>,
    response_guard: Option<tokio::sync::OwnedMutexGuard<()>>,
    question_changed: bool,
) -> AnswerRouteOutcome {
    let question = current_question(&engine.state, owner, original);
    AnswerRouteOutcome {
        question_changed: question_changed && question != *original,
        question: Some(question),
        started_turn,
        deferred_notifications,
        response_guard,
    }
}

fn clear_async_question_steer(turn_state: &ResidentTurnState, question_id: &str) {
    turn_state
        .async_question_steers
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retain(|_, pending_question_id| pending_question_id != question_id);
}

fn has_local_async_question_delivery(turn_state: &ResidentTurnState, question_id: &str) -> bool {
    turn_state
        .async_question_routes_in_flight
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(question_id)
        || turn_state
            .async_question_steers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .any(|pending_question_id| pending_question_id == question_id)
}

fn source_allows_idle_delivery(engine: &QueryEngine, question: &AsyncQuestionRecord) -> bool {
    if !thread_accepts_answer_delivery(engine) {
        return false;
    }
    let lifecycle = question_turn_lifecycle(engine, question);
    lifecycle.source_completed
        && !lifecycle.interrupted_after_question
        && !lifecycle.unsettled_after_question
}

fn question_turn_lifecycle(
    engine: &QueryEngine,
    question: &AsyncQuestionRecord,
) -> QuestionTurnLifecycle {
    turn_attempts::records(engine, &question.thread_id).map_or_else(
        |_| QuestionTurnLifecycle::default(),
        |records| classify_question_turns(&records, question),
    )
}

fn thread_accepts_answer_delivery(engine: &QueryEngine) -> bool {
    thread_snapshot_with_metadata_policy(engine, false, true)
        .is_ok_and(|thread| thread.get("archivedAt").and_then(Value::as_str).is_none())
}

async fn wait_until_idle(turn_state: &ResidentTurnState) {
    loop {
        if !turn_state.running.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn allocate_receipt_id(next_id: &AtomicU64) -> Option<u64> {
    next_id
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            current.checked_add(1)
        })
        .ok()
}
