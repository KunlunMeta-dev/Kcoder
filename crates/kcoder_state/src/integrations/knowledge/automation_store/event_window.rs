//! Durable ingress reservations bound to native, already-authorized event evidence.
use super::*;
use anyhow::Context;

const MIN_INTERVAL_MS: u64 = 10_000;
const STORM_WINDOW_MS: u64 = 60_000;
const MAX_PER_WINDOW: usize = 4;
const MAX_EVENT_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS: u64 = 30_000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EventAdmission {
    intent: Value,
    admitted_at_ms: u64,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EventWindow {
    last_admitted_at_ms: u64,
    admitted_at_ms: Vec<u64>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct QuarantinedEvent {
    intent: Value,
    reason: String,
}

impl AutomationStore {
    /// Observe original facts only. Reading never admits an event or advances its source cursor.
    pub fn list_quarantined_events(
        &self,
        after: Option<&str>,
    ) -> Result<KnowledgePage<kcoder_types::integrations::knowledge::AutomationQuarantinedEvent>>
    {
        if let Some(after) = after {
            validate_id(after)?;
        }
        self.access(false, |data| {
            let mut items = Vec::new();
            for (id, record) in data
                .quarantined_events
                .iter()
                .filter(|(id, _)| after.is_none_or(|after| id.as_str() > after))
                .take(11)
            {
                let text = |name: &str| {
                    record
                        .intent
                        .get(name)
                        .and_then(Value::as_str)
                        .ok_or_else(|| anyhow::anyhow!("AUTOMATION_QUARANTINE_FACT_INVALID"))
                };
                let number = |name: &str| {
                    record
                        .intent
                        .get(name)
                        .and_then(Value::as_u64)
                        .ok_or_else(|| anyhow::anyhow!("AUTOMATION_QUARANTINE_FACT_INVALID"))
                };
                items.push(
                    kcoder_types::integrations::knowledge::AutomationQuarantinedEvent {
                        id: id.clone(),
                        subscription_id: text("subscriptionId")?.into(),
                        subscription_revision: number("revision")?,
                        source_ref: text("source")?.into(),
                        event_id: text("eventId")?.into(),
                        occurred_at_ms: number("occurredAtMs")?,
                        reason_code: record.reason.clone(),
                    },
                );
            }
            let next_cursor = (items.len() > 10).then(|| items[9].id.clone());
            items.truncate(10);
            Ok(KnowledgePage { items, next_cursor })
        })
    }
    /// Current explicit event sources only; schedule count does not consume this budget.
    pub fn enabled_event_source_refs(&self) -> Result<Vec<String>> {
        self.access(false, |data| {
            let mut references = std::collections::BTreeSet::new();
            for subscription in data
                .subscriptions
                .values()
                .filter(|subscription| subscription.enabled && !subscription.consent_ref.is_empty())
            {
                if let Some(reference) = &subscription.draft.event_source {
                    references.insert(reference.clone());
                    ensure!(references.len() <= 32, "AUTOMATION_EVENT_SOURCE_SCAN_LIMIT");
                }
            }
            Ok(references.into_iter().collect())
        })
    }
    /// A held source is an observation, not a new subscription or scheduling authority.
    pub fn event_subscriptions(&self, source: &str) -> Result<Vec<AutomationSubscription>> {
        validate_id(source)?;
        self.access(false, |data| {
            Ok(data
                .subscriptions
                .values()
                .filter(|subscription| {
                    subscription.enabled
                        && !subscription.consent_ref.is_empty()
                        && subscription.draft.event_source.as_deref() == Some(source)
                })
                .take(32)
                .cloned()
                .collect())
        })
    }

    /// Read the original admission metadata for a content-addressed native observation.
    /// This does not admit data, advance a cursor, or confer source/read authority.
    pub fn recorded_event_position(
        &self,
        subscription_id: &str,
        revision: u64,
        source: &str,
        event_id: &str,
    ) -> Result<Option<(u64, u64, bool)>> {
        validate_id(source)?;
        validate_id(event_id)?;
        self.access(false, |data| {
            let key = digest(&serde_json::to_string(&(
                subscription_id,
                revision,
                event_id,
            ))?);
            let Some(original) = data
                .event_admissions
                .get(&key)
                .map(|event| &event.intent)
                .or_else(|| data.quarantined_events.get(&key).map(|event| &event.intent))
            else {
                return Ok(None);
            };
            ensure!(
                original["subscriptionId"] == subscription_id
                    && original["revision"] == revision
                    && original["source"] == source
                    && original["eventId"] == event_id,
                "AUTOMATION_EVENT_SOURCE_MISMATCH"
            );
            let sequence = original["sequence"]
                .as_u64()
                .context("AUTOMATION_EVENT_ADMISSION_INVALID")?;
            let occurred = original["occurredAtMs"]
                .as_u64()
                .context("AUTOMATION_EVENT_ADMISSION_INVALID")?;
            let committed = data.triggers.get(&key).is_some_and(|trigger| {
                data.runs.get(&trigger.run_id).is_some_and(|run| {
                    run.subscription_id == subscription_id
                        && run.subscription_revision == revision
                        && run.trigger_id == event_id
                })
            });
            Ok(Some((sequence, occurred, committed)))
        })
    }

    /// Return the next sequence without advancing it; identical latest observations are inert.
    pub fn next_event_sequence(
        &self,
        subscription_id: &str,
        revision: u64,
        source: &str,
        event_id: &str,
    ) -> Result<Option<u64>> {
        validate_id(source)?;
        validate_id(event_id)?;
        self.access(false, |data| {
            let key = serde_json::to_string(&(subscription_id, revision, source))?;
            match data.event_cursors.get(&key) {
                Some(cursor) if cursor.event_id == event_id => Ok(None),
                Some(cursor) => {
                    Ok(Some(cursor.sequence.checked_add(1).ok_or_else(|| {
                        anyhow::anyhow!("AUTOMATION_EVENT_SEQUENCE_EXHAUSTED")
                    })?))
                }
                None => Ok(Some(1)),
            }
        })
    }

    /// Reserve ingress before preparing a run. Replays retain the original reservation;
    /// backpressure never advances the source cursor and no network work holds this lock.
    #[allow(clippy::too_many_arguments)]
    pub fn admit_verified_event(
        &self,
        subscription_id: &str,
        revision: u64,
        source: &str,
        sequence: u64,
        event_id: &str,
        occurred_at_ms: u64,
        facts: &Value,
        originating_subscription: Option<&str>,
        causation_depth: u8,
        now_ms: u64,
    ) -> Result<()> {
        self.admit_verified_event_inner(
            subscription_id,
            revision,
            source,
            Some(sequence),
            event_id,
            occurred_at_ms,
            facts,
            originating_subscription,
            causation_depth,
            now_ms,
        )
        .map(|_| ())
    }

    /// Assign only the existing D projection sequence under the same admission lock.
    /// Original Inbox sequence/time/identity remain immutable trigger facts.
    /// Returns the assigned sequence and whether its original run checkpoint is already durable.
    #[allow(clippy::too_many_arguments)]
    pub fn admit_verified_inbox_event(
        &self,
        subscription_id: &str,
        revision: u64,
        source: &str,
        event_id: &str,
        occurred_at_ms: u64,
        facts: &Value,
        originating_subscription: Option<&str>,
        causation_depth: u8,
        now_ms: u64,
    ) -> Result<(u64, bool)> {
        self.admit_verified_event_inner(
            subscription_id,
            revision,
            source,
            None,
            event_id,
            occurred_at_ms,
            facts,
            originating_subscription,
            causation_depth,
            now_ms,
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn admit_verified_event_inner(
        &self,
        subscription_id: &str,
        revision: u64,
        source: &str,
        requested_sequence: Option<u64>,
        event_id: &str,
        occurred_at_ms: u64,
        facts: &Value,
        originating_subscription: Option<&str>,
        causation_depth: u8,
        now_ms: u64,
    ) -> Result<(u64, bool)> {
        validate_id(source)?;
        validate_id(event_id)?;
        ensure!(
            requested_sequence.is_none_or(|sequence| sequence > 0),
            "AUTOMATION_EVENT_CURSOR_GAP"
        );
        ensure!(
            originating_subscription != Some(subscription_id) && causation_depth <= 8,
            "AUTOMATION_EVENT_LOOP_REJECTED"
        );
        let encoded_facts = serde_json::to_vec(facts)?;
        ensure!(
            encoded_facts.len() <= 64 * 1024,
            "AUTOMATION_EVENT_TOO_LARGE"
        );
        let key = digest(&serde_json::to_string(&(
            subscription_id,
            revision,
            event_id,
        ))?);
        let outcome = self.access(true, |data| {
            let subscription = data
                .subscriptions
                .get(subscription_id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_NOT_FOUND"))?;
            ensure!(subscription.enabled, "AUTOMATION_DISABLED");
            ensure!(
                subscription.revision == revision,
                "AUTOMATION_REVISION_CONFLICT"
            );
            ensure!(
                subscription.draft.event_source.as_deref() == Some(source),
                "AUTOMATION_EVENT_SOURCE_MISMATCH"
            );
            if requested_sequence.is_none() {
                let inbox_sequence=facts["inboxSequence"].as_u64().ok_or_else(||anyhow::anyhow!("AUTOMATION_EVENT_FACT_INVALID"))?;
                ensure!(source_start::check_start(data,subscription_id,revision,source,inbox_sequence)?,"AUTOMATION_EVENT_BEFORE_SUBSCRIPTION");
            }
            let sequence = if let Some(sequence) = requested_sequence {
                sequence
            } else if let Some(original) = data.event_admissions.get(&key).map(|a| &a.intent)
                .or_else(|| data.quarantined_events.get(&key).map(|q| &q.intent))
            {
                original["sequence"].as_u64()
                    .ok_or_else(|| anyhow::anyhow!("AUTOMATION_EVENT_ADMISSION_INVALID"))?
            } else {
                let cursor_key = serde_json::to_string(&(subscription_id, revision, source))?;
                let next = data.event_cursors.get(&cursor_key).map_or(Ok(1), |cursor|
                    cursor.sequence.checked_add(1).ok_or_else(|| anyhow::anyhow!("AUTOMATION_EVENT_SEQUENCE_EXHAUSTED")))?;
                // A prior admitted event must settle its original run/checkpoint first.
                // No second event may take that pending projection sequence.
                ensure!(!data.event_admissions.iter().any(|(_, admission)|
                    admission.intent["subscriptionId"] == subscription_id
                        && admission.intent["revision"] == revision
                        && admission.intent["source"] == source
                        && admission.intent["sequence"].as_u64().is_some_and(|sequence| sequence >= next)
),
                    "AUTOMATION_EVENT_ADMISSION_PENDING");
                next
            };
            let intent = json!({"subscriptionId":subscription_id,"revision":revision,"source":source,
            "sequence":sequence,"eventId":event_id,"occurredAtMs":occurred_at_ms,
            "factsSha256":format!("{:x}", Sha256::digest(&encoded_facts)),
            "originatingSubscription":originating_subscription,"causationDepth":causation_depth});
            let cursor_key=serde_json::to_string(&(subscription_id,revision,source))?;
            let checkpointed=data.triggers.get(&key).is_some_and(|receipt|
                data.event_cursors.get(&cursor_key).is_some_and(|cursor|
                    (cursor.sequence>sequence || (cursor.sequence==sequence && cursor.event_id==event_id && cursor.run_id==receipt.run_id)) && data.runs.get(&receipt.run_id).is_some_and(|run|
                        run.subscription_id==subscription_id && run.subscription_revision==revision && run.trigger_id==event_id)));
            if let Some(quarantined) = data.quarantined_events.get(&key) {
                ensure!(quarantined.intent == intent, "AUTOMATION_TRIGGER_CONFLICT");
                return Ok(Err(quarantined.reason.clone()));
            }
            if let Some(admitted) = data.event_admissions.get(&key) {
                ensure!(admitted.intent == intent, "AUTOMATION_TRIGGER_CONFLICT");
                if data.triggers.contains_key(&key) {
                    return Ok(Ok((sequence,checkpointed)));
                }
            }
            let stale =
                occurred_at_ms == 0 || now_ms.saturating_sub(occurred_at_ms) > MAX_EVENT_AGE_MS;
            let future = occurred_at_ms > now_ms.saturating_add(MAX_FUTURE_SKEW_MS);
            if stale || future {
                ensure!(
                    data.quarantined_events.len() < MAX_ITEMS,
                    "AUTOMATION_EVENT_QUARANTINE_CAPACITY"
                );
                let reason = if stale {
                    "AUTOMATION_EVENT_STALE_QUARANTINED"
                } else {
                    "AUTOMATION_EVENT_CLOCK_QUARANTINED"
                }
                .to_owned();
                data.quarantined_events.insert(
                    key,
                    QuarantinedEvent {
                        intent,
                        reason: reason.clone(),
                    },
                );
                return Ok(Err(reason));
            }
            if data.event_admissions.contains_key(&key) {
                return Ok(Ok((sequence,checkpointed)));
            }
            ensure!(
                data.event_admissions.len() < MAX_ITEMS,
                "AUTOMATION_EVENT_ADMISSION_CAPACITY"
            );
            let cursor_key = serde_json::to_string(&(subscription_id, revision, source))?;
            match data.event_cursors.get(&cursor_key) {
                Some(cursor) => ensure!(
                    sequence
                        == cursor
                            .sequence
                            .checked_add(1)
                            .ok_or_else(|| anyhow::anyhow!(
                                "AUTOMATION_EVENT_SEQUENCE_EXHAUSTED"
                            ))?,
                    "AUTOMATION_EVENT_CURSOR_GAP"
                ),
                None => ensure!(sequence == 1, "AUTOMATION_EVENT_CURSOR_GAP"),
            }
            let window = data
                .event_windows
                .entry(subscription_id.into())
                .or_default();
            if !window.admitted_at_ms.is_empty() {
                ensure!(
                    now_ms >= window.last_admitted_at_ms,
                    "AUTOMATION_EVENT_CLOCK_REGRESSED"
                );
                ensure!(
                    now_ms - window.last_admitted_at_ms >= MIN_INTERVAL_MS,
                    "AUTOMATION_EVENT_MIN_INTERVAL"
                );
            }
            window
                .admitted_at_ms
                .retain(|at| now_ms.saturating_sub(*at) < STORM_WINDOW_MS);
            ensure!(
                window.admitted_at_ms.len() < MAX_PER_WINDOW,
                "AUTOMATION_EVENT_STORM_BACKPRESSURE"
            );
            window.last_admitted_at_ms = now_ms;
            window.admitted_at_ms.push(now_ms);
            data.event_admissions.insert(
                key,
                EventAdmission {
                    intent,
                    admitted_at_ms: now_ms,
                },
            );
            Ok(Ok((sequence,checkpointed)))
        })?;
        outcome.map_err(|reason| anyhow::anyhow!(reason))
    }
}

#[cfg(test)]
mod tests;
