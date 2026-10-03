use super::*;
use anyhow::{Context, bail};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const RUNTIME_EVENT_SCHEMA_VERSION: u32 = 1;
const RUNTIME_EVENT_FILE: &str = "runtime-events.jsonl";
const RUNTIME_DIAGNOSTIC_FILE: &str = "orchestrate-runtime-diagnostics.json";
const GENESIS_HASH: &str = "genesis";

/// Orchestration runtime audit policy. Event logs are diagnostic only and cannot replace sidecar or PlanStore state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrchestrateRuntimeAuditPolicy {
    pub enabled: bool,
    pub max_events: usize,
    pub max_event_bytes: usize,
}

impl Default for OrchestrateRuntimeAuditPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            max_events: 4_096,
            max_event_bytes: 4_096,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrchestrateRuntimeEvent {
    pub schema_version: u32,
    pub event_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub occurred_at_ms: u64,
    pub kind: String,
    pub metadata: Value,
    /// After rotation, the first record stores the final hash of the removed prefix in this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_anchor_sha256: Option<String>,
    pub previous_event_sha256: String,
    pub event_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrchestrateRuntimeDiagnosticExport {
    pub schema_version: u32,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_audit_degradation: Option<String>,
    pub current_state_summary: Value,
    /// Counts and current-state gauges aggregated from the retained audit window, excluding message bodies and high-cardinality IDs.
    pub runtime_metrics: BTreeMap<String, u64>,
    pub events: Vec<OrchestrateRuntimeEvent>,
}

impl AppState {
    /// Update runtime audit policy; this API does not write user settings.
    pub fn configure_orchestrate_runtime_audit(
        &self,
        enabled: bool,
        max_events: usize,
        max_event_bytes: usize,
    ) {
        *self
            .runtime_audit_policy
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = OrchestrateRuntimeAuditPolicy {
            enabled,
            max_events: max_events.clamp(1, 65_536),
            max_event_bytes: max_event_bytes.clamp(512, 65_536),
        };
        if !enabled {
            *self
                .runtime_audit_degradation
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        }
    }

    /// Append a redacted event after core state commits successfully.
    ///
    /// Failure means diagnostic infrastructure degraded. Callers must neither undo
    /// nor deny committed AppState/PlanStore facts, and must not make the model retry the original business action.
    #[allow(clippy::too_many_arguments)]
    pub fn record_orchestrate_runtime_event(
        &self,
        kind: &str,
        work_id: Option<&str>,
        task_id: Option<&str>,
        agent_id: Option<&str>,
        message_id: Option<&str>,
        metadata: Value,
    ) -> anyhow::Result<Option<OrchestrateRuntimeEvent>> {
        let policy = *self
            .runtime_audit_policy
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !policy.enabled || !self.session_mode().is_orchestrate() {
            return Ok(None);
        }
        let path = self
            .orchestrate_runtime_event_path()
            .context("Orchestrate runtime event path is unavailable before session persistence")?;
        validate_event_kind(kind)?;
        let metadata = sanitize_metadata(metadata, policy.max_event_bytes)?;
        let _audit = self
            .runtime_audit_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut events = read_runtime_events(&path)?;
        verify_runtime_event_chain(&events)?;
        let previous_event_sha256 = events
            .last()
            .map(|event| event.event_sha256.clone())
            .unwrap_or_else(|| GENESIS_HASH.to_string());
        let mut event = OrchestrateRuntimeEvent {
            schema_version: RUNTIME_EVENT_SCHEMA_VERSION,
            event_id: format!("evt-{}", uuid::Uuid::new_v4()),
            session_id: self.session_id(),
            work_id: bounded_identifier(work_id),
            task_id: bounded_identifier(task_id),
            agent_id: bounded_identifier(agent_id),
            message_id: bounded_identifier(message_id),
            occurred_at_ms: now_millis(),
            kind: kind.to_string(),
            metadata,
            chain_anchor_sha256: None,
            previous_event_sha256,
            event_sha256: String::new(),
        };
        event.event_sha256 = event_hash(&event)?;
        events.push(event.clone());

        if events.len() > policy.max_events {
            let remove_count = events.len().saturating_sub(policy.max_events);
            let removed_tail_hash = events[remove_count - 1].event_sha256.clone();
            events.drain(..remove_count);
            rebuild_rotated_chain(&mut events, removed_tail_hash)?;
            event = events
                .last()
                .cloned()
                .context("rotated event journal is empty")?;
            write_runtime_events_atomic(&path, &events)?;
        } else {
            append_runtime_event(&path, &event)?;
        }
        Ok(Some(event))
    }

    pub fn read_orchestrate_runtime_events(&self) -> anyhow::Result<Vec<OrchestrateRuntimeEvent>> {
        let Some(path) = self.orchestrate_runtime_event_path() else {
            return Ok(Vec::new());
        };
        let _audit = self
            .runtime_audit_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let events = read_runtime_events(&path)?;
        verify_runtime_event_chain(&events)?;
        Ok(events)
    }

    /// Unified audit sink after core-fact commits. Failure marks diagnostic degradation only and never asks callers to replay business actions.
    #[allow(clippy::too_many_arguments)]
    pub fn record_orchestrate_runtime_event_after_commit(
        &self,
        kind: &str,
        work_id: Option<&str>,
        task_id: Option<&str>,
        agent_id: Option<&str>,
        message_id: Option<&str>,
        metadata: Value,
    ) -> bool {
        match self.record_orchestrate_runtime_event(
            kind, work_id, task_id, agent_id, message_id, metadata,
        ) {
            Ok(_) => {
                *self
                    .runtime_audit_degradation
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                true
            }
            Err(error) => {
                let diagnostic =
                    format!("核心状态已提交，但 runtime audit 事件 {kind} 写入失败：{error:#}")
                        .chars()
                        .take(1_024)
                        .collect::<String>();
                *self
                    .runtime_audit_degradation
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(diagnostic.clone());
                warn!(
                    "Orchestrate core state committed but runtime audit degraded for {kind}: {error:#}"
                );
                false
            }
        }
    }

    /// Return audit degradation from the most recent core-state commit; a later successful event write clears it.
    pub fn orchestrate_runtime_audit_degradation(&self) -> Option<String> {
        self.runtime_audit_degradation
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Export only redacted events and bounded state summaries, excluding message bodies, prompts, environment variables, and tool input.
    pub fn export_orchestrate_runtime_diagnostics(
        &self,
    ) -> anyhow::Result<OrchestrateRuntimeDiagnosticExport> {
        let tasks = self
            .tasks()
            .into_values()
            .filter(|task| task.parent_session_id.as_deref() == Some(self.session_id().as_str()))
            .map(|task| {
                serde_json::json!({
                    "agent_id": task.id,
                    "status": format!("{:?}", task.status).to_ascii_lowercase(),
                    "queue_depth": task.message_queue.len(),
                    "dead_letter_depth": task.dead_letter_messages.len(),
                    "control_revision": task.control.revision,
                    "control_mode": format!("{:?}", task.control.run_mode).to_ascii_lowercase(),
                    "breaker_stage": format!("{:?}", task.breaker.stage).to_ascii_lowercase(),
                    "updated_at_ms": task.updated_at_ms,
                })
            })
            .collect::<Vec<_>>();
        let events = match self.read_orchestrate_runtime_events() {
            Ok(events) => events,
            Err(error) => {
                let diagnostic = format!("runtime audit journal 无法读取或校验：{error:#}")
                    .chars()
                    .take(1_024)
                    .collect::<String>();
                *self
                    .runtime_audit_degradation
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(diagnostic);
                Vec::new()
            }
        };
        let runtime_metrics = runtime_metrics(&events, tasks.len());
        Ok(OrchestrateRuntimeDiagnosticExport {
            schema_version: RUNTIME_EVENT_SCHEMA_VERSION,
            session_id: self.session_id(),
            runtime_audit_degradation: self.orchestrate_runtime_audit_degradation(),
            current_state_summary: serde_json::json!({"agents": tasks}),
            runtime_metrics,
            events,
        })
    }

    /// Write a redacted diagnostic export to the current session's managed directory and return its actual path.
    ///
    /// The target filename is fixed and cannot be redirected by model or user input.
    /// Atomic replacement does not follow an existing target symlink, and final Unix permissions are restricted to `0600`.
    pub fn write_orchestrate_runtime_diagnostics(&self) -> anyhow::Result<PathBuf> {
        let session_state_path = self
            .session_state_path()
            .context("session persistence is unavailable; start a persisted session first")?;
        let parent = session_state_path
            .parent()
            .context("session state path has no parent directory")?;
        let path = parent.join(RUNTIME_DIAGNOSTIC_FILE);
        let export = self.export_orchestrate_runtime_diagnostics()?;
        let bytes = serde_json::to_vec_pretty(&export)?;
        write_bytes_atomic(&path, &bytes)
            .with_context(|| format!("failed to write Orchestrate diagnostics to {path:?}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        }
        Ok(path)
    }

    fn orchestrate_runtime_event_path(&self) -> Option<PathBuf> {
        self.session_state_path()
            .and_then(|path| path.parent().map(|parent| parent.join(RUNTIME_EVENT_FILE)))
    }
}

fn validate_event_kind(kind: &str) -> anyhow::Result<()> {
    const KINDS: &[&str] = &[
        "agent_spawned",
        "agent_status_changed",
        "agent_closed",
        "message_queued",
        "message_leased",
        "message_prepared",
        "message_acknowledged",
        "message_requeued",
        "message_blocked",
        "message_dead_lettered",
        "control_requested",
        "control_applied",
        "control_rejected",
        "breaker_transition",
        "continuation_claimed",
        "continuation_finished",
        "continuation_blocked",
        "plan_task_accepted",
        "plan_task_rejected",
        "evidence_recorded",
        "critic_vote_recorded",
        "human_decision_recorded",
        "fleet_injected",
        "infrastructure_error",
    ];
    if !KINDS.contains(&kind) {
        bail!("unsupported Orchestrate runtime event kind {kind:?}");
    }
    Ok(())
}

fn runtime_metrics(
    events: &[OrchestrateRuntimeEvent],
    current_fleet_members: usize,
) -> BTreeMap<String, u64> {
    fn increment(metrics: &mut BTreeMap<String, u64>, name: String, amount: u64) {
        let value = metrics.entry(name).or_default();
        *value = (*value).saturating_add(amount);
    }

    let mut metrics = BTreeMap::new();
    metrics.insert(
        "orchestrate_fleet_snapshot_members".to_string(),
        u64::try_from(current_fleet_members).unwrap_or(u64::MAX),
    );
    for event in events {
        match event.kind.as_str() {
            "message_queued" => increment(
                &mut metrics,
                "orchestrate_delivery_queued_total".to_string(),
                1,
            ),
            "message_requeued" => {
                increment(
                    &mut metrics,
                    "orchestrate_delivery_retried_total".to_string(),
                    1,
                );
                if event.metadata.get("source").and_then(Value::as_str) == Some("lease_expired") {
                    increment(
                        &mut metrics,
                        "orchestrate_delivery_lease_expired_total".to_string(),
                        1,
                    );
                }
            }
            "message_blocked" => increment(
                &mut metrics,
                "orchestrate_delivery_blocked_total".to_string(),
                1,
            ),
            "message_dead_lettered" => increment(
                &mut metrics,
                "orchestrate_delivery_dead_letter_total".to_string(),
                1,
            ),
            "control_requested" => {
                let action = bounded_metric_label(&event.metadata, "action", "unknown");
                increment(
                    &mut metrics,
                    format!("orchestrate_control_requested_total{{action={action}}}"),
                    1,
                );
            }
            "control_rejected" => {
                let reason = bounded_metric_label(&event.metadata, "reason", "unknown");
                increment(
                    &mut metrics,
                    format!("orchestrate_control_rejected_total{{reason={reason}}}"),
                    1,
                );
            }
            "breaker_transition" => {
                let from = bounded_metric_label(&event.metadata, "from", "unknown");
                let to = bounded_metric_label(&event.metadata, "to", "unknown");
                let reason = event
                    .metadata
                    .get("reason_codes")
                    .and_then(Value::as_array)
                    .and_then(|values| values.first())
                    .and_then(Value::as_str)
                    .map(sanitize_metric_label)
                    .unwrap_or_else(|| "unknown".to_string());
                increment(
                    &mut metrics,
                    format!(
                        "orchestrate_breaker_transition_total{{from={from},to={to},reason={reason}}}"
                    ),
                    1,
                );
            }
            "fleet_injected" => {
                let bytes = event
                    .metadata
                    .get("bytes")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                increment(
                    &mut metrics,
                    "orchestrate_fleet_injection_bytes".to_string(),
                    bytes,
                );
            }
            "continuation_blocked" => {
                let reason = bounded_metric_label(&event.metadata, "reason", "unknown");
                increment(
                    &mut metrics,
                    format!("orchestrate_manual_intervention_total{{reason={reason}}}"),
                    1,
                );
            }
            _ => {}
        }
    }
    metrics
}

fn bounded_metric_label(metadata: &Value, key: &str, fallback: &str) -> String {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(sanitize_metric_label)
        .unwrap_or_else(|| fallback.to_string())
}

fn sanitize_metric_label(value: &str) -> String {
    let normalized = value
        .chars()
        .take(64)
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if normalized.is_empty() {
        "unknown".to_string()
    } else {
        normalized
    }
}

fn bounded_identifier(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(256).collect())
}

fn sanitize_metadata(metadata: Value, max_event_bytes: usize) -> anyhow::Result<Value> {
    fn sanitize(value: Value, key: Option<&str>, depth: usize) -> Value {
        if depth > 6 {
            return Value::String("[truncated depth]".to_string());
        }
        if key.is_some_and(is_sensitive_key) {
            return Value::String("[redacted]".to_string());
        }
        match value {
            Value::Object(values) => Value::Object(
                values
                    .into_iter()
                    .take(64)
                    .map(|(key, value)| {
                        let value = sanitize(value, Some(&key), depth + 1);
                        (key.chars().take(128).collect(), value)
                    })
                    .collect::<Map<_, _>>(),
            ),
            Value::Array(values) => Value::Array(
                values
                    .into_iter()
                    .take(64)
                    .map(|value| sanitize(value, None, depth + 1))
                    .collect(),
            ),
            Value::String(value) => {
                if looks_sensitive(&value) {
                    Value::String("[redacted]".to_string())
                } else {
                    Value::String(value.chars().take(1_024).collect())
                }
            }
            other => other,
        }
    }
    let sanitized = sanitize(metadata, None, 0);
    let bytes = serde_json::to_vec(&sanitized)?;
    if bytes.len() <= max_event_bytes {
        return Ok(sanitized);
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    Ok(serde_json::json!({
        "truncated": true,
        "original_bytes": bytes.len(),
        "sha256": digest,
    }))
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "secret",
        "token",
        "credential",
        "authorization",
        "api_key",
        "api-key",
        "environment",
        "env",
        "prompt",
        "body",
        "message",
        "command",
        "input",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

fn looks_sensitive(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("authorization:")
        || lower.contains("bearer ")
        || lower.contains("token=")
        || lower.contains("api_key")
        || value.trim_start().starts_with("sk-")
}

fn event_hash(event: &OrchestrateRuntimeEvent) -> anyhow::Result<String> {
    let mut unsigned = event.clone();
    unsigned.event_sha256.clear();
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&unsigned)?)
    ))
}

fn verify_runtime_event_chain(events: &[OrchestrateRuntimeEvent]) -> anyhow::Result<()> {
    let mut previous = GENESIS_HASH.to_string();
    for (index, event) in events.iter().enumerate() {
        if event.schema_version != RUNTIME_EVENT_SCHEMA_VERSION {
            bail!("unsupported runtime event schema {}", event.schema_version);
        }
        if index == 0
            && let Some(anchor) = event.chain_anchor_sha256.as_deref()
        {
            previous = format!("rotation:{anchor}");
        }
        if event.previous_event_sha256 != previous {
            bail!("runtime event chain mismatch at record {}", index + 1);
        }
        if event_hash(event)? != event.event_sha256 {
            bail!("runtime event hash mismatch at record {}", index + 1);
        }
        previous = event.event_sha256.clone();
    }
    Ok(())
}

fn rebuild_rotated_chain(
    events: &mut [OrchestrateRuntimeEvent],
    removed_tail_hash: String,
) -> anyhow::Result<()> {
    let mut previous = format!("rotation:{removed_tail_hash}");
    for (index, event) in events.iter_mut().enumerate() {
        event.chain_anchor_sha256 = (index == 0).then(|| removed_tail_hash.clone());
        event.previous_event_sha256 = previous;
        event.event_sha256 = event_hash(event)?;
        previous = event.event_sha256.clone();
    }
    Ok(())
}

fn read_runtime_events(path: &Path) -> anyhow::Result<Vec<OrchestrateRuntimeEvent>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("runtime event journal must not be a symlink")
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    }
    let bytes = fs::read(path)?;
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        bail!("runtime event journal has a damaged trailing record");
    }
    bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).map_err(Into::into))
        .collect()
}

