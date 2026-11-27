//! Bounded host command metadata projection; queue authority remains in task_state.
use super::*;
use crate::model::AgentCommandReceipt;

impl AppState {
    /// Project only the latest owned command metadata, without copying outputs or command bodies.
    pub fn recent_subagent_control_receipts(
        &self,
        limit: usize,
    ) -> Vec<(String, AgentCommandReceipt)> {
        let inner = self.read_inner();
        let limit = limit.clamp(1, 8);
        let mut recent = Vec::new();
        for task in inner.tasks.values().filter(|task| {
            task.kind == TaskKind::Subagent
                && task.parent_session_id.as_deref() == Some(inner.session_id.as_str())
        }) {
            for receipt in &task.command_receipts {
                recent.push((task, receipt));
                recent.sort_unstable_by(|left, right| {
                    right
                        .1
                        .accepted_at_ms
                        .cmp(&left.1.accepted_at_ms)
                        .then_with(|| left.0.id.cmp(&right.0.id))
                        .then_with(|| left.1.client_message_id.cmp(&right.1.client_message_id))
                });
                recent.truncate(limit);
            }
        }
        recent
            .into_iter()
            .map(|(task, receipt)| {
                let status = task
                    .message_queue
                    .iter()
                    .chain(&task.dead_letter_messages)
                    .find(|message| message.message_id == receipt.message_id)
                    .map_or(receipt.status, |message| message.status);
                (
                    task.id.clone(),
                    AgentCommandReceipt {
                        client_message_id: receipt.client_message_id.clone(),
                        message_id: receipt.message_id.clone(),
                        body_sha256: receipt.body_sha256.clone(),
                        body_summary: String::new(),
                        status,
                        accepted_at_ms: receipt.accepted_at_ms,
                        applied_at_ms: receipt.applied_at_ms,
                        background_run: receipt.background_run.clone(),
                        applied_background_run: receipt.applied_background_run.clone(),
                    },
                )
            })
            .collect()
    }

    /// Read-only host preflight; enqueue repeats this check under its transaction lock.
    pub fn validate_subagent_command_client_id(
        &self,
        id: &str,
        client_id: &str,
    ) -> anyhow::Result<()> {
        self.ensure_subagent_command_receipts_readable()?;
        let task = self.task(id).context("agent_not_found_or_not_owned")?;
        crate::task_state::validate_command_epoch(client_id, task.command_receipt_epoch)
    }
}
