//! Bounded cold-owner hints. Queue facts never grant restore, append or model execution.
use super::*;

impl CrossSessionMessageStore {
    /// Re-read the original trigger after reserving host capacity. Expired
    /// queued messages and unresolved predecessors never authorize activation.
    pub fn cold_wake_trigger_for_target(
        &self,
        target: &str,
    ) -> Result<Option<CrossSessionMessageRecord>> {
        ensure!(valid_agent_message_id(target), "AGENT_MESSAGE_INVALID_ID");
        let id = self.access(false, |data| {
            let now = crate::now_millis().max(data.archive_clock_ms);
            if data.messages.values().any(|row| {
                row.intent.target_thread_id == target
                    && matches!(
                        row.receipt.status,
                        AgentMessageStatus::Unknown | AgentMessageStatus::Delivering
                    )
            }) {
                return Ok((None, false));
            }
            let queued = data
                .messages
                .values()
                .filter(|row| {
                    row.intent.target_thread_id == target
                        && row.receipt.status == AgentMessageStatus::Queued
                        && row.intent.mode == AgentMessageMode::WakeIfIdle
                        && row.intent.expected_turn_id.is_none()
                        && row.expires_at_ms.is_none_or(|deadline| now < deadline)
                })
                .map(|row| (row.sequence, row.receipt.message_id.clone()));
            let applied =
                data.peer_idle_wakes
                    .iter()
                    .filter(|(_, admission)| {
                        admission.thread_id == target
                            && now < admission.deadline_ms
                            && data.peer_wake_budgets.get(target).is_some_and(|budget| {
                                budget.used < crate::DEFAULT_PEER_AUTO_WAKE_LIMIT
                            })
                    })
                    .map(|(id, admission)| (admission.sequence, id.clone()));
            Ok((queued.chain(applied).min().map(|(_, id)| id), false))
        })?;
        id.map(|id| self.get_record_by_message_id(&id))
            .transpose()
            .map(Option::flatten)
    }
    /// Observe only targets with an original pending Wake request or opaque idle
    /// admission. The actual host must recheck source, policy, history and lease.
    /// An unresolved earlier delivery blocks activation instead of being replayed.
    pub fn cold_wake_targets(&self, limit: usize) -> Result<Vec<String>> {
        self.cold_wake_targets_after(limit, None)
    }

    /// Continue a bounded host inventory without letting an unavailable early
    /// target starve later targets. This cursor is a hint, never authority.
    pub fn cold_wake_targets_after(
        &self,
        limit: usize,
        after: Option<&str>,
    ) -> Result<Vec<String>> {
        Ok(self
            .cold_wake_target_generations_after(limit, after)?
            .into_iter()
            .map(|(target, _)| target)
            .collect())
    }

    /// Same bounded inventory, plus each target's newest queued sequence. The
    /// generation changes only when a new message for that target is queued,
    /// so a host can back off a failing wake without being reset by writes for
    /// unrelated targets. It is a scheduling hint, never delivery authority.
    pub fn cold_wake_target_generations_after(
        &self,
        limit: usize,
        after: Option<&str>,
    ) -> Result<Vec<(String, u64)>> {
        ensure!((1..=32).contains(&limit), "PEER_COLD_TARGET_LIMIT");
        ensure!(
            after.is_none_or(valid_agent_message_id),
            "AGENT_MESSAGE_INVALID_ID"
        );
        self.access(false, |data| {
            let now = crate::now_millis().max(data.archive_clock_ms);
            let mut blocked = std::collections::BTreeSet::new();
            let mut candidates = BTreeMap::<String, u64>::new();
            let mut newest = BTreeMap::<String, u64>::new();
            for value in data.messages.values() {
                let target = &value.intent.target_thread_id;
                if value.receipt.status == AgentMessageStatus::Queued {
                    newest
                        .entry(target.clone())
                        .and_modify(|sequence| *sequence = (*sequence).max(value.sequence))
                        .or_insert(value.sequence);
                }
                if matches!(
                    value.receipt.status,
                    AgentMessageStatus::Delivering | AgentMessageStatus::Unknown
                ) {
                    blocked.insert(target.clone());
                }
                if value.receipt.status == AgentMessageStatus::Queued
                    && value.intent.mode == AgentMessageMode::WakeIfIdle
                    && value.intent.expected_turn_id.is_none()
                    && value.expires_at_ms.is_none_or(|deadline| now < deadline)
                {
                    candidates
                        .entry(target.clone())
                        .and_modify(|sequence| *sequence = (*sequence).min(value.sequence))
                        .or_insert(value.sequence);
                }
            }
            for admission in data.peer_idle_wakes.values() {
                if now < admission.deadline_ms
                    && data
                        .peer_wake_budgets
                        .get(&admission.thread_id)
                        .is_some_and(|budget| budget.used < crate::DEFAULT_PEER_AUTO_WAKE_LIMIT)
                {
                    candidates
                        .entry(admission.thread_id.clone())
                        .and_modify(|sequence| *sequence = (*sequence).min(admission.sequence))
                        .or_insert(admission.sequence);
                }
            }
            let mut candidates = candidates
                .into_iter()
                .filter(|(target, _)| !blocked.contains(target))
                .collect::<Vec<_>>();
            candidates.sort_by(|(left, a), (right, b)| (a, left).cmp(&(b, right)));
            let offset = after
                .and_then(|last| candidates.iter().position(|(target, _)| target == last))
                .map_or(0, |index| index + 1);
            Ok((
                candidates
                    .into_iter()
                    .skip(offset)
                    .take(limit)
                    .map(|(target, sequence)| {
                        let generation = newest.get(&target).copied().unwrap_or(sequence);
                        (target, generation.max(sequence))
                    })
                    .collect(),
                false,
            ))
        })
    }
}
