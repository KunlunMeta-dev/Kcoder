use super::*;

impl PlanStore {
    pub fn claim_auto_continuation(
        &self,
        work_id: &str,
        expected_revision: u64,
        max_auto_turns: u32,
    ) -> anyhow::Result<ContinuationClaim> {
        let current = self.read_work(work_id)?;
        if current.work.revision != expected_revision {
            return Err(PlanStoreError::RevisionConflict {
                expected: expected_revision,
                current: current.work.revision,
            }
            .into());
        }
        let work_dir = self.work_dir(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let current = self.read_work(work_id)?;
        if current.work.revision != expected_revision {
            return Err(PlanStoreError::RevisionConflict {
                expected: expected_revision,
                current: current.work.revision,
            }
            .into());
        }
        let mut continuation = self.read_continuation_state_unlocked(&work_dir)?;
        if continuation.in_flight {
            return Ok(ContinuationClaim {
                snapshot: current,
                claimed: false,
                manual_intervention_newly_required: false,
            });
        }
        if continuation.auto_turn_count >= max_auto_turns {
            if continuation.manual_intervention_required {
                return Ok(ContinuationClaim {
                    snapshot: current,
                    claimed: false,
                    manual_intervention_newly_required: false,
                });
            }
            continuation.manual_intervention_required = true;
            continuation.stop_reason = Some("manual_intervention_required".to_string());
            write_json_atomic(&work_dir.join("continuation-state.json"), &continuation)?;
            return Ok(ContinuationClaim {
                snapshot: current,
                claimed: false,
                manual_intervention_newly_required: true,
            });
        }
        if continuation.auto_turn_count > 0 {
            if continuation.last_completed_items == Some(current.work.progress.completed) {
                continuation.stalled_rounds = continuation.stalled_rounds.saturating_add(1);
            } else {
                continuation.stalled_rounds = 0;
            }
        }
        continuation.last_completed_items = Some(current.work.progress.completed);
        continuation.auto_turn_count = continuation.auto_turn_count.saturating_add(1);
        continuation.last_claimed_at = Some(Utc::now());
        continuation.in_flight = true;
        write_json_atomic(&work_dir.join("continuation-state.json"), &continuation)?;
        sync_directory(&work_dir)?;
        Ok(ContinuationClaim {
            snapshot: current,
            claimed: true,
            manual_intervention_newly_required: false,
        })
    }

    pub fn reset_auto_continuation_after_user_input(
        &self,
        work_id: &str,
        expected_revision: u64,
    ) -> anyhow::Result<WorkSnapshot> {
        let snapshot = self.read_work(work_id)?;
        if snapshot.work.revision != expected_revision {
            return Err(PlanStoreError::RevisionConflict {
                expected: expected_revision,
                current: snapshot.work.revision,
            }
            .into());
        }
        let work_dir = self.work_dir(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        write_json_atomic(
            &work_dir.join("continuation-state.json"),
            &ContinuationState::default(),
        )?;
        sync_directory(&work_dir)?;
        Ok(snapshot)
    }

    pub fn read_continuation_state(&self, work_id: &str) -> anyhow::Result<ContinuationState> {
        self.read_work(work_id)?;
        self.read_continuation_state_unlocked(&self.work_dir(work_id)?)
    }

    pub fn record_continuation_outcome(
        &self,
        work_id: &str,
        failed: bool,
    ) -> anyhow::Result<ContinuationState> {
        let work_dir = self.work_dir(work_id)?;
        self.read_work(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let mut continuation = self.read_continuation_state_unlocked(&work_dir)?;
        if !continuation.in_flight {
            return Ok(continuation);
        }
        continuation.consecutive_failures = if failed {
            continuation.consecutive_failures.saturating_add(1)
        } else {
            0
        };
        continuation.in_flight = false;
        write_json_atomic(&work_dir.join("continuation-state.json"), &continuation)?;
        sync_directory(&work_dir)?;
        Ok(continuation)
    }

    /// Persist the automatic-continuation stop reason; true means the caller should emit the single visible notice.
    pub fn require_manual_intervention(&self, work_id: &str, reason: &str) -> anyhow::Result<bool> {
        let work_dir = self.work_dir(work_id)?;
        self.read_work(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let mut continuation = self.read_continuation_state_unlocked(&work_dir)?;
        if continuation.manual_intervention_required {
            return Ok(false);
        }
        continuation.manual_intervention_required = true;
        continuation.stop_reason = Some(reason.to_string());
        write_json_atomic(&work_dir.join("continuation-state.json"), &continuation)?;
        sync_directory(&work_dir)?;
        Ok(true)
    }

    pub(super) fn read_continuation_state_unlocked(
        &self,
        work_dir: &Path,
    ) -> anyhow::Result<ContinuationState> {
        let path = work_dir.join("continuation-state.json");
        if path.exists() {
            read_json_no_follow(&path)
        } else {
            Ok(ContinuationState::default())
        }
    }
}
