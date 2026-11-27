//! `patterns.json`: distilled patterns behind proposals (plan section 8).
//!
//! Distillation records every pattern of a run under the target it was
//! distilled for, with the support code recomputed from the evidence and
//! the scope code decided. Pattern ids are chosen per run by the model, so
//! they are only unique within one target; a later run that reuses an id
//! replaces that entry with its latest support. `evolution/target/read`
//! shows the target's entries. `clear_all` removes the file with the rest
//! of the scope.

use crate::error::Result;
use crate::store::{EvolutionStore, read_versioned_in, write_json_in};
use kcoder_types::evolution::{EvolutionPattern, TargetKey, validate_evolution_id};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const PATTERNS_FILE: &str = "patterns.json";
const PATTERNS_VERSION: u32 = 1;
/// Patterns kept per target; the least recently updated go first.
pub const PATTERNS_PER_TARGET_MAX: usize = 64;
/// Targets with patterns; the least recently updated target goes first.
pub const PATTERN_TARGETS_MAX: usize = 1000;
/// Characters of a stored pattern statement.
pub const PATTERN_STATEMENT_MAX_CHARS: usize = 500;
const PATTERN_EVIDENCE_MAX: usize = 64;

/// One distilled pattern with the evidence that supports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredPattern {
    pub pattern: EvolutionPattern,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence_ids: Vec<String>,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatternDocument {
    pub version: u32,
    /// Increments on every write; `0` means the document does not exist.
    pub revision: u64,
    /// Target key → pattern id → pattern.
    #[serde(default)]
    pub targets: BTreeMap<String, BTreeMap<String, StoredPattern>>,
}

impl Default for PatternDocument {
    fn default() -> Self {
        Self {
            version: PATTERNS_VERSION,
            revision: 0,
            targets: BTreeMap::new(),
        }
    }
}

impl PatternDocument {
    /// Patterns of `key`, most recently updated first.
    pub fn patterns_of(&self, key: &TargetKey) -> Vec<&StoredPattern> {
        let mut patterns: Vec<_> = self
            .targets
            .get(&key.to_string())
            .map(|items| items.values().collect())
            .unwrap_or_default();
        patterns.sort_by(|left, right| {
            right
                .updated_at_ms
                .cmp(&left.updated_at_ms)
                .then_with(|| left.pattern.id.cmp(&right.pattern.id))
        });
        patterns
    }
}

fn newest(items: &BTreeMap<String, StoredPattern>) -> u64 {
    items
        .values()
        .map(|item| item.updated_at_ms)
        .max()
        .unwrap_or(0)
}

impl EvolutionStore {
    pub fn read_patterns(&self) -> Result<PatternDocument> {
        Ok(
            read_versioned_in(self.directory(), PATTERNS_FILE, PATTERNS_VERSION)?
                .unwrap_or_default(),
        )
    }

    /// Record the patterns of one distillation of `key`. Each entry
    /// replaces an earlier one with the same id (latest support wins);
    /// statements must already be redacted and are bounded here. Patterns
    /// with an invalid id are skipped.
    pub fn record_patterns(
        &self,
        key: &TargetKey,
        patterns: &[(EvolutionPattern, Vec<String>)],
        now_ms: u64,
    ) -> Result<()> {
        if patterns.is_empty() {
            return Ok(());
        }
        let _lock = self.lock()?;
        let mut document = self.read_patterns()?;
        let items = document.targets.entry(key.to_string()).or_default();
        for (pattern, evidence_ids) in patterns {
            if validate_evolution_id("patternId", &pattern.id).is_err() {
                continue;
            }
            let mut pattern = pattern.clone();
            pattern.statement = pattern
                .statement
                .chars()
                .take(PATTERN_STATEMENT_MAX_CHARS)
                .collect();
            let mut evidence_ids = evidence_ids.clone();
            evidence_ids.sort();
            evidence_ids.dedup();
            evidence_ids.truncate(PATTERN_EVIDENCE_MAX);
            items.insert(
                pattern.id.clone(),
                StoredPattern {
                    pattern,
                    evidence_ids,
                    updated_at_ms: now_ms,
                },
            );
        }
        while items.len() > PATTERNS_PER_TARGET_MAX {
            let Some(oldest) = items
                .iter()
                .min_by_key(|(id, item)| (item.updated_at_ms, (*id).clone()))
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            items.remove(&oldest);
        }
        while document.targets.len() > PATTERN_TARGETS_MAX {
            let Some(oldest) = document
                .targets
                .iter()
                .min_by_key(|(target, items)| (newest(items), (*target).clone()))
                .map(|(target, _)| target.clone())
            else {
                break;
            };
            document.targets.remove(&oldest);
        }
        document.version = PATTERNS_VERSION;
        document.revision += 1;
        write_json_in(self.directory(), PATTERNS_FILE, &document)
    }
}
