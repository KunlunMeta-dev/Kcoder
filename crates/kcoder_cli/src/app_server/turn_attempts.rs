//! Persistent attempt lifecycle. Visible partial output is never fed back to the model.
use crate::recent_error;
use anyhow::{Context, Result, ensure};
use kcoder_app_events::now_millis;
use kcoder_cli_storage::{private_files::hex_sha256, transcript_artifact_journal};
use kcoder_engine::{EngineEvent, QueryEngine};
use kcoder_state::turn_attempt_store::{
    TurnAttemptBeginOutcome, TurnAttemptCompletion, TurnAttemptRecord, TurnAttemptStore,
};
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus, TurnRetainedInputV1};
use serde_json::{Value, json};
use std::collections::HashSet;

pub fn request_fingerprint(params: &kcoder_app_protocol::TurnStartParams) -> Result<String> {
    let mut canonical = params.clone();
    canonical.retry_model_configuration =
        Some(params.retry_model_configuration.unwrap_or_default());
    canonical.model = canonical.model.map(|value| value.trim().to_owned());
    canonical.reasoning_effort = canonical
        .reasoning_effort
        .map(|value| value.trim().to_owned());
    canonical.proxy_url = canonical.proxy_url.map(|value| value.trim().to_owned());
    canonical.service_tier =
        canonical
            .service_tier
            .map(|value| match value.trim().to_ascii_lowercase().as_str() {
                "fast" | "priority" | "快速" | "运行快速" => "priority".into(),
                "standard" | "default" | "普通" | "标准" | "运行标准" => "default".into(),
                _ => value.trim().to_owned(),
            });
    Ok(hex_sha256(&serde_json::to_vec(&canonical)?))
}

pub fn store(engine: &QueryEngine, thread: &str) -> Result<TurnAttemptStore> {
    TurnAttemptStore::open(&engine.session_storage_dir_for(thread), thread)
}
pub fn begin(
    engine: &QueryEngine,
    identity: &TurnAttemptIdentity,
    continuing: bool,
    retry_operation_id: Option<&str>,
    input_context_hash: String,
    request_fingerprint: String,
) -> Result<()> {
    begin_record(
        engine,
        identity,
        continuing,
        retry_operation_id,
        input_context_hash,
        request_fingerprint,
        None,
    )
}

/// The trusted turn adapter supplies server-derived materialized artifact facts.
/// Validate against the same request and compute its digest before any store I/O.
/// Persist them atomically with Accepted; no second acceptance ledger is created.
pub fn begin_with_retained_input(
    engine: &QueryEngine,
    identity: &TurnAttemptIdentity,
    continuing: bool,
    input_context_hash: String,
    params: &kcoder_app_protocol::TurnStartParams,
    retained_input: TurnRetainedInputV1,
) -> Result<()> {
    retained_input.validate().map_err(anyhow::Error::msg)?;
    ensure!(
        params.thread_id == identity.thread_id,
        "retained request thread differs"
    );
    ensure!(
        params.client_message_id.as_deref() == Some(retained_input.client_message_id.as_str()),
        "retained request client message differs"
    );
    let fingerprint = request_fingerprint(params)?;
    begin_record(
        &engine
            .clone()
            .with_client_presentation(params.client_presentation.clone()),
        identity,
        continuing,
        params.retry_operation_id.as_deref(),
        input_context_hash,
        fingerprint,
        Some(retained_input),
    )
}

