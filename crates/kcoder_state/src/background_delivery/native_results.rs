//! Private original Subagent result outbox stored in the owning session sidecar.
//!
//! A slot is reserved before its worker's admission gate opens. The original
//! native worker must supply its terminal and body; notifications, output paths,
//! caller-supplied IDs, restored tasks and same-name later runs are not proof.
//! Work-item association and consumption remain separate host-verified steps.

use super::*;
use kcoder_types::{
    TurnAttemptIdentity,
    continuous_work::terminal_evidence::{
        BackgroundPayloadState, BackgroundTerminalEvidence, MAX_BACKGROUND_TERMINAL_PAYLOAD_BYTES,
    },
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    io::Read,
    path::Path,
};

const VERSION: u32 = 1;
const MAX_SLOTS: usize = 256;
const CAPACITY_BYTES: u64 = 64 * 1024 * 1024;
const SLOT_OVERHEAD_BYTES: u64 = 32 * 1024;
const MAX_SESSION_SIDECAR_BYTES: u64 = 256 * 1024 * 1024;

/// Raw future data remains readable and is not erased by older code. Debugging
/// a session must never print the private result body.
#[derive(Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct PrivateNativeOutbox(Box<serde_json::value::RawValue>);
impl fmt::Debug for PrivateNativeOutbox {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PrivateNativeOutbox { data: [private] }")
    }
}

impl PrivateNativeOutbox {
    /// Decode once for session recovery. No payload is retained in this index.
    /// A malformed or future outbox is handled as unknown by the caller.
    pub(crate) fn recovery_scope(&self) -> anyhow::Result<NativeSubagentRecoveryScope> {
        let outbox = Outbox::decode(Some(self))?;
        let mut scope = NativeSubagentRecoveryScope::default();
        for slot in outbox.slots.into_values() {
            match slot.run {
                Some(run) => {
                    scope.runs.insert(run);
                }
                None => {
                    scope.unbound_sessions.insert(slot.parent_attempt.thread_id);
                }
            }
        }
        Ok(scope)
    }
}

#[derive(Default)]
pub(crate) struct NativeSubagentRecoveryScope {
    runs: BTreeSet<BackgroundRunKey>,
    unbound_sessions: BTreeSet<String>,
}

