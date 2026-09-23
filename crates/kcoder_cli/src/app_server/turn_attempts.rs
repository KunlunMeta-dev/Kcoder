//! Persistent attempt lifecycle. Visible partial output is never fed back to the model.
use super::*;
use kcoder_state::turn_attempt_store::{
    TurnAttemptBeginOutcome, TurnAttemptCompletion, TurnAttemptRecord, TurnAttemptStore,
};
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};

pub(super) fn request_fingerprint(params: &kcoder_app_protocol::TurnStartParams) -> Result<String> {
    let mut canonical = params.clone();
    canonical.retry_model_configuration = Some(params.retry_model_configuration.unwrap_or_default());
    canonical.model = canonical.model.map(|value| value.trim().to_owned());
    canonical.reasoning_effort = canonical.reasoning_effort.map(|value| value.trim().to_owned());
    canonical.proxy_url = canonical.proxy_url.map(|value| value.trim().to_owned());
    canonical.service_tier = canonical.service_tier.map(|value| match value.trim().to_ascii_lowercase().as_str() {
        "fast" | "priority" | "快速" | "运行快速" => "priority".into(),
        "standard" | "default" | "普通" | "标准" | "运行标准" => "default".into(),
        _ => value.trim().to_owned(),
    });
    Ok(hex_sha256(&serde_json::to_vec(&canonical)?))
}