fn begin_record(
    engine: &QueryEngine,
    identity: &TurnAttemptIdentity,
    continuing: bool,
    retry_operation_id: Option<&str>,
    input_context_hash: String,
    request_fingerprint: String,
    retained_input: Option<TurnRetainedInputV1>,
) -> Result<()> {
    let store = store(engine, &identity.thread_id)?;
    recent_error::initialize_empty(engine, &identity.thread_id)?;
    let parent = if continuing {
        latest(&store, &identity.turn_id)?.map(|record| record.identity.attempt_id)
    } else {
        None
    };
    let record = TurnAttemptRecord {
        version: 1,
        identity: identity.clone(),
        parent_attempt_id: parent,
        retry_operation_id: retry_operation_id.map(str::to_owned),
        accepted_at_ms: now_millis(),
        input_context_hash,
        request_fingerprint: Some(request_fingerprint),
        retained_input,
        client_presentation: engine.client_presentation_snapshot(),
        status: TurnAttemptStatus::Accepted,
        completion: None,
    };
    ensure!(
        matches!(
            transcript_artifact_journal::write(
                &engine
                    .session_storage_dir_for(&identity.thread_id)
                    .join("turn-attempts"),
                &identity.thread_id,
                transcript_artifact_journal::Kind::TurnAttempts,
                || store.begin(record),
            )?,
            TurnAttemptBeginOutcome::Created(_)
        ),
        "attempt already accepted; inspect its receipt"
    );
    Ok(())
}
pub fn latest(store: &TurnAttemptStore, turn: &str) -> Result<Option<TurnAttemptRecord>> {
    let records = store
        .list()?
        .into_iter()
        .filter(|record| record.identity.turn_id == turn)
        .collect::<Vec<_>>();
    let parents = records
        .iter()
        .filter_map(|record| record.parent_attempt_id.as_deref())
        .collect::<HashSet<_>>();
    let tips = records
        .iter()
        .filter(|record| !parents.contains(record.identity.attempt_id.as_str()))
        .collect::<Vec<_>>();
    ensure!(tips.len() <= 1, "attempt history has conflicting branches");
    Ok(tips.first().map(|record| (*record).clone()))
}
pub fn finish(
    engine: &QueryEngine,
    identity: &TurnAttemptIdentity,
    status: &str,
    error: Option<&str>,
    failure: Option<&kcoder_types::ProviderFailureDetails>,
    partial: &PartialOutput,
) -> Result<()> {
    let store = store(engine, &identity.thread_id)?;
    let record = store.load(identity)?.context("attempt was not accepted")?;
    let status = match status {
        "completed" => TurnAttemptStatus::Completed,
        "failed" => TurnAttemptStatus::Failed,
        "interrupted" => TurnAttemptStatus::Interrupted,
        _ => anyhow::bail!("invalid terminal attempt status"),
    };
    transcript_artifact_journal::write(
        &engine
            .session_storage_dir_for(&identity.thread_id)
            .join("turn-attempts"),
        &identity.thread_id,
        transcript_artifact_journal::Kind::TurnAttempts,
        || {
            recent_error::before_finish(engine, identity, status.clone())?;
            store.finish(
                identity,
                TurnAttemptCompletion {
                    status,
                    finished_at_ms: now_millis().max(record.accepted_at_ms),
                    error: error.map(str::to_owned),
                    provider_failure: failure.cloned(),
                    partial_output: partial.text.clone(),
                    partial_output_truncated: partial.truncated,
                    committed_history_uuid: engine
                        .state
                        .latest_message_history_id_matching(|_| true),
                },
            )
        },
    )?;
    if engine.observe_native_execution_terminal().is_err() {
        tracing::warn!("native task budget terminal reconciliation remains pending");
    }
    Ok(())
}

pub fn records(engine: &QueryEngine, thread: &str) -> Result<Vec<TurnAttemptRecord>> {
    let records =
        match TurnAttemptStore::open_existing(&engine.session_storage_dir_for(thread), thread)? {
            Some(store) => store.list()?,
            None => Vec::new(),
        };
    validate_records(records)
}

use kcoder_transcript_observation::validate_records;

#[derive(Default)]
pub struct PartialOutput {
    text: String,
    truncated: bool,
}
impl PartialOutput {
    pub fn observe(&mut self, event: &EngineEvent) {
        match event {
            EngineEvent::AssistantMessageStarted | EngineEvent::AssistantMessageDone => {
                self.text.clear();
                self.truncated = false;
            }
            EngineEvent::AssistantTextDelta(text) => {
                let mut bytes = text
                    .len()
                    .min((256 * 1024usize).saturating_sub(self.text.len()));
                while !text.is_char_boundary(bytes) {
                    bytes -= 1;
                }
                self.text.push_str(&text[..bytes]);
                self.truncated |= bytes < text.len();
            }
            _ => {}
        }
    }
}