impl NativeSubagentRecoveryScope {
    pub(crate) fn may_own_run(&self, run: &BackgroundRunKey) -> bool {
        // An unbound reservation cannot be attributed to one specific child.
        self.runs.contains(run) || self.unbound_sessions.contains(&run.parent_session_id)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Outbox {
    version: u32,
    slots: BTreeMap<String, Slot>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Slot {
    parent_attempt: TurnAttemptIdentity,
    parent_tool_call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    run: Option<BackgroundRunKey>,
    max_payload_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    terminal: Option<StoredTerminal>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredTerminal {
    evidence: BackgroundTerminalEvidence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    payload_json: Option<String>,
}

impl Default for Outbox {
    fn default() -> Self {
        Self {
            version: VERSION,
            slots: BTreeMap::new(),
        }
    }
}

fn atom(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn load_owned_sidecar(
    path: &Path,
) -> anyhow::Result<crate::session_persistence::PersistedSessionState> {
    let parent = path.parent().context("NATIVE_RESULT_SOURCE_UNAVAILABLE")?;
    let name = path
        .file_name()
        .context("NATIVE_RESULT_SOURCE_UNAVAILABLE")?;
    let directory = kcoder_config::PrivateDirectory::open_existing(parent)?;
    let file = directory.open_single_link_regular_file(name)?;
    anyhow::ensure!(
        file.metadata()?.len() <= MAX_SESSION_SIDECAR_BYTES,
        "NATIVE_RESULT_SIDECAR_TOO_LARGE"
    );
    let mut bytes = Vec::new();
    file.take(MAX_SESSION_SIDECAR_BYTES + 1)
        .read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_SESSION_SIDECAR_BYTES,
        "NATIVE_RESULT_SIDECAR_TOO_LARGE"
    );
    let text = std::str::from_utf8(&bytes).context("NATIVE_RESULT_SIDECAR_INVALID")?;
    crate::session_persistence::parse_session_state(path, text)
}

fn charge(max_payload_bytes: u64) -> anyhow::Result<u64> {
    anyhow::ensure!(
        max_payload_bytes > 0 && max_payload_bytes <= MAX_BACKGROUND_TERMINAL_PAYLOAD_BYTES,
        "NATIVE_RESULT_RESERVATION_INVALID"
    );
    max_payload_bytes
        .checked_mul(2)
        .and_then(|n| n.checked_add(SLOT_OVERHEAD_BYTES))
        .context("NATIVE_RESULT_CAPACITY_EXCEEDED")
}

impl Outbox {
    fn decode(raw: Option<&PrivateNativeOutbox>) -> anyhow::Result<Self> {
        let outbox = match raw {
            Some(raw) => {
                serde_json::from_str(raw.0.get()).context("NATIVE_RESULT_OUTBOX_UNAVAILABLE")?
            }
            None => Self::default(),
        };
        outbox.validate()?;
        Ok(outbox)
    }

    fn encode(&self) -> anyhow::Result<PrivateNativeOutbox> {
        self.validate()?;
        Ok(PrivateNativeOutbox(serde_json::value::to_raw_value(self)?))
    }

    fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.version == VERSION && self.slots.len() <= MAX_SLOTS,
            "NATIVE_RESULT_OUTBOX_UNAVAILABLE"
        );
        let mut charged = 0u64;
        let mut runs = BTreeSet::new();
        let mut calls = BTreeSet::new();
        for (id, slot) in &self.slots {
            slot.parent_attempt.validate().map_err(anyhow::Error::msg)?;
            anyhow::ensure!(
                atom(&slot.parent_attempt.thread_id)
                    && atom(&slot.parent_attempt.turn_id)
                    && atom(&slot.parent_attempt.attempt_id)
                    && atom(&slot.parent_tool_call_id)
                    && uuid::Uuid::parse_str(id).is_ok(),
                "NATIVE_RESULT_ORIGIN_INVALID"
            );
            anyhow::ensure!(
                calls.insert(serde_json::to_string(&(
                    &slot.parent_attempt,
                    &slot.parent_tool_call_id,
                ))?),
                "NATIVE_RESULT_DISPATCH_DUPLICATE"
            );
            if let Some(run) = &slot.run {
                anyhow::ensure!(
                    atom(&run.agent_id)
                        && atom(&run.run_id)
                        && run.parent_session_id == slot.parent_attempt.thread_id
                        && runs.insert(serde_json::to_string(run)?),
                    "NATIVE_RESULT_ORIGIN_INVALID"
                );
            }
            charged = charged
                .checked_add(charge(slot.max_payload_bytes)?)
                .context("NATIVE_RESULT_CAPACITY_EXCEEDED")?;
            if let Some(terminal) = &slot.terminal {
                validate_terminal(slot, terminal)?;
            }
        }
        anyhow::ensure!(
            charged <= CAPACITY_BYTES && serde_json::to_vec(self)?.len() as u64 <= CAPACITY_BYTES,
            "NATIVE_RESULT_CAPACITY_EXCEEDED"
        );
        Ok(())
    }
}

fn validate_terminal(slot: &Slot, terminal: &StoredTerminal) -> anyhow::Result<()> {
    let evidence = &terminal.evidence;
    evidence
        .validate_for_storage()
        .map_err(anyhow::Error::msg)?;
    let run = slot.run.as_ref().context("NATIVE_RESULT_RUN_UNAVAILABLE")?;
    anyhow::ensure!(
        evidence.event == BackgroundEventIdentity::terminal(run.clone()),
        "NATIVE_RESULT_TERMINAL_MISMATCH"
    );
    match (
        &evidence.payload_state,
        evidence.payload.as_ref(),
        terminal.payload_json.as_deref(),
    ) {
        (BackgroundPayloadState::Captured, Some(reference), Some(body)) => {
            anyhow::ensure!(
                body.len() as u64 <= slot.max_payload_bytes
                    && body.len() as u64 == reference.bytes
                    && format!("{:x}", Sha256::digest(body.as_bytes())) == reference.sha256,
                "NATIVE_RESULT_PAYLOAD_MISMATCH"
            );
            let _: Value = serde_json::from_str(body).context("NATIVE_RESULT_PAYLOAD_INVALID")?;
        }
        (
            BackgroundPayloadState::NotProvided
            | BackgroundPayloadState::TooLarge
            | BackgroundPayloadState::Unencodable
            | BackgroundPayloadState::Unsupported,
            None,
            None,
        ) => {}
        _ => anyhow::bail!("NATIVE_RESULT_PAYLOAD_MISMATCH"),
    }
    Ok(())
}

/// Process-local original-session witness. It is not serializable or cloneable
/// and grants no permission to create a work item or dispatch a tool.
pub struct NativeSubagentResultCapacity {
    lifecycle: crate::AppStateLifecycleIdentity,
    source: crate::history_store::HistorySourceIdentity,
    parent_attempt: TurnAttemptIdentity,
    parent_tool_call_id: String,
    id: String,
    max_payload_bytes: u64,
}

impl fmt::Debug for NativeSubagentResultCapacity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NativeSubagentResultCapacity { original_owner: [private] }")
    }
}

