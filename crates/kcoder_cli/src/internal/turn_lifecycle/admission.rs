//! Durable preflight before starting a new foreground attempt.

use crate::{failed_turn, turn_admissions, turn_artifacts, turn_attempts};
use anyhow::{Context, Result, ensure};
use kcoder_app_interactions::async_questions::async_question_message_text;
use kcoder_app_protocol::{
    RETENTION_ERROR_AUTHORITY, TurnExecutionMode, TurnStartParams, UserInput,
};
use kcoder_cli_storage::private_files::hex_sha256;
use kcoder_config::PermissionMode;
use kcoder_engine::QueryEngine;
use kcoder_state::HistoryAppendScope;
use kcoder_types::async_user_questions::AsyncQuestionDeliveryClaim;
use kcoder_types::{
    ClientPresentationV1, Message, ModelSelectionMode, RetryModelConfiguration, TurnAttemptIdentity,
};
use serde_json::{Value, json};

pub enum TurnAdmission<'a> {
    Start {
        latest_turn: usize,
        retry_operation_id: Option<&'a str>,
    },
    Replay(Value),
}

pub struct AdmissionRejection {
    pub code: i64,
    pub message: String,
    pub wake_followups: bool,
}

impl AdmissionRejection {
    fn waking(code: i64, message: impl ToString) -> Self {
        Self {
            code,
            message: message.to_string(),
            wake_followups: true,
        }
    }
}

pub struct StartGates {
    pub async_questions_enabled: bool,
    pub async_answer_claimed: bool,
    pub retention_verified: bool,
    pub desktop_session_authorization_enabled: bool,
}

pub struct StartOptions {
    pub permission_mode: Option<PermissionMode>,
    #[cfg(windows)]
    pub desktop_requested: bool,
    #[cfg(windows)]
    pub desktop_session_continuation: bool,
    #[cfg(windows)]
    pub desktop_conversation_authorization: bool,
}

pub fn validate_start(
    params: &TurnStartParams,
    gates: StartGates,
    receiver_rejects: &dyn Fn(&TurnStartParams) -> bool,
) -> Result<StartOptions, AdmissionRejection> {
    let reject = |code, message: String| AdmissionRejection {
        code,
        message,
        wake_followups: false,
    };
    if (gates.async_answer_claimed || params.async_user_questions == Some(true))
        && !gates.async_questions_enabled
    {
        return Err(reject(
            -32602,
            "asyncUserQuestionsV1 negotiation is required".into(),
        ));
    }
    if receiver_rejects(params) {
        return Err(reject(
            -32086,
            "REMOTE_RECEIVER_TURN_OVERRIDE_DENIED".into(),
        ));
    }
    if params.retention.is_some() && !gates.retention_verified {
        return Err(reject(
            RETENTION_ERROR_AUTHORITY,
            "Verified retained-turn authority is required".into(),
        ));
    }
    let desktop_authorization = params
        .computer_use
        .as_ref()
        .and_then(|authorization| authorization.use_session_authorization);
    if desktop_authorization.is_some() && !gates.desktop_session_authorization_enabled {
        return Err(reject(
            -32602,
            "computerUseSessionAuthorizationV1 negotiation is required".into(),
        ));
    }
    let desktop_requested = params.computer_use.is_some();
    if desktop_requested
        && (!cfg!(windows)
            || !params
                .computer_use
                .as_ref()
                .is_some_and(|permission| permission.approved))
    {
        return Err(reject(
            -32602,
            "Computer Use requires Windows and explicit desktop approval".into(),
        ));
    }
    params
        .validate_model_selection()
        .map_err(|error| reject(-32602, error.into()))?;
    let permission_mode = params
        .permission_mode
        .as_ref()
        .map(|mode| serde_json::from_value::<PermissionMode>(json!(mode)))
        .transpose()
        .map_err(|error| reject(-32602, format!("invalid permissionMode: {error}")))?;
    Ok(StartOptions {
        permission_mode,
        #[cfg(windows)]
        desktop_requested,
        #[cfg(windows)]
        desktop_session_continuation: desktop_authorization == Some(true),
        #[cfg(windows)]
        desktop_conversation_authorization: desktop_authorization == Some(false),
    })
}

fn async_question_wire_prompt(params: &Value) -> Option<&str> {
    if params.get("prompt").is_some() {
        return None;
    }
    let input = params.get("input")?.as_array()?;
    if input.len() != 1 {
        return None;
    }
    let item = input.first()?;
    if item.get("type")?.as_str()? != "text" {
        return None;
    }
    item.get("text")?.as_str()
}

pub fn prompt_from_params(params: &Value) -> Option<String> {
    if let Some(prompt) = params.get("prompt").and_then(Value::as_str) {
        return (!prompt.trim().is_empty()).then(|| prompt.to_string());
    }
    let text = params
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    (!text.is_empty()).then_some(text)
}