/// A recovery identity names one failed attempt, not every failure in the logical turn.
/// Replay is based on that attempt's terminal evidence, never a later turn outcome.
pub fn retry_admission(
    engine: &QueryEngine,
    thread: &str,
    turn: &str,
    parent: &str,
    operation: Option<&str>,
    request_fingerprint: &str,
    allow_legacy_fingerprint: bool,
) -> Result<Option<Value>> {
    let operation = operation
        .map(str::trim)
        .filter(|value| !value.trim().is_empty())
        .context("attempt continuation requires retryOperationId")?;
    ensure!(
        operation.len() <= 1024 && !parent.is_empty() && parent.len() <= 256,
        "invalid attempt recovery identity"
    );
    let records = records(engine, thread)?;
    let matching = records
        .iter()
        .filter(|record| record.retry_operation_id.as_deref() == Some(operation))
        .collect::<Vec<_>>();
    ensure!(
        matching.len() <= 1,
        "recovery operation names multiple attempts"
    );
    if let Some(record) = matching.first() {
        ensure!(
            record.identity.turn_id == turn && record.parent_attempt_id.as_deref() == Some(parent),
            "recovery operation was already accepted for another failed attempt"
        );
        match record.request_fingerprint.as_deref() {
            Some(stored) => ensure!(
                stored == request_fingerprint,
                "retry request conflicts with its accepted operation; inspect the existing attempt"
            ),
            None => ensure!(
                allow_legacy_fingerprint,
                "legacy retry receipt cannot verify these configuration options; inspect the existing attempt"
            ),
        }
        let status = match &record.status {
            TurnAttemptStatus::Completed => "completed",
            TurnAttemptStatus::Failed => "failed",
            TurnAttemptStatus::Interrupted => "interrupted",
            TurnAttemptStatus::Accepted => anyhow::bail!(
                "accepted attempt has no verifiable terminal status; inspect its receipt"
            ),
            TurnAttemptStatus::Unknown(_) => {
                anyhow::bail!("unrecognized attempt history is read-only; inspect its receipt")
            }
        };
        return Ok(Some(json!({"turn": {"id": turn, "threadId": thread,
            "attemptId": record.identity.attempt_id, "status": status}})));
    }
    let record = records
        .iter()
        .find(|record| record.identity.attempt_id == parent)
        .context("failed attempt is unavailable; refresh thread history")?;
    ensure!(
        record.identity.turn_id == turn && record.status == TurnAttemptStatus::Failed,
        "only a failed attempt in this turn can be continued"
    );
    ensure!(
        !records
            .iter()
            .any(|record| record.parent_attempt_id.as_deref() == Some(parent)),
        "this failed attempt already has a continuation; inspect its receipt"
    );
    Ok(None)
}

/// The parent must have an accepted ledger entry before its snapshot is trusted.
pub fn prepare_continuation_model(
    engine: &QueryEngine,
    params: &kcoder_app_protocol::TurnStartParams,
) -> Result<()> {
    let turn = params
        .retry_from_turn_id
        .as_deref()
        .context("missing failed turn")?;
    let existing = TurnAttemptStore::open_existing(
        &engine.session_storage_dir_for(&params.thread_id),
        &params.thread_id,
    )?;
    let parent = if let Some(store) = existing.as_ref() {
        if let Some(attempt) = params.retry_from_attempt_id.as_deref() {
            let identity = TurnAttemptIdentity {
                thread_id: params.thread_id.clone(),
                turn_id: turn.to_owned(),
                attempt_id: attempt.to_owned(),
            };
            Some(
                store
                    .load(&identity)?
                    .context("failed attempt was not accepted")?,
            )
        } else {
            latest(store, turn)?
        }
    } else {
        None
    };
    if let (Some(store), Some(parent)) = (existing.as_ref(), parent.as_ref()) {
        ensure!(
            parent.status == TurnAttemptStatus::Failed,
            "parent attempt is not failed"
        );
        let projection_key = |value: Option<&kcoder_types::ClientPresentationV1>| {
            (
                value
                    .and_then(|value| value.studio_work_mode)
                    .unwrap_or_default(),
                value.is_some_and(|value| value.inline_widgets),
            )
        };
        ensure!(
            projection_key(parent.client_presentation.as_ref())
                == projection_key(params.client_presentation.as_ref()),
            "Failed-turn continuation requires the original Studio mode and presentation tools. Start a new turn explicitly to change mode or client capabilities"
        );
        if let Some(snapshot) = store.load_model_snapshot(&parent.identity)? {
            return engine.prepare_client_model_continuation(
                &snapshot,
                kcoder_engine::ClientModelContinuationOptions {
                    model: params.model.as_deref(),
                    configuration: params.retry_model_configuration.unwrap_or_default(),
                    reasoning_effort: params.reasoning_effort.as_deref(),
                    proxy_url: params.proxy_url.as_deref(),
                    service_tier: params.service_tier.as_deref(),
                },
            );
        }
    }
    ensure!(
        params.retry_model_configuration != Some(kcoder_types::RetryModelConfiguration::Current),
        "Current continuation requires a saved model snapshot"
    );
    // Fixed scenario engines intentionally cannot freeze/restore model transports.
    // Production history lacking this evidence must never use today's new default.
    ensure!(
        engine.freeze_client_model()?.is_none(),
        "This failure has no saved model snapshot; its request configuration cannot be safely restored. Start a new turn explicitly."
    );
    engine.prepare_client_model_for_turn(params.model.as_deref(), true)?;
    if let Some(effort) = params.reasoning_effort.as_deref() {
        engine.set_client_reasoning_effort(effort)?;
    }
    engine.set_client_runtime_options(params.proxy_url.as_deref(), params.service_tier.as_deref())
}

pub fn save_model_snapshot(engine: &QueryEngine, identity: &TurnAttemptIdentity) -> Result<()> {
    if let Some(snapshot) = engine.freeze_client_model()? {
        store(engine, &identity.thread_id)?.save_model_snapshot(identity, &snapshot)?;
    }
    Ok(())
}

