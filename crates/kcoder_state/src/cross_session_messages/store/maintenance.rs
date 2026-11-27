use super::*;

/// Queue facts only. This neither authorizes delivery nor decides a writer's outcome.
#[derive(Debug, Clone)]
pub struct CrossSessionMessageMaintenance {
    pub expired_queued: usize,
    pub uncertain_leases: usize,
    pub revision: u64,
    pub next_deadline_ms: Option<u64>,
}
pub(super) struct MaintenanceHint {
    stamp: CrossSessionMessageObservationStamp,
    revision: u64,
    next_deadline_ms: Option<u64>,
}

impl CrossSessionMessageStore {
    /// An owned host tick advances only safe queue facts. A stable stat and a
    /// future deadline avoid body reads/writes; this is never an allow cache.
    pub fn maintain(&self, now_ms: u64) -> Result<CrossSessionMessageMaintenance> {
        ensure!(now_ms > 0, "AGENT_MESSAGE_CLOCK_UNAVAILABLE");
        self.verify()?;
        let mut hint = self
            .maintenance_hint
            .try_lock()
            .map_err(|_| anyhow::anyhow!("AGENT_MESSAGE_BUSY"))?;
        let current = self.observation_stamp()?;
        if let Some(old) = hint.as_ref()
            && old.stamp == current
            && old
                .next_deadline_ms
                .is_none_or(|deadline| now_ms < deadline)
        {
            self.verify()?;
            return Ok(CrossSessionMessageMaintenance {
                expired_queued: 0,
                uncertain_leases: 0,
                revision: old.revision,
                next_deadline_ms: old.next_deadline_ms,
            });
        }
        let (mut report, stamp) =
            self.access_with_archive_observed(true, true, |data, mut archive| {
                let archive_changed = if let Some(tx) = archive.as_deref_mut() {
                    self.maintain_archive(data, tx, now_ms)?
                } else {
                    false
                };
                let revision = next_revision(data)?;
                let mut expired_queued = 0;
                let mut uncertain_leases = 0;
                let mut next_deadline_ms: Option<u64> =
                    data.wake_grace_deadlines.values().copied().min();
                if let Some(tx) = archive
                    && let Some(deadline) = tx.next_payload_deadline()?
                {
                    next_deadline_ms =
                        Some(next_deadline_ms.map_or(deadline, |old| old.min(deadline)));
                }
                for value in data.messages.values_mut() {
                    let deadline = match value.receipt.status {
                        AgentMessageStatus::Queued
                            if value.reservation.is_none() && value.history_uuid.is_none() =>
                        {
                            value.expires_at_ms
                        }
                        AgentMessageStatus::Delivering => {
                            value.reservation.as_ref().map(|lease| lease.deadline_ms)
                        }
                        _ => None,
                    };
                    let Some(deadline) = deadline else {
                        continue;
                    };
                    if now_ms < deadline {
                        next_deadline_ms =
                            Some(next_deadline_ms.map_or(deadline, |old| old.min(deadline)));
                        continue;
                    }
                    if value.receipt.status == AgentMessageStatus::Queued {
                        value.receipt.status = AgentMessageStatus::Expired;
                        value.terminal_at_ms = Some(now_ms);
                        value.receipt.reason_code = Some("message_expired".into());
                        expired_queued += 1;
                    } else {
                        // A past lease is not proof that its original writer did nothing.
                        value.receipt.status = AgentMessageStatus::Unknown;
                        value.receipt.reason_code = Some("delivery_result_unknown".into());
                        uncertain_leases += 1;
                    }
                    value.receipt.revision = revision;
                }
                let changed = expired_queued + uncertain_leases > 0 || archive_changed;
                if changed {
                    data.revision = revision;
                }
                Ok((
                    CrossSessionMessageMaintenance {
                        expired_queued,
                        uncertain_leases,
                        revision: data.revision,
                        next_deadline_ms,
                    },
                    changed,
                ))
            })?;
        // New terminal rows are archived after the action in the same SQL
        // transaction. Include that committed deadline before caching a warm
        // stat, so an empty queue cannot retain its copies indefinitely.
        if let Some(deadline) = self.retained_deadline()? {
            report.next_deadline_ms = Some(
                report
                    .next_deadline_ms
                    .map_or(deadline, |old| old.min(deadline)),
            );
        }
        *hint = Some(MaintenanceHint {
            stamp: stamp.context("AGENT_MESSAGE_OBSERVATION_UNAVAILABLE")?,
            revision: report.revision,
            next_deadline_ms: report.next_deadline_ms,
        });
        Ok(report)
    }
}
