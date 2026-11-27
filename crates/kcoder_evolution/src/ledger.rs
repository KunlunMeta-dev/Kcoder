//! Rollout ledger (`rollout.json`) and the persisted conversation
//! classification queue (`classify-queue.json`).
//!
//! The ledger holds automation facts that are not proposal states:
//! proposals the user approved for evaluation and canary (propose mode),
//! canaries whose promotion waits for the user, evaluation attempts and
//! targets whose base object is archived. The queue keeps classification
//! work across restarts. Both are separate documents so older binaries,
//! which never read them, keep working unchanged.

use crate::error::{EvolutionError, Result};
use crate::store::{EvolutionStore, read_versioned_in, write_json_in};
use kcoder_types::evolution::{TargetKey, validate_evolution_id};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const LEDGER_FILE: &str = "rollout.json";
const LEDGER_VERSION: u32 = 1;
const QUEUE_FILE: &str = "classify-queue.json";
const QUEUE_VERSION: u32 = 1;
/// Most queued classifications kept per scope; the oldest are dropped.
pub const CLASSIFY_QUEUE_MAX: usize = 256;
/// Bytes of each queued text field.
pub const CLASSIFY_QUEUE_TEXT_MAX_BYTES: usize = 2048;
/// Most entries of each ledger map.
const LEDGER_MAX_ENTRIES: usize = 4096;

/// A canary that reached the promotion threshold while promotion needs
/// the user (propose mode or a pinned target).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AwaitingPromotion {
    pub target_key: TargetKey,
    pub probability: f64,
    pub since_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RolloutLedger {
    pub version: u32,
    /// Increments on every write.
    pub revision: u64,
    /// Proposal id → approval time: the user accepted the proposal for
    /// evaluation and canary.
    #[serde(default)]
    pub approved: BTreeMap<String, u64>,
    /// Proposal id → canary waiting for the user's promotion.
    #[serde(default)]
    pub awaiting_promotion: BTreeMap<String, AwaitingPromotion>,
    /// Proposal id → incomplete evaluation attempts.
    #[serde(default)]
    pub eval_attempts: BTreeMap<String, u32>,
    /// Targets whose base object is archived: nothing is staged or served.
    #[serde(default)]
    pub archived_targets: BTreeSet<TargetKey>,
}

impl Default for RolloutLedger {
    fn default() -> Self {
        Self {
            version: LEDGER_VERSION,
            revision: 0,
            approved: BTreeMap::new(),
            awaiting_promotion: BTreeMap::new(),
            eval_attempts: BTreeMap::new(),
            archived_targets: BTreeSet::new(),
        }
    }
}

impl RolloutLedger {
    /// Forget everything about `proposal_id` (it reached a final state).
    pub fn settle(&mut self, proposal_id: &str) {
        self.approved.remove(proposal_id);
        self.awaiting_promotion.remove(proposal_id);
        self.eval_attempts.remove(proposal_id);
    }

    fn bound(&mut self) {
        fn trim<V>(map: &mut BTreeMap<String, V>) {
            while map.len() > LEDGER_MAX_ENTRIES {
                let Some(first) = map.keys().next().cloned() else {
                    break;
                };
                map.remove(&first);
            }
        }
        trim(&mut self.approved);
        trim(&mut self.awaiting_promotion);
        trim(&mut self.eval_attempts);
        while self.archived_targets.len() > LEDGER_MAX_ENTRIES {
            let Some(first) = self.archived_targets.iter().next().cloned() else {
                break;
            };
            self.archived_targets.remove(&first);
        }
    }
}

/// One persisted conversation classification (texts already redacted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueuedClassification {
    pub usage_id: String,
    pub user_text: String,
    pub previous_answer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlay_text: Option<String>,
    #[serde(default)]
    pub concurrent: u32,
    pub queued_at_ms: u64,
}

impl QueuedClassification {
    fn validate(&self) -> Result<()> {
        validate_evolution_id("usageId", &self.usage_id)?;
        let too_long = |text: &str| text.len() > CLASSIFY_QUEUE_TEXT_MAX_BYTES;
        if too_long(&self.user_text)
            || too_long(&self.previous_answer)
            || self.overlay_text.as_deref().is_some_and(too_long)
        {
            return Err(EvolutionError::InvalidContent(
                "queued classification text is too long",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClassificationQueue {
    version: u32,
    #[serde(default)]
    items: Vec<QueuedClassification>,
}

impl EvolutionStore {
    pub fn read_rollout_ledger(&self) -> Result<RolloutLedger> {
        Ok(read_versioned_in(self.directory(), LEDGER_FILE, LEDGER_VERSION)?.unwrap_or_default())
    }

    /// Read-modify-write of the ledger under the scope lock.
    pub fn update_rollout_ledger(
        &self,
        apply: impl FnOnce(&mut RolloutLedger),
    ) -> Result<RolloutLedger> {
        let _lock = self.lock()?;
        let mut ledger = self.read_rollout_ledger()?;
        apply(&mut ledger);
        ledger.bound();
        ledger.version = LEDGER_VERSION;
        ledger.revision += 1;
        write_json_in(self.directory(), LEDGER_FILE, &ledger)?;
        Ok(ledger)
    }

    /// Queued classifications, oldest first.
    pub fn read_classification_queue(&self) -> Result<Vec<QueuedClassification>> {
        Ok(
            read_versioned_in::<ClassificationQueue>(self.directory(), QUEUE_FILE, QUEUE_VERSION)?
                .map(|queue| queue.items)
                .unwrap_or_default(),
        )
    }

    fn write_queue(&self, items: Vec<QueuedClassification>) -> Result<()> {
        write_json_in(
            self.directory(),
            QUEUE_FILE,
            &ClassificationQueue {
                version: QUEUE_VERSION,
                items,
            },
        )
    }

    /// Append classifications (an item already queued for the same usage
    /// is kept, not duplicated). Keeps the newest [`CLASSIFY_QUEUE_MAX`].
    pub fn enqueue_classifications(&self, items: &[QueuedClassification]) -> Result<()> {
        for item in items {
            item.validate()?;
        }
        if items.is_empty() {
            return Ok(());
        }
        let _lock = self.lock()?;
        let mut queue = self.read_classification_queue()?;
        for item in items {
            if !queue.iter().any(|queued| queued.usage_id == item.usage_id) {
                queue.push(item.clone());
            }
        }
        let overflow = queue.len().saturating_sub(CLASSIFY_QUEUE_MAX);
        queue.drain(..overflow);
        self.write_queue(queue)
    }

    /// Remove classified (or discarded) items by usage id.
    pub fn remove_classifications(&self, usage_ids: &[String]) -> Result<()> {
        if usage_ids.is_empty() {
            return Ok(());
        }
        let _lock = self.lock()?;
        let mut queue = self.read_classification_queue()?;
        let before = queue.len();
        queue.retain(|item| !usage_ids.contains(&item.usage_id));
        if queue.len() == before {
            return Ok(());
        }
        self.write_queue(queue)
    }

    /// Drop queued items older than `cutoff_ms`. Returns how many.
    pub fn expire_classifications(&self, cutoff_ms: u64) -> Result<usize> {
        let _lock = self.lock()?;
        let mut queue = self.read_classification_queue()?;
        let before = queue.len();
        queue.retain(|item| item.queued_at_ms >= cutoff_ms);
        let removed = before - queue.len();
        if removed > 0 {
            self.write_queue(queue)?;
        }
        Ok(removed)
    }
}