pub use kcoder_attachment_retention::acceptance::{
    VerifiedAcceptedTurnProof, strict_client_message_turn, verified_retained_acceptance_in,
};

pub fn verified_retained_acceptance(
    engine: &QueryEngine,
    scope: &kcoder_attachment_retention::model::Scope,
    identity: &TurnAttemptIdentity,
    client_message_id: &str,
    fingerprint: &str,
    parent: &kcoder_config::PrivateDirectory,
) -> Result<VerifiedAcceptedTurnProof> {
    verified_retained_acceptance_in(
        &engine.session_storage_dir_for(&identity.thread_id),
        scope,
        identity,
        client_message_id,
        fingerprint,
        parent,
    )
}

#[cfg(test)]
mod projection_tests {
    use super::*;
    use kcoder_transcript::AttemptRows;

    #[test]
    fn retry_request_fingerprint_covers_configuration_without_storing_values() {
        let value = json!({"threadId":"thread", "retryFromTurnId":"turn", "retryFromAttemptId":"attempt", "retryOperationId":"operation", "input":[]});
        let params: kcoder_app_protocol::TurnStartParams =
            serde_json::from_value(value.clone()).unwrap();
        let original = request_fingerprint(&params).unwrap();
        assert_eq!(original.len(), 64);
        let explicit: kcoder_app_protocol::TurnStartParams = serde_json::from_value({
            let mut value = value.clone();
            value["retryModelConfiguration"] = json!("snapshot");
            value
        })
        .unwrap();
        assert_eq!(original, request_fingerprint(&explicit).unwrap());
        for (field, next) in [
            ("retryModelConfiguration", "current"),
            ("model", "provider::model"),
            ("reasoningEffort", "high"),
            ("proxyUrl", "http://private.invalid"),
            ("serviceTier", "fast"),
        ] {
            let mut changed = value.clone();
            changed[field] = json!(next);
            let changed: kcoder_app_protocol::TurnStartParams =
                serde_json::from_value(changed).unwrap();
            assert_ne!(original, request_fingerprint(&changed).unwrap(), "{field}");
        }
    }
    fn failed(turn: &str, anchor: Option<&str>) -> TurnAttemptRecord {
        TurnAttemptRecord {
            version: 1,
            identity: TurnAttemptIdentity {
                thread_id: "thread".into(),
                turn_id: turn.into(),
                attempt_id: turn.into(),
            },
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "a".repeat(64),
            request_fingerprint: None,
            retained_input: None,
            client_presentation: None,
            status: TurnAttemptStatus::Failed,
            completion: Some(TurnAttemptCompletion {
                status: TurnAttemptStatus::Failed,
                finished_at_ms: 2,
                error: Some("hook blocked".into()),
                provider_failure: None,
                partial_output: String::new(),
                partial_output_truncated: false,
                committed_history_uuid: anchor.map(str::to_owned),
            }),
        }
    }
    #[test]
    fn future_attempt_rows_preserve_raw_status_without_inventing_failure_or_cancellation() {
        for has_completion in [false, true] {
            let mut future = failed("turn-1", None);
            future.status = TurnAttemptStatus::Unknown("future_cleanup".into());
            if has_completion {
                future.completion.as_mut().unwrap().status = future.status.clone();
            } else {
                future.completion = None;
            }
            let mut rows = AttemptRows::new(
                vec![future],
                &HashSet::new(),
                &HashSet::new(),
                &HashSet::new(),
            );
            let projected = rows.before_turn(None).unwrap();
            assert_eq!(projected[0].status.as_deref(), Some("future_cleanup"));
            assert_eq!(projected[0].attempt_id.as_deref(), Some("turn-1"));
        }
    }
    #[test]
    fn unrepresented_attempts_preserve_admission_order_without_resurrecting_removed_context() {
        let represented = HashSet::from(["turn-2".into()]);
        let admitted_users = HashSet::from(["turn-2".into(), "turn-4".into()]);
        let visible = HashSet::from(["visible-anchor".into()]);
        let mut rows = AttemptRows::new(
            vec![
                failed("turn-3", Some("visible-anchor")),
                failed("turn-1", None),
                failed("turn-4", None),
                failed("turn-5", Some("removed-anchor")),
            ],
            &represented,
            &admitted_users,
            &visible,
        );
        let first = rows.before_turn(Some("turn-2")).unwrap();
        assert_eq!(first[0].turn_id.as_deref(), Some("turn-1"));
        assert!(rows.before_turn(Some("turn-2")).is_none());
        assert_eq!(
            rows.before_turn(None).unwrap()[0].turn_id.as_deref(),
            Some("turn-3")
        );
        assert!(
            rows.before_turn(None).is_none(),
            "removed user turns and anchors must stay removed"
        );
    }
}