pub fn prepare_start_input(
    engine: &QueryEngine,
    params: &TurnStartParams,
    wire: &Value,
    continuing: bool,
    claim: Option<&AsyncQuestionDeliveryClaim>,
) -> Result<(String, Option<Message>, TurnExecutionMode)> {
    let (prompt, message) = if let Some(claim) = claim {
        let prompt = match async_question_message_text(&claim.message) {
            Ok(prompt) if async_question_wire_prompt(wire) == Some(prompt.as_str()) => prompt,
            _ => anyhow::bail!("async question delivery input changed"),
        };
        (prompt, Some(claim.message.clone()))
    } else if continuing {
        (String::new(), None)
    } else {
        (
            prompt_from_params(wire).context("turn/start requires non-empty prompt")?,
            None,
        )
    };
    let mode = params.turn_mode.unwrap_or_default();
    if mode == TurnExecutionMode::MoaPlan {
        engine.moa_plan_preflight()?;
        ensure!(
            params
                .input
                .iter()
                .all(|input| matches!(input, UserInput::Text { .. })),
            "MoA planning requires a text planning request"
        );
        ensure!(
            !prompt.contains("<kcoder_attachments "),
            "MoA planning requires a text planning request"
        );
    }
    Ok((prompt, message, mode))
}

pub enum ForegroundPreparationError {
    Model(anyhow::Error),
    Persistence(anyhow::Error),
}

/// Save the original execution inputs before an attempt can be accepted.
pub fn prepare_foreground(
    engine: &QueryEngine,
    thread_id: &str,
    identity: &TurnAttemptIdentity,
    continuing: bool,
    retry_operation_id: Option<&str>,
    client_message_id: Option<&str>,
) -> Result<(), ForegroundPreparationError> {
    turn_attempts::save_model_snapshot(engine, identity)
        .map_err(ForegroundPreparationError::Model)?;
    if let Some(snapshot) = engine.agent_turn_configuration() {
        turn_attempts::store(engine, thread_id)
            .and_then(|store| {
                store.save_agent_snapshot_with_resources(
                    identity,
                    snapshot,
                    engine.agent_resource_snapshot(),
                )
            })
            .map_err(ForegroundPreparationError::Persistence)?;
    }
    // Only validated requests may acquire a continuation identity.
    if continuing {
        turn_artifacts::input_context_hash(&engine.state.messages())
            .and_then(|hash| {
                turn_artifacts::save_turn_continuation_receipt(
                    engine,
                    thread_id,
                    &identity.turn_id,
                    &hash,
                    retry_operation_id,
                )
            })
            .map_err(ForegroundPreparationError::Persistence)?;
    }
    turn_artifacts::clear_turn_outcome(engine, thread_id, &identity.turn_id)
        .map_err(ForegroundPreparationError::Persistence)?;
    if !continuing {
        turn_artifacts::save_turn_client_message_id(
            engine,
            thread_id,
            &identity.turn_id,
            client_message_id,
        )
        .map_err(ForegroundPreparationError::Persistence)?;
    }
    Ok(())
}

pub fn materialize_foreground_input(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
    prompt: &str,
    staged: &mut kcoder_attachments::AttachmentDirectories,
) -> Result<(String, Message)> {
    let root = engine
        .session_storage_dir_for(thread_id)
        .join("attachments");
    let prompt = kcoder_attachments::materialize_turn_attachments(
        &root, thread_id, turn_id, prompt, staged,
    )?;
    let message = kcoder_attachments::model_message_from_materialized_prompt(&prompt)?
        .unwrap_or_else(|| Message::user_text(prompt.clone()));
    Ok((prompt, message))
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep the accepted attempt, input authority and retry identity explicit"
)]
pub fn begin_foreground(
    engine: &QueryEngine,
    identity: &TurnAttemptIdentity,
    params: &TurnStartParams,
    model_message: &Message,
    retained: Option<&crate::retained_turn::Prepared<'_>>,
    presentation: Option<&ClientPresentationV1>,
    latest_turn: usize,
    continuing: bool,
    retry_operation_id: Option<&str>,
) -> Result<HistoryAppendScope> {
    if !continuing && retained.is_none() {
        turn_admissions::accept(engine, &identity.thread_id, latest_turn.saturating_add(1))?;
    }
    let mut inputs = engine.state.messages();
    if !continuing {
        inputs.push(model_message.clone());
    }
    let bytes = serde_json::to_vec(&inputs).context("failed to hash attempt context")?;
    if let Some(prepared) = retained {
        turn_attempts::begin_with_retained_input(
            engine,
            identity,
            false,
            hex_sha256(&bytes),
            params,
            prepared.input.clone(),
        )?;
    } else {
        turn_attempts::begin(
            &engine
                .clone()
                .with_client_presentation(presentation.cloned()),
            identity,
            continuing,
            retry_operation_id,
            hex_sha256(&bytes),
            turn_attempts::request_fingerprint(params)?,
        )?;
    }
    engine.state.history_attempt_scope(identity.clone())
}

