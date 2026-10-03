use super::*;
use anyhow::{Context, bail};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const MAX_FLEET_TOOL_LIMIT: usize = 100;
const MAX_FLEET_PROGRESS_MESSAGE_CHARS: usize = 160;
const MAX_FLEET_PROGRESS_DETAIL_CHARS: usize = 512;
const CAPABILITY_FINGERPRINT_PREFIX_CHARS: usize = 12;

impl AppState {
    /// Construct a trusted stable snapshot of current direct sub-agents from AppState and PlanStore.
    ///
    /// A dedicated ordering gate serializes construction so an older PlanStore read cannot
    /// commit its digest after a newer snapshot. Bodies, prompts, environment variables,
    /// and complete capability fingerprints are excluded.
    pub fn snapshot_agent_fleet(
        &self,
        include_terminal: bool,
        cursor: Option<&str>,
        limit: usize,
        max_bytes: usize,
    ) -> anyhow::Result<AgentFleetSnapshot> {
        let _snapshot_order = self
            .fleet_snapshot_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (session_id, cwd, tasks) = {
            let inner = self.read_inner();
            (
                inner.session_id.clone(),
                inner.cwd.clone(),
                inner.tasks.values().cloned().collect::<Vec<_>>(),
            )
        };
        let store = orchestrate_store::PlanStore::for_workspace(&cwd);
        let mut work_revisions = HashMap::<String, anyhow::Result<u64>>::new();
        let mut members = tasks
            .into_iter()
            .filter(|task| {
                task.kind == TaskKind::Subagent
                    && task.parent_session_id.as_deref() == Some(session_id.as_str())
                    && (include_terminal || !is_terminal_task(task.status))
            })
            .map(|task| fleet_member_from_task(&task, &store, &mut work_revisions))
            .collect::<Vec<_>>();
        members.sort_by(|left, right| {
            fleet_status_priority(&left.status)
                .cmp(&fleet_status_priority(&right.status))
                .then_with(|| right.last_activity_at_ms.cmp(&left.last_activity_at_ms))
                .then_with(|| left.agent_id.cmp(&right.agent_id))
        });

        let runtime_audit_degradation = self.orchestrate_runtime_audit_degradation();
        let runtime_audit_status = if runtime_audit_degradation.is_some() {
            "degraded"
        } else {
            "healthy"
        }
        .to_string();
        let digest_sha256 = fleet_digest(
            &session_id,
            &runtime_audit_status,
            runtime_audit_degradation.as_deref(),
            &members,
        )?;
        let fleet_revision = {
            let mut inner = self.write_inner();
            if inner.last_fleet_digest.as_deref() != Some(digest_sha256.as_str()) {
                inner.fleet_revision = inner.fleet_revision.saturating_add(1);
                inner.last_fleet_digest = Some(digest_sha256.clone());
            }
            inner.fleet_revision
        };

        let offset = parse_fleet_cursor(cursor, &digest_sha256)?;
        if offset > members.len() {
            bail!("AgentFleet cursor offset exceeds the current snapshot");
        }
        let limit = limit.clamp(1, MAX_FLEET_TOOL_LIMIT);
        let max_bytes = max_bytes.max(512);
        let mut page = Vec::new();
        let mut page_bytes = 0usize;
        for member in members.iter().skip(offset).take(limit) {
            let member_bytes = serde_json::to_vec(member)
                .context("failed to size AgentFleet member")?
                .len();
            if !page.is_empty() && page_bytes.saturating_add(member_bytes) > max_bytes {
                break;
            }
            page_bytes = page_bytes.saturating_add(member_bytes);
            page.push(member.clone());
        }
        let consumed = offset.saturating_add(page.len());
        let next_cursor = (consumed < members.len()).then(|| format!("{digest_sha256}:{consumed}"));
        let omitted_members = members.len().saturating_sub(page.len());

        Ok(AgentFleetSnapshot {
            session_id,
            fleet_revision,
            generated_at_ms: now_millis(),
            runtime_audit_status,
            runtime_audit_degradation,
            members: page,
            omitted_members,
            next_cursor,
            digest_sha256,
        })
    }

