use super::*;

impl PlanStore {
    pub fn append_evidence(
        &self,
        work_id: &str,
        mut evidence: AgentEvidence,
    ) -> anyhow::Result<AgentEvidence> {
        let snapshot = self.read_work(work_id)?;
        if evidence.work_id != work_id
            || evidence.revision != snapshot.work.revision
            || evidence.plan_sha256 != snapshot.work.plan_sha256
        {
            bail!("evidence identity does not match the current work revision");
        }
        if evidence.evidence_id.is_empty() {
            evidence.evidence_id = format!("evidence_{}", Uuid::new_v4());
        }
        let work_dir = self.work_dir(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        // Recheck after locking to prevent TOCTOU between revision switching and evidence append.
        let current = self.read_work(work_id)?;
        if current.work.revision != evidence.revision
            || current.work.plan_sha256 != evidence.plan_sha256
        {
            return Err(PlanStoreError::RevisionConflict {
                expected: evidence.revision,
                current: current.work.revision,
            }
            .into());
        }
        evidence.recorded_at = Utc::now();
        let mut line = serde_json::to_vec(&evidence)?;
        if line.len() > 64 * 1024 {
            bail!("evidence record exceeds 64 KiB");
        }
        line.push(b'\n');
        let path = work_dir.join("evidence.jsonl");
        let mut file = open_append_no_follow(&path)?;
        file.write_all(&line)?;
        file.sync_all()?;
        sync_directory(&work_dir)?;
        Ok(evidence)
    }

    pub fn append_task_session(
        &self,
        work_id: &str,
        mut record: TaskSessionRecord,
    ) -> anyhow::Result<TaskSessionRecord> {
        if record.agent_id.trim().is_empty()
            || record.parent_session_id.trim().is_empty()
            || record.profile_fingerprint.trim().is_empty()
        {
            bail!("task session audit requires agent, parent session, and profile fingerprint");
        }
        let snapshot = self.read_work(work_id)?;
        if snapshot.work.revision != record.plan_revision {
            return Err(PlanStoreError::RevisionConflict {
                expected: record.plan_revision,
                current: snapshot.work.revision,
            }
            .into());
        }
        let work_dir = self.work_dir(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let current = self.read_work(work_id)?;
        if current.work.revision != record.plan_revision {
            return Err(PlanStoreError::RevisionConflict {
                expected: record.plan_revision,
                current: current.work.revision,
            }
            .into());
        }
        record.recorded_at = Utc::now();
        let mut line = serde_json::to_vec(&record)?;
        if line.len() > 16 * 1024 {
            bail!("task session audit record exceeds 16 KiB");
        }
        line.push(b'\n');
        let mut file = open_append_no_follow(&work_dir.join("task-sessions.jsonl"))?;
        file.write_all(&line)?;
        file.sync_all()?;
        sync_directory(&work_dir)?;
        Ok(record)
    }

    pub fn read_task_sessions(&self, work_id: &str) -> anyhow::Result<Vec<TaskSessionRecord>> {
        self.read_work(work_id)?;
        let path = self.work_dir(work_id)?.join("task-sessions.jsonl");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let bytes = read_bytes_no_follow(&path)?;
        if !bytes.ends_with(b"\n") {
            bail!("task session audit has a damaged trailing record");
        }
        bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).map_err(Into::into))
            .collect()
    }

