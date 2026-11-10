use super::*;
use kcoder_state::turn_attempt_store::{TurnAttemptCompletion, TurnAttemptRecord};
use kcoder_types::TurnAttemptStatus;

pub struct AttemptRows {
    unrepresented: std::collections::BTreeMap<(u64, String), Vec<ThreadMessage>>,
    anchored: HashMap<String, Vec<ThreadMessage>>,
    remaining: HashMap<String, Vec<ThreadMessage>>,
}
impl AttemptRows {
    pub fn new(
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
            let completion = match record.completion {
                Some(completion) => completion,
                None if !record.status.is_known() => TurnAttemptCompletion {
                    status: record.status.clone(),
                    finished_at_ms: record.accepted_at_ms,
                    error: None,
                    provider_failure: None,
                    partial_output: String::new(),
                    partial_output_truncated: false,
                    committed_history_uuid: None,
                },
                None => continue,
            };
            if completion.status == TurnAttemptStatus::Completed {
                continue;
            }
            let row = ThreadMessage {
                file_changes_capture: None,
                review_evidence: None,
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
                status: Some(match &completion.status {
                    TurnAttemptStatus::Interrupted => "cancelled".into(),
                    TurnAttemptStatus::Failed => "failed".into(),
                    TurnAttemptStatus::Unknown(raw) => raw.clone(),
                    _ => continue,
                }),
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
    pub fn before_turn(&mut self, next: Option<&str>) -> Option<Vec<ThreadMessage>> {
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
    pub fn after_entry(&mut self, uuid: Option<&str>, turn: Option<&str>) -> Vec<ThreadMessage> {
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
    pub fn finish_turn(&mut self, turn: Option<&str>) -> Vec<ThreadMessage> {
        turn.and_then(|turn| self.remaining.remove(turn))
            .unwrap_or_default()
    }
}