    /// Update bounded process-local progress without writing a sidecar for every heartbeat.
    pub fn record_agent_runtime_progress(&self, id: &str, progress: BoundedDiagnostic) -> bool {
        let mut inner = self.write_inner();
        let Some(task) = inner.tasks.get_mut(id) else {
            return false;
        };
        if task.kind != TaskKind::Subagent
            || !matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
        {
            return false;
        }
        task.updated_at_ms = progress.updated_at_ms;
        task.current_progress = Some(bound_progress(progress));
        true
    }

    /// Replace usage with the complete transcript aggregate so continuations do not count historical turns repeatedly.
    pub fn record_agent_usage_summary(
        &self,
        id: &str,
        usage: AgentUsageSummary,
    ) -> anyhow::Result<bool> {
        let updated = self.transact_task(id, |task| {
            if task.kind != TaskKind::Subagent {
                return Ok(false);
            }
            task.usage = usage;
            task.breaker.token_total = task.usage.total_tokens();
            task.updated_at_ms = now_millis();
            Ok(true)
        })?;
        Ok(updated.unwrap_or(false))
    }

    /// Reduce a complete snapshot to a delta from the previous model injection; return None for an identical digest.
    pub fn prepare_agent_fleet_delta(
        &self,
        snapshot: &AgentFleetSnapshot,
    ) -> anyhow::Result<Option<AgentFleetDelta>> {
        let current = snapshot
            .members
            .iter()
            .map(|member| {
                Ok((
                    member.agent_id.clone(),
                    serde_json::to_string(member)
                        .context("failed to encode AgentFleet injection baseline")?,
                ))
            })
            .collect::<anyhow::Result<HashMap<_, _>>>()?;
        let mut inner = self.write_inner();
        if inner.last_injected_fleet_digest.as_deref() == Some(snapshot.digest_sha256.as_str()) {
            return Ok(None);
        }
        let changed_members = snapshot
            .members
            .iter()
            .filter(|member| {
                let encoded = current
                    .get(&member.agent_id)
                    .expect("current Fleet member was encoded");
                inner.last_injected_fleet_members.get(&member.agent_id) != Some(encoded)
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut removed_agent_ids = inner
            .last_injected_fleet_members
            .keys()
            .filter(|agent_id| !current.contains_key(*agent_id))
            .cloned()
            .collect::<Vec<_>>();
        removed_agent_ids.sort();
        inner.last_injected_fleet_digest = Some(snapshot.digest_sha256.clone());
        inner.last_injected_fleet_members = current;
        Ok(Some(AgentFleetDelta {
            fleet_revision: snapshot.fleet_revision,
            digest_sha256: snapshot.digest_sha256.clone(),
            runtime_audit_status: snapshot.runtime_audit_status.clone(),
            runtime_audit_degradation: snapshot.runtime_audit_degradation.clone(),
            changed_members,
            removed_agent_ids,
            omitted_members: snapshot.omitted_members,
        }))
    }
}

fn fleet_member_from_task(
    task: &Task,
    store: &orchestrate_store::PlanStore,
    work_revisions: &mut HashMap<String, anyhow::Result<u64>>,
) -> FleetMemberSnapshot {
    let (plan_revision, plan_revision_status) = match task.orchestrate_work_id.as_deref() {
        Some(work_id) => {
            let result = work_revisions
                .entry(work_id.to_string())
                .or_insert_with(|| {
                    store
                        .read_work(work_id)
                        .map(|snapshot| snapshot.work.revision)
                });
            match result {
                Ok(revision) => (Some(*revision), "available".to_string()),
                Err(_) => (None, "unavailable".to_string()),
            }
        }
        None => (None, "not_bound".to_string()),
    };
    let leased_message_id = task.message_queue.iter().find_map(|message| {
        (message.status == AgentMessageStatus::Leased).then(|| message.message_id.clone())
    });
    let queue_attempts = task
        .message_queue
        .first()
        .map(|message| message.attempts)
        .unwrap_or(0);

    FleetMemberSnapshot {
        agent_id: task.id.clone(),
        persona: task.roster_name.clone(),
        agent_kind: task
            .agent_kind
            .clone()
            .unwrap_or_else(|| "general".to_string()),
        status: fleet_task_status(task),
        control_mode: run_mode_name(task.control.run_mode).to_string(),
        orchestrate_work_id: task.orchestrate_work_id.clone(),
        plan_revision,
        plan_revision_status,
        queue_depth: task.message_queue.len(),
        leased_message_id,
        last_activity_at_ms: Some(task.updated_at_ms),
        current_progress: task.current_progress.clone().map(bound_progress),
        consecutive_failures: task.breaker.consecutive_runtime_errors.max(queue_attempts),
        breaker_stage: breaker_stage_name(task.breaker.stage).to_string(),
        usage: task.usage.clone(),
        worktree_state: worktree_state(task),
        capability_fingerprint_prefix: task
            .resolved_profile_fingerprint
            .as_deref()
            .map(|value| {
                value
                    .chars()
                    .take(CAPABILITY_FINGERPRINT_PREFIX_CHARS)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn fleet_task_status(task: &Task) -> String {
    match task.control.run_mode {
        AgentRunMode::Paused => return "paused".to_string(),
        AgentRunMode::Halted => return "halted".to_string(),
        AgentRunMode::PauseRequested => return "pause_requested".to_string(),
        AgentRunMode::HaltRequested => return "halt_requested".to_string(),
        AgentRunMode::Running => {}
    }
    if task
        .message_queue
        .first()
        .is_some_and(|message| message.status == AgentMessageStatus::Blocked)
    {
        return "blocked".to_string();
    }
    match task.status {
        TaskStatus::Pending => "pending",
        TaskStatus::Running => "running",
        TaskStatus::Paused => "paused",
        TaskStatus::Halted => "halted",
        TaskStatus::Completed => "completed",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
    }
    .to_string()
}

fn fleet_status_priority(status: &str) -> u8 {
    match status {
        "running" | "pending" | "blocked" | "paused" | "pause_requested" | "halt_requested" => 0,
        "halted" => 1,
        _ => 2,
    }
}

fn run_mode_name(mode: AgentRunMode) -> &'static str {
    match mode {
        AgentRunMode::Running => "running",
        AgentRunMode::PauseRequested => "pause_requested",
        AgentRunMode::Paused => "paused",
        AgentRunMode::HaltRequested => "halt_requested",
        AgentRunMode::Halted => "halted",
    }
}

fn breaker_stage_name(stage: BreakerStage) -> &'static str {
    match stage {
        BreakerStage::Healthy => "healthy",
        BreakerStage::Steered => "steered",
        BreakerStage::Constrained => "constrained",
        BreakerStage::Paused => "paused",
        BreakerStage::Halted => "halted",
    }
}

fn is_terminal_task(status: TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Halted | TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
    )
}

fn worktree_state(task: &Task) -> String {
    let Some(path) = task.worktree_path.as_deref() else {
        return "none".to_string();
    };
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => "available".to_string(),
        Ok(_) => "invalid".to_string(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "missing".to_string(),
        Err(_) => "unavailable".to_string(),
    }
}

fn bound_progress(mut progress: BoundedDiagnostic) -> BoundedDiagnostic {
    progress.message = truncate_chars(&progress.message, MAX_FLEET_PROGRESS_MESSAGE_CHARS);
    progress.detail = progress
        .detail
        .map(|detail| truncate_chars(&detail, MAX_FLEET_PROGRESS_DETAIL_CHARS));
    progress
}

fn truncate_chars(value: &str, limit: usize) -> String {
    let count = value.chars().count();
    if count <= limit {
        return value.to_string();
    }
    let mut truncated = value
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    truncated.push('…');
    truncated
}

fn fleet_digest(
    session_id: &str,
    runtime_audit_status: &str,
    runtime_audit_degradation: Option<&str>,
    members: &[FleetMemberSnapshot],
) -> anyhow::Result<String> {
    let payload = serde_json::to_vec(&(
        session_id,
        runtime_audit_status,
        runtime_audit_degradation,
        members,
    ))
    .context("failed to serialize AgentFleet digest payload")?;
    Ok(format!("{:x}", Sha256::digest(payload)))
}

fn parse_fleet_cursor(cursor: Option<&str>, digest: &str) -> anyhow::Result<usize> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    let Some((cursor_digest, offset)) = cursor.rsplit_once(':') else {
        bail!("invalid AgentFleet cursor");
    };
    if cursor_digest != digest {
        bail!("stale AgentFleet cursor; request a fresh first page");
    }
    offset
        .parse::<usize>()
        .context("invalid AgentFleet cursor offset")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subagent(state: &AppState, id: &str, updated_at_ms: u64) -> Task {
        let mut task = Task::new(id, format!("secret description for {id}"));
        task.kind = TaskKind::Subagent;
        task.managed = true;
        task.status = TaskStatus::Running;
        task.parent_session_id = Some(state.session_id());
        task.updated_at_ms = updated_at_ms;
        task.resolved_profile_fingerprint = Some("abcdef1234567890secret".to_string());
        task
    }

    #[test]
    fn fleet_filters_parent_scope_and_keeps_digest_stable() {
        let state = AppState::new("/tmp/kcoder-fleet-scope");
        state.upsert_task(subagent(&state, "agent-b", 20));
        state.upsert_task(subagent(&state, "agent-a", 30));
        let mut foreign = subagent(&state, "agent-foreign", 40);
        foreign.parent_session_id = Some("another-session".to_string());
        state.upsert_task(foreign);

        let first = state.snapshot_agent_fleet(false, None, 24, 8_192).unwrap();
        let second = state.snapshot_agent_fleet(false, None, 24, 8_192).unwrap();
        assert_eq!(first.fleet_revision, second.fleet_revision);
        assert_eq!(first.digest_sha256, second.digest_sha256);
        assert_eq!(
            first
                .members
                .iter()
                .map(|member| member.agent_id.as_str())
                .collect::<Vec<_>>(),
            ["agent-a", "agent-b"]
        );
        let encoded = serde_json::to_string(&first).unwrap();
        assert!(!encoded.contains("secret description"));
        assert!(!encoded.contains("7890secret"));
    }

    #[test]
    fn fleet_paginates_with_digest_bound_cursor() {
        let state = AppState::new("/tmp/kcoder-fleet-page");
        for index in 0..30 {
            state.upsert_task(subagent(&state, &format!("agent-{index:02}"), index));
        }
        let first = state.snapshot_agent_fleet(false, None, 24, 32_768).unwrap();
        assert_eq!(first.members.len(), 24);
        assert_eq!(first.omitted_members, 6);
        let second = state
            .snapshot_agent_fleet(false, first.next_cursor.as_deref(), 24, 32_768)
            .unwrap();
        assert_eq!(second.members.len(), 6);
        assert!(second.next_cursor.is_none());
        assert_eq!(first.digest_sha256, second.digest_sha256);
    }

    #[test]
    fn fleet_revision_changes_only_with_observable_digest() {
        let state = AppState::new("/tmp/kcoder-fleet-revision");
        state.upsert_task(subagent(&state, "agent-a", 10));
        let first = state.snapshot_agent_fleet(false, None, 24, 8_192).unwrap();
        assert!(state.record_agent_runtime_progress(
            "agent-a",
            BoundedDiagnostic {
                message: "cargo test".to_string(),
                detail: None,
                current: Some(1),
                total: Some(2),
                updated_at_ms: 11,
            }
        ));
        let changed = state.snapshot_agent_fleet(false, None, 24, 8_192).unwrap();
        assert_eq!(changed.fleet_revision, first.fleet_revision + 1);
        let stable = state.snapshot_agent_fleet(false, None, 24, 8_192).unwrap();
        assert_eq!(stable.fleet_revision, changed.fleet_revision);
    }

    #[test]
    fn fleet_delta_is_not_repeated_and_reports_removal() {
        let state = AppState::new("/tmp/kcoder-fleet-delta");
        state.upsert_task(subagent(&state, "agent-a", 10));
        let first = state.snapshot_agent_fleet(false, None, 24, 8_192).unwrap();
        let delta = state.prepare_agent_fleet_delta(&first).unwrap().unwrap();
        assert_eq!(delta.changed_members.len(), 1);
        assert!(state.prepare_agent_fleet_delta(&first).unwrap().is_none());

        state.remove_task("agent-a");
        let empty = state.snapshot_agent_fleet(false, None, 24, 8_192).unwrap();
        let removed = state.prepare_agent_fleet_delta(&empty).unwrap().unwrap();
        assert_eq!(removed.removed_agent_ids, ["agent-a"]);
    }
}