    /// Append a runtime-authenticated user decision. Identical decision ID/content is idempotent; conflicting content fails closed.
    pub fn append_human_decision(
        &self,
        work_id: &str,
        mut record: HumanDecisionRecord,
    ) -> anyhow::Result<HumanDecisionRecord> {
        if record.actor != DecisionActor::User
            || record.work_id != work_id
            || record.decision_id.trim().is_empty()
            || record.question_id.trim().is_empty()
            || record.answer_summary.trim().is_empty()
        {
            bail!("invalid runtime-authenticated human decision record");
        }
        record.answer_summary = record.answer_summary.chars().take(2_048).collect();
        let work_dir = self.work_dir(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let current = self.read_work(work_id)?;
        record.stale = current.work.revision != record.plan_revision;
        record.recorded_at = Utc::now();
        let existing = self.read_human_decisions_unlocked(&work_dir)?;
        if let Some(saved) = existing
            .iter()
            .find(|saved| saved.decision_id == record.decision_id)
        {
            let mut comparable = record.clone();
            comparable.recorded_at = saved.recorded_at;
            if saved == &comparable {
                return Ok(saved.clone());
            }
            bail!(
                "human decision id {} already has different content",
                record.decision_id
            );
        }
        if let Some(supersedes) = record.supersedes.as_deref()
            && !existing.iter().any(|saved| saved.decision_id == supersedes)
        {
            bail!("human decision supersedes unknown record {supersedes}");
        }
        let mut line = serde_json::to_vec(&record)?;
        if line.len() > 8 * 1024 {
            bail!("human decision record exceeds 8 KiB");
        }
        line.push(b'\n');
        let mut file = open_append_no_follow(&work_dir.join("human-decisions.jsonl"))?;
        file.write_all(&line)?;
        file.sync_all()?;
        sync_directory(&work_dir)?;
        Ok(record)
    }

    pub fn read_human_decisions(&self, work_id: &str) -> anyhow::Result<Vec<HumanDecisionRecord>> {
        self.read_work(work_id)?;
        self.read_human_decisions_unlocked(&self.work_dir(work_id)?)
    }

    pub(super) fn read_human_decisions_unlocked(
        &self,
        work_dir: &Path,
    ) -> anyhow::Result<Vec<HumanDecisionRecord>> {
        let path = work_dir.join("human-decisions.jsonl");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let bytes = read_bytes_no_follow(&path)?;
        if !bytes.ends_with(b"\n") {
            bail!("human decision audit has a damaged trailing record");
        }
        bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).map_err(Into::into))
            .collect()
    }

    pub fn read_evidence(&self, work_id: &str) -> anyhow::Result<EvidenceReadResult> {
        self.read_work(work_id)?;
        let path = self.work_dir(work_id)?.join("evidence.jsonl");
        if !path.exists() {
            return Ok(EvidenceReadResult {
                records: Vec::new(),
                degraded_trailing_record: false,
            });
        }
        let bytes = read_bytes_no_follow(&path)?;
        let trailing_complete = bytes.ends_with(b"\n");
        let lines = bytes.split(|byte| *byte == b'\n').collect::<Vec<_>>();
        let mut records = Vec::new();
        let mut degraded = false;
        for (index, line) in lines.iter().enumerate() {
            if line.is_empty() {
                continue;
            }
            match serde_json::from_slice::<AgentEvidence>(line) {
                Ok(record) => records.push(record),
                Err(_) if index == lines.len() - 1 && !trailing_complete => degraded = true,
                Err(error) => bail!("corrupt evidence record {}: {error}", index + 1),
            }
        }
        Ok(EvidenceReadResult {
            records,
            degraded_trailing_record: degraded,
        })
    }

    pub fn evidence_by_id(
        &self,
        work_id: &str,
        evidence_id: &str,
    ) -> anyhow::Result<Option<AgentEvidence>> {
        Ok(self
            .read_evidence(work_id)?
            .records
            .into_iter()
            .find(|record| record.evidence_id == evidence_id))
    }

    pub fn record_critic_review(
        &self,
        work_id: &str,
        expected_revision: u64,
        expected_plan_sha256: &str,
        outcome: CriticReviewOutcome,
        max_rejects: usize,
        max_infrastructure_retries: usize,
    ) -> anyhow::Result<CriticReviewState> {
        let snapshot = self.read_work(work_id)?;
        if snapshot.work.revision != expected_revision
            || snapshot.work.plan_sha256 != expected_plan_sha256
        {
            return Err(PlanStoreError::RevisionConflict {
                expected: expected_revision,
                current: snapshot.work.revision,
            }
            .into());
        }
        let work_dir = self.work_dir(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let current = self.read_work(work_id)?;
        if current.work.revision != expected_revision
            || current.work.plan_sha256 != expected_plan_sha256
        {
            return Err(PlanStoreError::RevisionConflict {
                expected: expected_revision,
                current: current.work.revision,
            }
            .into());
        }
        let path = work_dir.join("review-state.json");
        let mut state = if path.exists() {
            let saved: CriticReviewState = read_json_no_follow(&path)?;
            if saved.revision == expected_revision && saved.plan_sha256 == expected_plan_sha256 {
                saved
            } else {
                new_critic_review_state(work_id, expected_revision, expected_plan_sha256)
            }
        } else {
            new_critic_review_state(work_id, expected_revision, expected_plan_sha256)
        };
        if state.automatic_review_stopped {
            bail!("automatic critic review already reached its configured limit");
        }
        match outcome {
            CriticReviewOutcome::Okay => {
                state.approved = true;
                state.automatic_review_stopped = true;
            }
            CriticReviewOutcome::Reject => {
                state.reject_count = state.reject_count.saturating_add(1);
                state.rejected_exhausted = state.reject_count >= max_rejects.max(1);
                state.automatic_review_stopped = state.rejected_exhausted;
            }
            CriticReviewOutcome::InfrastructureError => {
                state.infrastructure_retry_count =
                    state.infrastructure_retry_count.saturating_add(1);
                state.review_unavailable =
                    state.infrastructure_retry_count >= max_infrastructure_retries;
                state.automatic_review_stopped = state.review_unavailable;
            }
        }
        state.updated_at = Utc::now();
        write_json_atomic(&path, &state)?;
        sync_directory(&work_dir)?;
        Ok(state)
    }

    pub fn read_critic_review_state(
        &self,
        work_id: &str,
    ) -> anyhow::Result<Option<CriticReviewState>> {
        self.read_work(work_id)?;
        let path = self.work_dir(work_id)?.join("review-state.json");
        path.exists()
            .then(|| read_json_no_follow(&path))
            .transpose()
    }
}