pub(super) fn store(engine: &QueryEngine, thread: &str) -> Result<TurnAttemptStore> {
    TurnAttemptStore::open(&engine.session_storage_dir_for(thread), thread)
}
pub(super) fn begin(
    engine: &QueryEngine,
    identity: &TurnAttemptIdentity,
    continuing: bool,
    retry_operation_id: Option<&str>,
    input_context_hash: String,
    request_fingerprint: String,
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
pub(super) fn latest(store: &TurnAttemptStore, turn: &str) -> Result<Option<TurnAttemptRecord>> {
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
pub(super) fn finish(
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
            recent_error::before_finish(engine, identity, status)?;
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
    Ok(())
}

pub(super) fn records(engine: &QueryEngine, thread: &str) -> Result<Vec<TurnAttemptRecord>> {
    let records =
        match TurnAttemptStore::open_existing(&engine.session_storage_dir_for(thread), thread)? {
            Some(store) => store.list()?,
            None => Vec::new(),
        };
    validate_records(records)
}

pub(super) fn validate_records(
    mut records: Vec<TurnAttemptRecord>,
) -> Result<Vec<TurnAttemptRecord>> {
    let by_id = records
        .iter()
        .map(|record| (record.identity.attempt_id.as_str(), record))
        .collect::<HashMap<_, _>>();
    ensure!(by_id.len() == records.len(), "duplicate attempt identity");
    let mut children = HashSet::new();
    let mut depths = HashMap::new();
    for record in &records {
        record.validate()?;
        let mut depth = 0usize;
        let mut current = record;
        while let Some(parent_id) = &current.parent_attempt_id {
            let parent = by_id
                .get(parent_id.as_str())
                .context("attempt parent is missing")?;
            ensure!(
                parent.identity.turn_id == record.identity.turn_id,
                "attempt parent belongs to another turn"
            );
            depth += 1;
            ensure!(depth < records.len(), "attempt history cycle");
            current = parent;
        }
        depths.insert(record.identity.attempt_id.clone(), depth);
        if let Some(parent) = &record.parent_attempt_id {
            ensure!(
                children.insert(parent),
                "attempt history has conflicting branches"
            );
        }
    }
    records.sort_by_key(|record| depths[&record.identity.attempt_id]);
    Ok(records)
}

pub(super) struct AttemptRows {
    unrepresented: std::collections::BTreeMap<(u64, String), Vec<ThreadMessage>>,
    anchored: HashMap<String, Vec<ThreadMessage>>,
    remaining: HashMap<String, Vec<ThreadMessage>>,
}
impl AttemptRows {
    pub(super) fn new(
        records: Vec<TurnAttemptRecord>,
        represented: &HashSet<String>,
        admitted_users: &HashSet<String>,
        visible_uuids: &HashSet<String>,
    ) -> Self {
        let children = records
            .iter()
            .filter_map(|record| {
                record
                    .parent_attempt_id
                    .as_ref()
                    .map(|parent| (parent.clone(), record.identity.attempt_id.clone()))
            })
            .collect::<HashMap<_, _>>();
        let mut result = Self {
            unrepresented: std::collections::BTreeMap::new(),
            anchored: HashMap::new(),
            remaining: HashMap::new(),
        };
        for record in records {
            let Some(completion) = record.completion else {
                continue;
            };
            if completion.status == TurnAttemptStatus::Completed {
                continue;
            }
            let row = ThreadMessage {
                id: format!(
                    "attempt-outcome-{}",
                    hex_sha256(
                        format!(
                            "{}:{}",
                            record.identity.thread_id, record.identity.attempt_id
                        )
                        .as_bytes()
                    )
                ),
                client_message_id: None,
                turn_id: Some(record.identity.turn_id.clone()),
                attempt_id: Some(record.identity.attempt_id.clone()),
                continued_by_attempt_id: children.get(&record.identity.attempt_id).cloned(),
                role: "assistant".into(),
                content: completion.partial_output,
                status: Some(
                    if completion.status == TurnAttemptStatus::Interrupted {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into(),
                ),
                error: completion.error,
                error_type: completion
                    .provider_failure
                    .as_ref()
                    .map(|failure| failure.category.as_str().into()),
                provider_failure: completion.provider_failure,
                blocks: Vec::new(),
                timestamp_ms: completion.finished_at_ms,
                content_truncated: completion.partial_output_truncated,
                content_original_chars: None,
            };
            if !represented.contains(&record.identity.turn_id) {
                // Never resurrect a real user turn removed by rewind/compaction, nor
                // detach a failed attempt from a committed anchor that was removed.
                if !admitted_users.contains(&record.identity.turn_id)
                    && completion
                        .committed_history_uuid
                        .as_ref()
                        .is_none_or(|uuid| visible_uuids.contains(uuid))
                {
                    let number = record
                        .identity
                        .turn_id
                        .strip_prefix("turn-")
                        .and_then(|id| id.parse::<u64>().ok())
                        .unwrap_or(u64::MAX);
                    result
                        .unrepresented
                        .entry((number, record.identity.turn_id))
                        .or_default()
                        .push(row);
                }
                continue;
            }
            if let Some(anchor) = completion.committed_history_uuid {
                result.anchored.entry(anchor).or_default().push(row);
            } else {
                result
                    .remaining
                    .entry(record.identity.turn_id)
                    .or_default()
                    .push(row);
            }
        }
        result
    }
    pub(super) fn before_turn(&mut self, next: Option<&str>) -> Option<Vec<ThreadMessage>> {
        let (key, _) = self.unrepresented.first_key_value()?;
        let should_emit = next.is_none_or(|turn| {
            turn.strip_prefix("turn-")
                .and_then(|id| id.parse::<u64>().ok())
                .is_some_and(|number| key.0 < number)
        });
        should_emit.then(|| {
            self.unrepresented
                .pop_first()
                .expect("checked first orphan exists")
                .1
        })
    }
    pub(super) fn after_entry(
        &mut self,
        uuid: Option<&str>,
        turn: Option<&str>,
    ) -> Vec<ThreadMessage> {
        let Some(uuid) = uuid else {
            return Vec::new();
        };
        let mut rows = Vec::new();
        for row in self.anchored.remove(uuid).unwrap_or_default() {
            if row.turn_id.as_deref() == turn {
                rows.push(row);
            } else if let Some(turn) = &row.turn_id {
                self.remaining.entry(turn.clone()).or_default().push(row);
            }
        }
        rows
    }
    pub(super) fn finish_turn(&mut self, turn: Option<&str>) -> Vec<ThreadMessage> {
        turn.and_then(|turn| self.remaining.remove(turn))
            .unwrap_or_default()
    }
}

#[derive(Default)]
pub(super) struct PartialOutput {
    text: String,
    truncated: bool,
}
impl PartialOutput {
    pub(super) fn observe(&mut self, event: &EngineEvent) {
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
pub(super) fn retry_admission(
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
            Some(stored) => ensure!(stored == request_fingerprint, "retry request conflicts with its accepted operation; inspect the existing attempt"),
            None => ensure!(allow_legacy_fingerprint, "legacy retry receipt cannot verify these configuration options; inspect the existing attempt"),
        }
        let status = match record.status {
            TurnAttemptStatus::Completed => "completed",
            TurnAttemptStatus::Failed => "failed",
            TurnAttemptStatus::Interrupted => "interrupted",
            TurnAttemptStatus::Accepted => anyhow::bail!(
                "accepted attempt has no verifiable terminal status; inspect its receipt"
            ),
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
pub(super) fn prepare_continuation_model(
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
        if let Some(snapshot) = store.load_model_snapshot(&parent.identity)? {
            return engine.prepare_client_model_continuation(&snapshot, kcoder_engine::ClientModelContinuationOptions {
                model: params.model.as_deref(), configuration: params.retry_model_configuration.unwrap_or_default(),
                reasoning_effort: params.reasoning_effort.as_deref(), proxy_url: params.proxy_url.as_deref(), service_tier: params.service_tier.as_deref(),
            });
        }
    }
    ensure!(params.retry_model_configuration != Some(kcoder_types::RetryModelConfiguration::Current), "Current continuation requires a saved model snapshot");
    // Fixed scenario engines intentionally cannot freeze/restore model transports.
    // Production history lacking this evidence must never use today's new default.
    ensure!(
        engine.freeze_client_model()?.is_none(),
        "This failure has no saved model snapshot; its request configuration cannot be safely restored. Start a new turn explicitly."
    );
    engine.prepare_client_model_for_turn(params.model.as_deref(), true)?;
    if let Some(effort) = params.reasoning_effort.as_deref() { engine.set_client_reasoning_effort(effort)?; }
    engine.set_client_runtime_options(params.proxy_url.as_deref(), params.service_tier.as_deref())
}

pub(super) fn save_model_snapshot(
    engine: &QueryEngine,
    identity: &TurnAttemptIdentity,
) -> Result<()> {
    if let Some(snapshot) = engine.freeze_client_model()? {
        store(engine, &identity.thread_id)?.save_model_snapshot(identity, &snapshot)?;
    }
    Ok(())
}

#[cfg(test)]
mod projection_tests {
    use super::*;
    #[test]
    fn retry_request_fingerprint_covers_configuration_without_storing_values() {
        let value = json!({"threadId":"thread", "retryFromTurnId":"turn", "retryFromAttemptId":"attempt", "retryOperationId":"operation", "input":[]});
        let params: kcoder_app_protocol::TurnStartParams = serde_json::from_value(value.clone()).unwrap();
        let original = request_fingerprint(&params).unwrap();
        assert_eq!(original.len(), 64);
        let explicit: kcoder_app_protocol::TurnStartParams = serde_json::from_value({let mut value=value.clone(); value["retryModelConfiguration"]=json!("snapshot"); value}).unwrap();
        assert_eq!(original, request_fingerprint(&explicit).unwrap());
        for (field, next) in [("retryModelConfiguration", "current"), ("model", "provider::model"), ("reasoningEffort", "high"), ("proxyUrl", "http://private.invalid"), ("serviceTier", "fast")] {
            let mut changed = value.clone(); changed[field] = json!(next);
            let changed: kcoder_app_protocol::TurnStartParams = serde_json::from_value(changed).unwrap();
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