fn append_runtime_event(path: &Path, event: &OrchestrateRuntimeEvent) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("runtime event journal must not be a symlink")
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("failed to open runtime event journal {path:?}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    serde_json::to_writer(&mut file, event)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn write_runtime_events_atomic(
    path: &Path,
    events: &[OrchestrateRuntimeEvent],
) -> anyhow::Result<()> {
    let mut bytes = Vec::new();
    for event in events {
        serde_json::to_writer(&mut bytes, event)?;
        bytes.push(b'\n');
    }
    write_bytes_atomic(path, &bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn orchestrate_state(temp: &TempDir) -> AppState {
        let state = AppState::new(temp.path());
        state.with_history_path(temp.path().join("session.jsonl"));
        state.enter_orchestrate_before_first_message().unwrap();
        state
    }

    #[test]
    fn event_journal_redacts_secrets_and_verifies_hash_chain() {
        let temp = TempDir::new().unwrap();
        let state = orchestrate_state(&temp);
        state
            .record_orchestrate_runtime_event(
                "message_queued",
                Some("work-1"),
                None,
                Some("agent-1"),
                Some("msg-1"),
                serde_json::json!({
                    "queue_depth": 1,
                    "body": "never persist this",
                    "credential": "sk-super-secret",
                }),
            )
            .unwrap();
        let events = state.read_orchestrate_runtime_events().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].metadata["body"], "[redacted]");
        assert_eq!(events[0].metadata["credential"], "[redacted]");
        assert_eq!(events[0].previous_event_sha256, GENESIS_HASH);
    }

    #[test]
    fn rotation_keeps_a_verifiable_chain_anchor() {
        let temp = TempDir::new().unwrap();
        let state = orchestrate_state(&temp);
        state.configure_orchestrate_runtime_audit(true, 2, 4_096);
        for index in 0..3 {
            state
                .record_orchestrate_runtime_event(
                    "agent_status_changed",
                    None,
                    None,
                    Some("agent-1"),
                    None,
                    serde_json::json!({"sequence": index}),
                )
                .unwrap();
        }
        let events = state.read_orchestrate_runtime_events().unwrap();
        assert_eq!(events.len(), 2);
        assert!(events[0].chain_anchor_sha256.is_some());
        assert!(events[0].previous_event_sha256.starts_with("rotation:"));
    }

    #[test]
    fn diagnostic_export_contains_only_state_summaries() {
        let temp = TempDir::new().unwrap();
        let state = orchestrate_state(&temp);
        let mut task = Task::new("agent-export", "secret task prompt");
        task.kind = TaskKind::Subagent;
        task.parent_session_id = Some(state.session_id());
        task.message_queue
            .push(QueuedAgentMessage::new("secret message"));
        state.upsert_task(task);
        let export = state.export_orchestrate_runtime_diagnostics().unwrap();
        let encoded = serde_json::to_string(&export).unwrap();
        assert!(!encoded.contains("secret task prompt"));
        assert!(!encoded.contains("secret message"));
        assert!(encoded.contains("queue_depth"));
    }

    #[test]
    fn diagnostic_export_aggregates_retained_runtime_metrics() {
        let temp = TempDir::new().unwrap();
        let state = orchestrate_state(&temp);
        for (kind, metadata) in [
            ("message_queued", serde_json::json!({})),
            (
                "message_requeued",
                serde_json::json!({"source": "lease_expired"}),
            ),
            ("control_requested", serde_json::json!({"action": "pause"})),
            (
                "breaker_transition",
                serde_json::json!({
                    "from": "healthy",
                    "to": "steered",
                    "reason_codes": ["repeated_action"],
                }),
            ),
            ("fleet_injected", serde_json::json!({"bytes": 321})),
        ] {
            state
                .record_orchestrate_runtime_event(kind, None, None, None, None, metadata)
                .unwrap();
        }

        let export = state.export_orchestrate_runtime_diagnostics().unwrap();
        assert_eq!(
            export.runtime_metrics["orchestrate_delivery_queued_total"],
            1
        );
        assert_eq!(
            export.runtime_metrics["orchestrate_delivery_retried_total"],
            1
        );
        assert_eq!(
            export.runtime_metrics["orchestrate_delivery_lease_expired_total"],
            1
        );
        assert_eq!(
            export.runtime_metrics["orchestrate_control_requested_total{action=pause}"],
            1
        );
        assert_eq!(
            export.runtime_metrics["orchestrate_fleet_injection_bytes"],
            321
        );
    }

    #[test]
    fn diagnostic_export_writes_only_to_the_managed_session_directory() {
        let temp = TempDir::new().unwrap();
        let state = orchestrate_state(&temp);
        let path = state.write_orchestrate_runtime_diagnostics().unwrap();
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some(RUNTIME_DIAGNOSTIC_FILE)
        );
        assert_eq!(path.parent(), state.session_state_path().unwrap().parent());
        let export: OrchestrateRuntimeDiagnosticExport =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(export.session_id, state.session_id());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn audit_write_failure_is_explicit_in_diagnostics_and_fleet() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let state = orchestrate_state(&temp);
        let journal = state.orchestrate_runtime_event_path().unwrap();
        symlink(temp.path().join("outside-events.jsonl"), &journal).unwrap();

        assert!(!state.record_orchestrate_runtime_event_after_commit(
            "agent_spawned",
            None,
            None,
            Some("agent-degraded"),
            None,
            serde_json::json!({"status": "running"}),
        ));
        let degradation = state
            .orchestrate_runtime_audit_degradation()
            .expect("audit failure must remain observable");
        assert!(degradation.contains("核心状态已提交"));

        let fleet = state.snapshot_agent_fleet(false, None, 24, 8_192).unwrap();
        assert_eq!(fleet.runtime_audit_status, "degraded");
        assert_eq!(fleet.runtime_audit_degradation, Some(degradation));

        let export = state.export_orchestrate_runtime_diagnostics().unwrap();
        assert!(export.events.is_empty());
        assert!(export.runtime_audit_degradation.is_some());
    }
}