pub fn inspect<'a>(
    engine: &QueryEngine,
    params: &'a TurnStartParams,
    legacy_turn_count: usize,
) -> Result<TurnAdmission<'a>, AdmissionRejection> {
    let latest_turn = turn_admissions::latest(engine, &params.thread_id, legacy_turn_count)
        .map_err(|error| AdmissionRejection::waking(-32603, error))?;
    if params.retry_from_attempt_id.is_some() && params.retry_from_turn_id.is_none() {
        return Err(AdmissionRejection::waking(
            -32602,
            "retryFromAttemptId requires retryFromTurnId",
        ));
    }
    if let Some(failed_turn_id) = params.retry_from_turn_id.as_deref() {
        let replayed = if let Some(attempt) = params.retry_from_attempt_id.as_deref() {
            turn_attempts::request_fingerprint(params).and_then(|fingerprint| {
                turn_attempts::retry_admission(
                    engine,
                    &params.thread_id,
                    failed_turn_id,
                    attempt,
                    params.retry_operation_id.as_deref(),
                    &fingerprint,
                    params.retry_model_configuration != Some(RetryModelConfiguration::Current)
                        && params.model.is_none()
                        && params.reasoning_effort.is_none()
                        && params.proxy_url.is_none()
                        && params.service_tier.is_none(),
                )
            })
        } else {
            turn_artifacts::replay_accepted_continuation(
                engine,
                &params.thread_id,
                failed_turn_id,
                latest_turn,
            )
        }
        .map_err(|error| AdmissionRejection::waking(-32046, error))?;
        if let Some(replayed) = replayed {
            return Ok(TurnAdmission::Replay(replayed));
        }
    }
    let retry_operation_id = params
        .retry_operation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(failed_turn_id) = params.retry_from_turn_id.as_deref() {
        if let Some(operation) = retry_operation_id
            && let Some(committed) = turn_artifacts::turn_continuation_for_operation(
                engine,
                &params.thread_id,
                operation,
            )
            && committed.turn_id != failed_turn_id
        {
            return Err(AdmissionRejection::waking(
                -32047,
                format!(
                    "retry operation {operation} was already committed as {}; query that attempt instead",
                    committed.turn_id
                ),
            ));
        }
        let validation = (|| -> Result<()> {
            ensure!(
                params.input.is_empty()
                    && params.client_message_id.is_none()
                    && params.turn_mode.is_none(),
                "Continuation cannot submit another user input or execution mode"
            );
            failed_turn::validate(engine, failed_turn_id, latest_turn)
        })();
        if let Err(error) = validation {
            return Err(AdmissionRejection {
                code: -32046,
                message: error.to_string(),
                wake_followups: false,
            });
        }
    }
    if params.retry_from_turn_id.is_none()
        && let Some(operation) = retry_operation_id
    {
        return Err(AdmissionRejection::waking(
            -32602,
            format!("retry operation {operation} requires a failed turn to continue"),
        ));
    }
    if params.retry_from_turn_id.is_none()
        && params.retention.is_none()
        && let Some(client_message_id) = params
            .client_message_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        && !params.resubmit.unwrap_or(false)
    {
        let committed = turn_artifacts::load_turn_client_message_ids(engine, &params.thread_id);
        if let Some(existing_turn) =
            turn_artifacts::committed_turn_for_client_message(&committed, client_message_id)
        {
            return Err(AdmissionRejection::waking(
                -32047,
                format!(
                    "client message {client_message_id} was already committed as {existing_turn}; resubmit to start another attempt"
                ),
            ));
        }
    }
    Ok(TurnAdmission::Start {
        latest_turn,
        retry_operation_id,
    })
}

pub fn prepare_model(engine: &QueryEngine, params: &TurnStartParams) -> Result<()> {
    if params.retry_from_turn_id.is_some() {
        turn_attempts::prepare_continuation_model(engine, params)
    } else if params.model_selection_mode == Some(ModelSelectionMode::FollowTargetDefault) {
        engine.follow_target_default_model()
    } else {
        engine.prepare_client_model_for_turn(params.model.as_deref(), false)
    }
}

#[cfg(test)]
mod start_validation_tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn async_question_negotiation_precedes_receiver_and_permission_checks() {
        let params: TurnStartParams = serde_json::from_value(json!({
            "threadId": "thread",
            "input": [{"type": "text", "text": "hello"}],
            "asyncUserQuestions": true,
            "permissionMode": "unsupported",
        }))
        .unwrap();
        let calls = Cell::new(0);
        let receiver_rejects = |_: &TurnStartParams| {
            calls.set(calls.get() + 1);
            true
        };
        let mut gates = StartGates {
            async_questions_enabled: false,
            async_answer_claimed: false,
            retention_verified: false,
            desktop_session_authorization_enabled: false,
        };
        let rejection = validate_start(&params, gates, &receiver_rejects)
            .err()
            .expect("negotiation is required");
        assert_eq!(rejection.code, -32602);
        assert_eq!(
            rejection.message,
            "asyncUserQuestionsV1 negotiation is required"
        );
        assert_eq!(calls.get(), 0);

        gates = StartGates {
            async_questions_enabled: true,
            async_answer_claimed: false,
            retention_verified: false,
            desktop_session_authorization_enabled: false,
        };
        let rejection = validate_start(&params, gates, &receiver_rejects)
            .err()
            .expect("the original receiver refused the request");
        assert_eq!(rejection.code, -32086);
        assert_eq!(calls.get(), 1);
    }
}
