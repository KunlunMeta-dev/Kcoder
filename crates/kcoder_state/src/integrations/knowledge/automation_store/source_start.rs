//! Per-revision source origins are provenance in the original store, never permission grants.
use super::*;
use std::sync::Arc;

/// The native producer holds its actual source/parent and serialization guard; no wire constructor exists.
pub trait VerifiedAutomationSourceStart: Send + Sync {
    fn verify_for_owner(&self, owner: &KnowledgeOwner) -> Result<()>;
    fn source_ref(&self) -> &str;
    fn after_sequence(&self) -> u64;
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SourceStart {
    source_ref: String,
    after_sequence: u64,
}
pub enum AutomationInboxEventDisposition {
    New,
    BeforeStart,
    Existing(Box<AutomationRun>),
}
impl ApprovedAutomationConsent {
    pub fn with_native_source_start(
        mut self,
        witness: Arc<dyn VerifiedAutomationSourceStart>,
    ) -> Result<Self> {
        witness.verify_for_owner(&self.owner)?;
        ensure!(
            self.event_source.as_deref() == Some(witness.source_ref()),
            "AUTOMATION_EVENT_SOURCE_MISMATCH"
        );
        self.native_source_start = Some(witness);
        Ok(self)
    }
}
pub(super) fn verified_start(
    owner: &KnowledgeOwner,
    source: Option<&str>,
    witness: Option<&dyn VerifiedAutomationSourceStart>,
) -> Result<Option<SourceStart>> {
    match witness {
        Some(witness) => {
            witness.verify_for_owner(owner)?;
            ensure!(
                source == Some(witness.source_ref()),
                "AUTOMATION_EVENT_SOURCE_MISMATCH"
            );
            Ok(Some(SourceStart {
                source_ref: witness.source_ref().into(),
                after_sequence: witness.after_sequence(),
            }))
        }
        None => {
            ensure!(
                !source.is_some_and(|source| source.starts_with("connection-event-")),
                "AUTOMATION_EVENT_SOURCE_START_REQUIRED"
            );
            Ok(None)
        }
    }
}
pub(super) fn check_start(
    data: &Data,
    subscription: &str,
    revision: u64,
    source: &str,
    inbox_sequence: u64,
) -> Result<bool> {
    let start = data
        .native_source_starts
        .get(&version_key(subscription, revision)?)
        .ok_or_else(|| anyhow::anyhow!("AUTOMATION_EVENT_SOURCE_START_REQUIRED"))?;
    ensure!(
        start.source_ref == source,
        "AUTOMATION_EVENT_SOURCE_MISMATCH"
    );
    Ok(inbox_sequence > start.after_sequence)
}
impl AutomationStore {
    /// Read the earliest explicit start among enabled current revisions, without advancing admission or delivery.
    pub fn inbox_source_feed_start(&self, source: &str) -> Result<Option<u64>> {
        validate_id(source)?;
        self.access(false, |data| {
            let mut first = None;
            for sub in data
                .subscriptions
                .values()
                .filter(|sub| sub.enabled && sub.draft.event_source.as_deref() == Some(source))
            {
                let start = data
                    .native_source_starts
                    .get(&version_key(&sub.draft.id, sub.revision)?)
                    .ok_or_else(|| anyhow::anyhow!("AUTOMATION_EVENT_SOURCE_START_REQUIRED"))?;
                ensure!(
                    start.source_ref == source,
                    "AUTOMATION_EVENT_SOURCE_MISMATCH"
                );
                first = Some(first.map_or(start.after_sequence, |current: u64| {
                    current.min(start.after_sequence)
                }));
            }
            Ok(first)
        })
    }
    /// Observe original receipts before considering any new revision. This never creates or resumes work.
    pub fn observe_inbox_event(
        &self,
        subscription_id: &str,
        revision: u64,
        source: &str,
        event_id: &str,
        facts: &Value,
    ) -> Result<AutomationInboxEventDisposition> {
        validate_id(source)?;
        validate_id(event_id)?;
        self.access(false, |data| {
            let mut known = None;
            for receipt in data.triggers.values().filter(|receipt| {
                receipt.intent["subscriptionId"] == subscription_id
                    && receipt.intent["triggerId"] == event_id
            }) {
                let run = data
                    .runs
                    .get(&receipt.run_id)
                    .ok_or_else(|| anyhow::anyhow!("AUTOMATION_RUN_MISSING"))?;
                let original = data
                    .subscription_versions
                    .get(&version_key(subscription_id, run.subscription_revision)?)
                    .ok_or_else(|| {
                        anyhow::anyhow!("AUTOMATION_SUBSCRIPTION_REVISION_UNAVAILABLE")
                    })?;
                if original.draft.event_source.as_deref() != Some(source) {
                    continue;
                }
                ensure!(
                    receipt.intent["facts"] == *facts,
                    "AUTOMATION_TRIGGER_CONFLICT"
                );
                ensure!(known.is_none(), "AUTOMATION_EVENT_RECEIPT_CONFLICT");
                known = Some(run.clone());
            }
            if let Some(run) = known {
                return Ok(AutomationInboxEventDisposition::Existing(Box::new(run)));
            }
            let sub = data
                .subscriptions
                .get(subscription_id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_NOT_FOUND"))?;
            ensure!(
                sub.enabled && sub.revision == revision,
                "AUTOMATION_REVISION_CONFLICT"
            );
            ensure!(
                sub.draft.event_source.as_deref() == Some(source),
                "AUTOMATION_EVENT_SOURCE_MISMATCH"
            );
            let sequence = facts["inboxSequence"]
                .as_u64()
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_EVENT_FACT_INVALID"))?;
            Ok(
                if check_start(data, subscription_id, revision, source, sequence)? {
                    AutomationInboxEventDisposition::New
                } else {
                    AutomationInboxEventDisposition::BeforeStart
                },
            )
        })
    }
    pub fn verify_inbox_source_start(
        &self,
        subscription_id: &str,
        revision: u64,
        source: &str,
        inbox_sequence: u64,
    ) -> Result<()> {
        self.access(false, |data| {
            ensure!(
                check_start(data, subscription_id, revision, source, inbox_sequence)?,
                "AUTOMATION_EVENT_BEFORE_SUBSCRIPTION"
            );
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests;