pub struct NativeSubagentResultReservation {
    lifecycle: crate::AppStateLifecycleIdentity,
    source: crate::history_store::HistorySourceIdentity,
    parent_attempt: TurnAttemptIdentity,
    parent_tool_call_id: String,
    id: String,
    run: BackgroundRunKey,
    max_payload_bytes: u64,
}

impl NativeSubagentResultReservation {
    pub fn run(&self) -> &BackgroundRunKey {
        &self.run
    }
    pub fn parent_attempt(&self) -> &TurnAttemptIdentity {
        &self.parent_attempt
    }
    pub fn parent_tool_call_id(&self) -> &str {
        &self.parent_tool_call_id
    }
    pub fn max_payload_bytes(&self) -> u64 {
        self.max_payload_bytes
    }
    pub fn matches_state(&self, state: &AppState) -> bool {
        state.inner.read().is_ok_and(|inner| {
            self.lifecycle.matches_locked(state, &inner)
                && inner
                    .history_source
                    .as_ref()
                    .is_some_and(|source| self.source.matches(source))
        })
    }
}

impl fmt::Debug for NativeSubagentResultReservation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NativeSubagentResultReservation { original_owner: [private] }")
    }
}

/// A read-only snapshot. The payload, if present, is private and its receipt
/// does not prove that the original history contains or consumed that body.
pub struct NativeSubagentResultObservation {
    pub parent_attempt: TurnAttemptIdentity,
    pub parent_tool_call_id: String,
    pub run: BackgroundRunKey,
    pub evidence: Option<BackgroundTerminalEvidence>,
    payload_json: Option<String>,
}
impl NativeSubagentResultObservation {
    pub fn private_payload_json(&self) -> Option<&str> {
        self.payload_json.as_deref()
    }
}
impl fmt::Debug for NativeSubagentResultObservation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NativeSubagentResultObservation")
            .field("result", &"[private]")
            .field("terminal_observed", &self.evidence.is_some())
            .finish()
    }
}

