//! `state.json`: background job run times, cursors and monthly usage, so a
//! restarted process continues schedules instead of restarting timers.

use crate::error::Result;
use crate::store::{EvolutionStore, read_versioned_in, write_json_in};
use crate::time::month_key;
use kcoder_types::evolution::{EvolutionMonthUsage, TargetKey};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const STATE_FILE: &str = "state.json";
const STATE_VERSION: u32 = 1;

/// Last run and opaque cursor of one named job.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// Counters at a target's last distillation, used by [`crate::distill_due`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistillCursor {
    pub observed_usages: u64,
    pub conflicts: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at_ms: Option<u64>,
    /// Evidence ids of user edits to this target's overlay since the last
    /// distillation (explicit signals; newest last, bounded).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub user_edit_evidence: Vec<String>,
    /// Evidence ids of background-review findings and notes about this
    /// target (model judgement: candidate lessons, never support).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub review_findings: Vec<String>,
}

/// Most user-edit evidence ids kept per target between distillations.
pub const USER_EDIT_EVIDENCE_MAX: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionState {
    pub version: u32,
    /// Increments on every write.
    pub revision: u64,
    #[serde(default)]
    pub jobs: BTreeMap<String, JobRecord>,
    #[serde(default)]
    pub distill: BTreeMap<TargetKey, DistillCursor>,
    #[serde(default)]
    pub month_usage: EvolutionMonthUsage,
}

impl Default for EvolutionState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            revision: 0,
            jobs: BTreeMap::new(),
            distill: BTreeMap::new(),
            month_usage: EvolutionMonthUsage::default(),
        }
    }
}

impl EvolutionState {
    /// Usage of the month containing `now_ms`; a stored older month reads
    /// as zero.
    pub fn month_usage_at(&self, now_ms: u64) -> EvolutionMonthUsage {
        let month = month_key(now_ms);
        if self.month_usage.month == month {
            self.month_usage.clone()
        } else {
            EvolutionMonthUsage {
                month,
                ..Default::default()
            }
        }
    }

    /// Whether the optional monthly token limit is used up.
    pub fn usage_limit_reached(&self, now_ms: u64, monthly_max_tokens: Option<u64>) -> bool {
        monthly_max_tokens.is_some_and(|limit| self.month_usage_at(now_ms).total_tokens() >= limit)
    }
}

impl EvolutionStore {
    pub fn read_state(&self) -> Result<EvolutionState> {
        Ok(read_versioned_in(self.directory(), STATE_FILE, STATE_VERSION)?.unwrap_or_default())
    }

    /// Read-modify-write under the scope lock.
    pub fn update_state(&self, apply: impl FnOnce(&mut EvolutionState)) -> Result<EvolutionState> {
        let _lock = self.lock()?;
        let mut state = self.read_state()?;
        apply(&mut state);
        state.version = STATE_VERSION;
        state.revision += 1;
        write_json_in(self.directory(), STATE_FILE, &state)?;
        Ok(state)
    }

    /// Record the last run of a named job.
    pub fn record_job_run(&self, job: &str, cursor: Option<String>, now_ms: u64) -> Result<()> {
        kcoder_types::evolution::validate_evolution_id("job", job)?;
        self.update_state(|state| {
            let record = state.jobs.entry(job.to_string()).or_default();
            record.last_run_at_ms = Some(now_ms);
            record.cursor = cursor;
        })?;
        Ok(())
    }

    /// Add evolution model token usage to the current month.
    pub fn record_model_usage(
        &self,
        now_ms: u64,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Result<EvolutionMonthUsage> {
        let state = self.update_state(|state| {
            let mut usage = state.month_usage_at(now_ms);
            usage.input_tokens = usage.input_tokens.saturating_add(input_tokens);
            usage.output_tokens = usage.output_tokens.saturating_add(output_tokens);
            state.month_usage = usage;
        })?;
        Ok(state.month_usage)
    }
}
