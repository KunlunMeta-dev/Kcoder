//! Async question delivery recovery, notifications and persisted turn classification.

use anyhow::Result;
use kcoder_app_protocol::AsyncQuestionChangedNotification;
use kcoder_host_transport::protocol_io::{notification, send};
use kcoder_state::{AppState, AppStateLifecycleIdentity, turn_attempt_store::TurnAttemptRecord};
use kcoder_types::async_user_questions::{AsyncQuestionDeliveryClaim, AsyncQuestionRecord};
use serde_json::Value;
use std::{collections::HashSet, time::Duration};
use tokio::sync::mpsc;

pub async fn publish_changed(outbound: &mpsc::Sender<Value>, question: &AsyncQuestionRecord) {
    let params = match serde_json::to_value(AsyncQuestionChangedNotification {
        thread_id: question.thread_id.clone(),
        question: question.clone(),
    }) {
        Ok(params) => params,
        Err(_) => return,
    };
    let _ = send(
        outbound,
        notification(kcoder_app_protocol::method::ASYNC_QUESTION_CHANGED, params),
    )
    .await;
}

pub async fn publish_changed_by_id(
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

pub async fn reconcile_orphaned_deliveries(
    state: &AppState,
    outbound: &mpsc::Sender<Value>,
    has_local_delivery: impl Fn(&str) -> bool,
) -> Result<()> {
    use kcoder_types::async_user_questions::AsyncQuestionStatus;

    let owner = state.inspection_lifecycle_identity();
    let records = state.list_async_questions(&owner, true)?;

    for record in records {
        if has_local_delivery(&record.question_id) {
            continue;
        }
        if !matches!(
            record.status,
            AsyncQuestionStatus::Queued | AsyncQuestionStatus::DeliveryUnknown
        ) {
            continue;
        }
        let Some(claim) = state.get_async_question_delivery_claim(&owner, &record.question_id)?
        else {
            continue;
        };
        let question = reconcile_persisted_claim(state, &owner, &claim).await?;
        // A read may reconcile delivery, but an unchanged unknown receipt must
        // not trigger another list request through the client's changed event.
        if question.revision != record.revision {
            publish_changed(outbound, &question).await;
        }
    }
    Ok(())
}

pub async fn reconcile_persisted_claim(
    state: &AppState,
    owner: &kcoder_state::AppStateLifecycleIdentity,
    claim: &AsyncQuestionDeliveryClaim,
) -> Result<AsyncQuestionRecord> {
    let receipt = tokio::time::timeout(
        Duration::from_secs(2),
        state.find_committed_user_input_identified(owner, &claim.message_id, &claim.message),
    )
    .await;
    match receipt {
        Ok(Ok(Some(committed)))
            if committed.outcome() == kcoder_state::UserInputCommit::Durable =>
        {
            Ok(state.reconcile_async_question_context_applied(
                owner,
                &claim.question_id,
                &claim.submission_id,
                &committed,
            )?)
        }
        _ => Ok(state.mark_async_question_delivery_unknown(
            owner,
            claim,
            "a durable history receipt could not be verified during delivery recovery",
        )?),
    }
}

pub async fn claim_delivery(
    state: &AppState,
    owner: &AppStateLifecycleIdentity,
    question_id: &str,
    claim_id: &str,
    has_local_delivery: impl FnOnce() -> bool,
) -> Option<AsyncQuestionDeliveryClaim> {
    match state.claim_async_question_delivery(owner, question_id, claim_id) {
        Ok(Some(claim)) => Some(claim),
        Ok(None) => None,
        Err(_) => {
            // A failed claim receipt is ambiguous. Only retry after
            // State authoritatively says no claim was persisted.
            match state.get_async_question_delivery_claim(owner, question_id) {
                Ok(Some(existing_claim)) => {
                    if !has_local_delivery() {
                        let _ = reconcile_persisted_claim(state, owner, &existing_claim).await;
                    }
                    None
                }
                Ok(None) => {
                    let retry_claim_id = format!("async-question-claim-{}", uuid::Uuid::new_v4());
                    state
                        .claim_async_question_delivery(owner, question_id, &retry_claim_id)
                        .ok()
                        .flatten()
                }
                Err(_) => None,
            }
        }
    }
}

pub fn safe_turn_start_rejection(response: &Value) -> String {
    let Some(error) = response.get("error") else {
        return "ordinary turn/start did not return a running receipt; the saved answer is preserved for review".into();
    };
    let Some(code) = error.get("code").and_then(Value::as_i64) else {
        return "ordinary turn/start returned an invalid rejection receipt; the saved answer is preserved for review".into();
    };
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let reason = match code {
        kcoder_app_protocol::PROVIDER_AUTHENTICATION_REQUIRED => {
            "the selected model credentials are unavailable"
        }
        -32602 if message.contains("Selected model credential is unavailable") => {
            "the selected model credentials are unavailable"
        }
        -32602
            if message.contains("Selected model is not configured")
                || message.contains("not configured for provider")
                || message.contains("Selected model was removed") =>
        {
            "the selected model is unavailable in the active provider configuration"
        }
        -32602 if message.starts_with("invalid permissionMode") => {
            "the requested permission mode is invalid"
        }
        -32602 if message == "AGENT_DEFINITION_UNAVAILABLE_OR_READ_ONLY" => {
            "the task agent definition is unavailable or read-only"
        }
        -32602 => "the turn input, selected model, or permission configuration was rejected",
        -32003 => "another turn is already running",
        -32022 => "thread source, binding, or turn admission is unavailable",
        -32024 => "the thread is not resumed or its session lease is unavailable",
        -32025 => "the request targets a different active thread",
        -32046 => "the failed-turn continuation was rejected",
        -32047 => "the turn identity conflicts with an existing attempt",
        -32054 => "plugin credential refresh failed",
        -32059 => "automation turn admission failed",
        -32086 => "the remote receiver denied the turn override",
        -32603 => "internal turn admission failed",
        _ => "turn/start rejected the request for an unclassified reason",
    };
    format!(
        "ordinary turn/start rejected (RPC {code}): {reason}; the saved answer is preserved for review"
    )
}

pub fn current_question(
    state: &AppState,
    owner: &kcoder_state::AppStateLifecycleIdentity,
    fallback: &AsyncQuestionRecord,
) -> AsyncQuestionRecord {
    state
        .list_async_questions(owner, true)
        .ok()
        .and_then(|questions| {
            questions
                .into_iter()
                .find(|question| question.question_id == fallback.question_id)
        })
        .unwrap_or_else(|| fallback.clone())
}

#[derive(Default)]
pub struct QuestionTurnLifecycle {
    pub source_completed: bool,
    pub interrupted_after_question: bool,
    pub unsettled_after_question: bool,
}

pub fn classify_question_turns(
    records: &[TurnAttemptRecord],
    question: &AsyncQuestionRecord,
) -> QuestionTurnLifecycle {
    let source_attempts = records
        .iter()
        .filter(|record| record.identity.turn_id == question.source_turn_id)
        .collect::<Vec<_>>();
    let source_parents = source_attempts
        .iter()
        .filter_map(|record| record.parent_attempt_id.as_deref())
        .collect::<HashSet<_>>();
    let source_tips = source_attempts
        .iter()
        .filter(|record| !source_parents.contains(record.identity.attempt_id.as_str()))
        .collect::<Vec<_>>();
    let source_completed = source_tips.len() == 1 && source_tips[0].status.as_str() == "completed";
    let interrupted_after_question = records.iter().any(|record| {
        record.status.as_str() == "interrupted"
            && record
                .completion
                .as_ref()
                .map_or(record.accepted_at_ms, |completion| {
                    completion.finished_at_ms
                })
                >= question.created_at_ms
    });
    let unsettled_after_question = records.iter().any(|record| {
        turn_attempt_is_unsettled_after_question(
            record.accepted_at_ms,
            record.status.is_terminal(),
            &record.identity.turn_id,
            &question.source_turn_id,
            question.created_at_ms,
        )
    });

    QuestionTurnLifecycle {
        source_completed,
        interrupted_after_question,
        unsettled_after_question,
    }
}

fn turn_attempt_is_unsettled_after_question(
    accepted_at_ms: u64,
    terminal: bool,
    attempt_turn_id: &str,
    source_turn_id: &str,
    question_created_at_ms: u64,
) -> bool {
    let started_after_question = accepted_at_ms > question_created_at_ms
        || (accepted_at_ms == question_created_at_ms && attempt_turn_id != source_turn_id);
    started_after_question && !terminal
}

pub fn async_question_message_text(message: &kcoder_types::Message) -> Result<String> {
    let kcoder_types::Message::User { content, .. } = message else {
        anyhow::bail!("async answer message must be user input");
    };
    let mut text = String::new();
    for block in content {
        let kcoder_types::ContentBlock::Text { text: block_text } = block else {
            anyhow::bail!("async answer message must be plain text");
        };
        text.push_str(block_text);
    }
    anyhow::ensure!(!text.trim().is_empty(), "async answer message is empty");
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::{safe_turn_start_rejection, turn_attempt_is_unsettled_after_question};
    use serde_json::json;

    #[test]
    fn only_unsettled_attempts_started_after_the_question_block_idle_delivery() {
        assert!(turn_attempt_is_unsettled_after_question(
            101, false, "turn-b", "turn-a", 100
        ));
        assert!(!turn_attempt_is_unsettled_after_question(
            101, true, "turn-b", "turn-a", 100
        ));
        assert!(turn_attempt_is_unsettled_after_question(
            100, false, "turn-b", "turn-a", 100
        ));
        assert!(!turn_attempt_is_unsettled_after_question(
            100, false, "turn-a", "turn-a", 100
        ));
    }

    #[test]
    fn reports_safe_model_and_plugin_turn_start_reasons() {
        let model = safe_turn_start_rejection(&json!({
            "error": {
                "code": -32602,
                "message": "Selected model credential is unavailable"
            }
        }));
        assert!(model.contains("RPC -32602"));
        assert!(model.contains("selected model credentials are unavailable"));

        let plugin = safe_turn_start_rejection(&json!({
            "error": {"code": -32054, "message": "Plugin activation refresh failed: secret-value"}
        }));
        assert!(plugin.contains("plugin credential refresh failed"));
        assert!(!plugin.contains("secret-value"));
    }

    #[test]
    fn reports_provider_authentication_rejection_without_echoing_private_details() {
        let reason = safe_turn_start_rejection(&json!({
            "error": {
                "code": kcoder_app_protocol::PROVIDER_AUTHENTICATION_REQUIRED,
                "message": "Provider credentials are required before starting this turn: private-detail"
            }
        }));
        assert!(reason.contains("RPC -32063"));
        assert!(reason.contains("selected model credentials are unavailable"));
        assert!(reason.contains("saved answer is preserved for review"));
        assert!(!reason.contains("private-detail"));
    }

    #[test]
    fn unknown_turn_start_errors_do_not_echo_untrusted_messages() {
        let reason = safe_turn_start_rejection(&json!({
            "error": {"code": -32123, "message": "answer text and api_token=private"}
        }));
        assert!(reason.contains("RPC -32123"));
        assert!(reason.contains("unclassified reason"));
        assert!(!reason.contains("answer text"));
        assert!(!reason.contains("api_token"));
    }
}