impl AppState {
    /// Reserve durable capacity before creating a child run. The native caller
    /// supplies the actual tool call; the attempt comes from the current
    /// task-local history owner. An unresolved reservation is never replayed.
    pub fn reserve_native_subagent_capacity(
        &self,
        parent_tool_call_id: &str,
        max_payload_bytes: u64,
    ) -> anyhow::Result<NativeSubagentResultCapacity> {
        anyhow::ensure!(atom(parent_tool_call_id), "NATIVE_RESULT_ORIGIN_INVALID");
        charge(max_payload_bytes)?;
        let id = uuid::Uuid::new_v4().to_string();
        let _persist = self
            .session_state_persist_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("NATIVE_RESULT_STATE_UNAVAILABLE"))?;
        let inner = self
            .inner
            .write()
            .map_err(|_| anyhow::anyhow!("NATIVE_RESULT_STATE_UNAVAILABLE"))?;
        let parent_attempt = crate::history_append_context::current(self, &inner)
            .context("NATIVE_RESULT_PARENT_ATTEMPT_UNAVAILABLE")?;
        let lifecycle = crate::history_append_context::lifecycle_identity_locked(self, &inner);
        check_direct_history_fault(&inner)?;
        anyhow::ensure!(
            lifecycle.matches_locked(self, &inner),
            "NATIVE_RESULT_SESSION_CHANGED"
        );
        let path = inner
            .session_state_path
            .as_ref()
            .context("NATIVE_RESULT_DURABILITY_UNAVAILABLE")?;
        let source = inner
            .history_source
            .as_ref()
            .context("NATIVE_RESULT_SOURCE_UNAVAILABLE")?;
        source.write_metadata(path, || {
            let mut stored = load_owned_sidecar(path)?;
            let mut outbox = Outbox::decode(stored.native_subagent_outbox.as_ref())?;
            anyhow::ensure!(
                !outbox.slots.contains_key(&id),
                "NATIVE_RESULT_ALREADY_RESERVED"
            );
            outbox.slots.insert(
                id.clone(),
                Slot {
                    parent_attempt: parent_attempt.clone(),
                    parent_tool_call_id: parent_tool_call_id.to_owned(),
                    run: None,
                    max_payload_bytes,
                    terminal: None,
                },
            );
            stored.native_subagent_outbox = Some(outbox.encode()?);
            prepare_session_state_write(path, &stored)
        })?;
        anyhow::ensure!(
            lifecycle.matches_locked(self, &inner),
            "NATIVE_RESULT_SESSION_CHANGED"
        );
        Ok(NativeSubagentResultCapacity {
            lifecycle,
            source: source.identity(),
            parent_attempt,
            parent_tool_call_id: parent_tool_call_id.to_owned(),
            id,
            max_payload_bytes,
        })
    }

    /// Release only a still-unbound capacity token when the owning host has
    /// observed that native child creation was explicitly rejected. This is
    /// not available after the token has been consumed by `bind`.
    pub fn release_native_subagent_capacity(
        &self,
        capacity: NativeSubagentResultCapacity,
    ) -> anyhow::Result<()> {
        let _persist = self
            .session_state_persist_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("NATIVE_RESULT_STATE_UNAVAILABLE"))?;
        let inner = self
            .inner
            .write()
            .map_err(|_| anyhow::anyhow!("NATIVE_RESULT_STATE_UNAVAILABLE"))?;
        check_direct_history_fault(&inner)?;
        anyhow::ensure!(
            capacity.lifecycle.matches_locked(self, &inner),
            "NATIVE_RESULT_SESSION_CHANGED"
        );
        let path = inner
            .session_state_path
            .as_ref()
            .context("NATIVE_RESULT_DURABILITY_UNAVAILABLE")?;
        let source = inner
            .history_source
            .as_ref()
            .context("NATIVE_RESULT_SOURCE_UNAVAILABLE")?;
        anyhow::ensure!(
            capacity.source.matches(source),
            "NATIVE_RESULT_SOURCE_CHANGED"
        );
        source.write_metadata(path, || {
            let mut stored = load_owned_sidecar(path)?;
            let mut outbox = Outbox::decode(stored.native_subagent_outbox.as_ref())?;
            let slot = outbox
                .slots
                .get(&capacity.id)
                .context("NATIVE_RESULT_RESERVATION_UNAVAILABLE")?;
            anyhow::ensure!(
                slot.run.is_none()
                    && slot.terminal.is_none()
                    && slot.parent_attempt == capacity.parent_attempt
                    && slot.parent_tool_call_id == capacity.parent_tool_call_id
                    && slot.max_payload_bytes == capacity.max_payload_bytes,
                "NATIVE_RESULT_RESERVATION_CHANGED"
            );
            outbox.slots.remove(&capacity.id);
            stored.native_subagent_outbox = Some(outbox.encode()?);
            prepare_session_state_write(path, &stored)
        })
    }

    /// Atomically create one new, still-pending native Subagent and bind it to
    /// the exact reserved attempt and tool call. This does not start a worker,
    /// establish host authorization, or release any dispatch gate. Reusing a
    /// task ID or a reservation is rejected, including after an uncertain write.
    pub fn admit_reserved_native_subagent_run(
        &self,
        capacity: &NativeSubagentResultCapacity,
        mut task: Task,
    ) -> anyhow::Result<NativeSubagentResultReservation> {
        anyhow::ensure!(
            atom(&task.id)
                && task.managed
                && task.kind == TaskKind::Subagent
                && task.status == TaskStatus::Pending
                && task.output.is_none()
                && task.background_run.is_none()
                && task.background_runs.is_empty()
                && task.run_started_at_ms.is_none()
                && task
                    .parent_session_id
                    .as_ref()
                    .is_none_or(|value| { value == &capacity.parent_attempt.thread_id })
                && task
                    .parent_tool_call_id
                    .as_ref()
                    .is_none_or(|value| { value == &capacity.parent_tool_call_id }),
            "NATIVE_RESULT_ADMISSION_INVALID"
        );
        let _persist = self
            .session_state_persist_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("NATIVE_RESULT_STATE_UNAVAILABLE"))?;
        let mut inner = self
            .inner
            .write()
            .map_err(|_| anyhow::anyhow!("NATIVE_RESULT_STATE_UNAVAILABLE"))?;
        check_direct_history_fault(&inner)?;
        anyhow::ensure!(
            capacity.lifecycle.matches_locked(self, &inner)
                && capacity.parent_attempt.thread_id == inner.session_id,
            "NATIVE_RESULT_SESSION_CHANGED"
        );
        anyhow::ensure!(
            !inner.tasks.contains_key(&task.id),
            "NATIVE_RESULT_TASK_ALREADY_EXISTS"
        );
        let path = inner
            .session_state_path
            .as_ref()
            .context("NATIVE_RESULT_DURABILITY_UNAVAILABLE")?;
        let source = inner
            .history_source
            .as_ref()
            .context("NATIVE_RESULT_SOURCE_UNAVAILABLE")?;
        anyhow::ensure!(
            capacity.source.matches(source),
            "NATIVE_RESULT_SOURCE_CHANGED"
        );
        let run = BackgroundRunKey {
            parent_session_id: capacity.parent_attempt.thread_id.clone(),
            agent_id: task.id.clone(),
            run_id: uuid::Uuid::new_v4().to_string(),
        };
        source.write_metadata(path, || {
            let mut stored = load_owned_sidecar(path)?;
            anyhow::ensure!(
                !stored.tasks.contains_key(&task.id)
                    && !stored.background_tombstones.contains_key(&task.id),
                "NATIVE_RESULT_TASK_ALREADY_EXISTS"
            );
            anyhow::ensure!(
                stored.background_tombstones.len()
                    + stored
                        .tasks
                        .values()
                        .filter(|value| !value.background_runs.is_empty())
                        .count()
                    < MAX_BACKGROUND_TASK_IDENTITIES,
                "NATIVE_RESULT_TASK_CAPACITY_EXCEEDED"
            );
            let mut outbox = Outbox::decode(stored.native_subagent_outbox.as_ref())?;
            let slot = outbox
                .slots
                .get_mut(&capacity.id)
                .context("NATIVE_RESULT_RESERVATION_UNAVAILABLE")?;
            anyhow::ensure!(
                slot.run.is_none()
                    && slot.terminal.is_none()
                    && slot.parent_attempt == capacity.parent_attempt
                    && slot.parent_tool_call_id == capacity.parent_tool_call_id
                    && slot.max_payload_bytes == capacity.max_payload_bytes,
                "NATIVE_RESULT_RESERVATION_CHANGED"
            );
            task.parent_session_id = Some(capacity.parent_attempt.thread_id.clone());
            task.parent_tool_call_id = Some(capacity.parent_tool_call_id.clone());
            Self::initialize_background_run(&mut task, run.clone())?;
            task.status = TaskStatus::Pending;
            let record = task
                .background_runs
                .last_mut()
                .context("NATIVE_RESULT_RUN_UNAVAILABLE")?;
            record.status = TaskStatus::Pending;
            record.run_started_at_ms = None;
            slot.run = Some(run.clone());
            stored.native_subagent_outbox = Some(outbox.encode()?);
            stored.tasks.insert(task.id.clone(), task.clone());
            prepare_session_state_write(path, &stored)
        })?;
        inner.tasks.insert(task.id.clone(), task);
        Ok(NativeSubagentResultReservation {
            lifecycle: capacity.lifecycle.clone(),
            source: capacity.source.clone(),
            parent_attempt: capacity.parent_attempt.clone(),
            parent_tool_call_id: capacity.parent_tool_call_id.clone(),
            id: capacity.id.clone(),
            run,
            max_payload_bytes: capacity.max_payload_bytes,
        })
    }

    /// Commit one exact native terminal together with its original producer's
    /// bounded result in the same sidecar transaction. The Engine must retain
    /// the original worker witness and must not publish a wakeup until this
    /// returns. A prior exact terminal may be filled in, including a late old
    /// run; a conflicting terminal is never overwritten. This does not consume
    /// the result or grant work, desktop, or tool authority.
    pub fn commit_native_subagent_result(
        &self,
        reservation: &NativeSubagentResultReservation,
        evidence: BackgroundTerminalEvidence,
        payload_json: Option<String>,
    ) -> anyhow::Result<bool> {
        let id = &reservation.id;
        let _persist = self
            .session_state_persist_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("NATIVE_RESULT_STATE_UNAVAILABLE"))?;
        let mut inner = self
            .inner
            .write()
            .map_err(|_| anyhow::anyhow!("NATIVE_RESULT_STATE_UNAVAILABLE"))?;
        check_direct_history_fault(&inner)?;
        anyhow::ensure!(
            reservation.lifecycle.matches_locked(self, &inner),
            "NATIVE_RESULT_SESSION_CHANGED"
        );
        let path = inner
            .session_state_path
            .as_ref()
            .context("NATIVE_RESULT_DURABILITY_UNAVAILABLE")?;
        let source = inner
            .history_source
            .as_ref()
            .context("NATIVE_RESULT_SOURCE_UNAVAILABLE")?;
        anyhow::ensure!(
            reservation.source.matches(source),
            "NATIVE_RESULT_SOURCE_CHANGED"
        );
        let mut committed = false;
        let mut updated_task = None;
        source.write_metadata(path, || {
            let mut stored = load_owned_sidecar(path)?;
            let task = stored
                .tasks
                .get_mut(&reservation.run.agent_id)
                .context("NATIVE_RESULT_RUN_UNAVAILABLE")?;
            let mut matching = task
                .background_runs
                .iter()
                .enumerate()
                .filter_map(|(index, record)| (record.key == reservation.run).then_some(index));
            let index = matching.next().context("NATIVE_RESULT_RUN_UNAVAILABLE")?;
            anyhow::ensure!(matching.next().is_none(), "NATIVE_RESULT_RUN_UNAVAILABLE");
            let record = &task.background_runs[index];
            anyhow::ensure!(
                !record.imported_history && !record.legacy_uncertain,
                "NATIVE_RESULT_TERMINAL_UNAVAILABLE"
            );
            if let Some(existing) = &record.terminal {
                anyhow::ensure!(
                    existing == &evidence.event && record.status == evidence.status,
                    "NATIVE_RESULT_TERMINAL_UNAVAILABLE"
                );
            } else {
                anyhow::ensure!(
                    task.background_run.as_ref() == Some(&reservation.run)
                        && (matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
                            || task.status == evidence.status),
                    "NATIVE_RESULT_TERMINAL_UNAVAILABLE"
                );
                let record = &mut task.background_runs[index];
                record.status = evidence.status.clone();
                record.terminal = Some(evidence.event.clone());
                // A mutable task path or snapshot can belong to another run.
                // Only the separately bound native payload carries this result.
                record.output_path = None;
                record.output_snapshot = None;
                record.delivery = task.delivery;
                task.status = evidence.status.clone();
                task.updated_at_ms = now_millis();
            }
            let mut outbox = Outbox::decode(stored.native_subagent_outbox.as_ref())?;
            let slot = outbox
                .slots
                .get_mut(id)
                .context("NATIVE_RESULT_RESERVATION_UNAVAILABLE")?;
            anyhow::ensure!(
                slot.run.as_ref() == Some(&reservation.run)
                    && slot.parent_attempt == reservation.parent_attempt
                    && slot.parent_tool_call_id == reservation.parent_tool_call_id
                    && slot.max_payload_bytes == reservation.max_payload_bytes,
                "NATIVE_RESULT_RESERVATION_CHANGED"
            );
            let terminal = StoredTerminal {
                evidence,
                payload_json,
            };
            validate_terminal(slot, &terminal)?;
            if let Some(previous) = &slot.terminal {
                anyhow::ensure!(
                    previous.evidence == terminal.evidence
                        && previous.payload_json == terminal.payload_json,
                    "NATIVE_RESULT_TERMINAL_CONFLICT"
                );
            } else {
                slot.terminal = Some(terminal);
                committed = true;
            }
            stored.native_subagent_outbox = Some(outbox.encode()?);
            updated_task = stored.tasks.get(&reservation.run.agent_id).cloned();
            prepare_session_state_write(path, &stored)
        })?;
        if let Some(task) = updated_task {
            inner.tasks.insert(reservation.run.agent_id.clone(), task);
        }
        Ok(committed)
    }

    /// Read one exact run's retained facts. A missing slot or terminal remains
    /// unobserved; the caller must independently verify original work ownership,
    /// source and current control fence before consuming anything.
    pub fn observe_native_subagent_result(
        &self,
        run: &BackgroundRunKey,
    ) -> anyhow::Result<Option<NativeSubagentResultObservation>> {
        let lifecycle = self.inspection_lifecycle_identity();
        let _persist = self
            .session_state_persist_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("NATIVE_RESULT_STATE_UNAVAILABLE"))?;
        let inner = self
            .inner
            .read()
            .map_err(|_| anyhow::anyhow!("NATIVE_RESULT_STATE_UNAVAILABLE"))?;
        check_direct_history_fault(&inner)?;
        anyhow::ensure!(
            lifecycle.matches_locked(self, &inner),
            "NATIVE_RESULT_SESSION_CHANGED"
        );
        let path = inner
            .session_state_path
            .as_ref()
            .context("NATIVE_RESULT_DURABILITY_UNAVAILABLE")?;
        let source = inner
            .history_source
            .as_ref()
            .context("NATIVE_RESULT_SOURCE_UNAVAILABLE")?;
        source.check()?;
        let stored = load_owned_sidecar(path)?;
        source.check()?;
        let outbox = Outbox::decode(stored.native_subagent_outbox.as_ref())?;
        let Some(slot) = outbox
            .slots
            .values()
            .find(|slot| slot.run.as_ref() == Some(run))
        else {
            return Ok(None);
        };
        anyhow::ensure!(
            slot.run.as_ref() == Some(run) && run.parent_session_id == inner.session_id,
            "NATIVE_RESULT_ORIGIN_INVALID"
        );
        if let Some(terminal) = &slot.terminal {
            let task = stored
                .tasks
                .get(&run.agent_id)
                .context("NATIVE_RESULT_RUN_UNAVAILABLE")?;
            let mut matching = task
                .background_runs
                .iter()
                .filter(|record| record.key == *run);
            let record = matching.next().context("NATIVE_RESULT_RUN_UNAVAILABLE")?;
            anyhow::ensure!(
                matching.next().is_none()
                    && !record.imported_history
                    && !record.legacy_uncertain
                    && record.terminal.as_ref() == Some(&terminal.evidence.event)
                    && record.status == terminal.evidence.status,
                "NATIVE_RESULT_TERMINAL_UNAVAILABLE"
            );
        }
        Ok(Some(NativeSubagentResultObservation {
            parent_attempt: slot.parent_attempt.clone(),
            parent_tool_call_id: slot.parent_tool_call_id.clone(),
            run: run.clone(),
            evidence: slot.terminal.as_ref().map(|value| value.evidence.clone()),
            payload_json: slot
                .terminal
                .as_ref()
                .and_then(|value| value.payload_json.clone()),
        }))
    }
}

#[cfg(test)]
#[path = "native_results/tests.rs"]
mod tests;
