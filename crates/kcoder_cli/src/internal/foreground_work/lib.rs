//! Continuous-work admission and original input application.

#[path = "automatic.rs"]
pub mod automatic;
#[path = "../../app_server/continuous_work_mutation.rs"]
pub mod continuous_work_mutation;
#[path = "../../app_server/continuous_work_read.rs"]
pub mod continuous_work_read;
use anyhow::{Context, Result, ensure};
use kcoder_cli_storage::{private_files::hex_sha256, session_lease::DeferredSessionLeaseWitness};
#[cfg(test)]
use kcoder_cli_support::tui_dev_mock;
use kcoder_engine::{EngineEvent, QueryEngine};
use kcoder_state::GoalStatus;
use kcoder_state::continuous_work::{
    ContinuousWorkStore, HostWorkScope, InputAdmission, NativeForegroundWorkApplication,
    NativeInitialWorkAdmission, NativeInitialWorkCapacity, NativeInitialWorkOwner,
    NativeInitialWorkRequest, WorkInputSource, native_work_input_payload,
};
use kcoder_types::continuous_work::{
    CONTINUOUS_WORK_SCHEMA_V1, WorkIdentity, WorkInputKind, WorkInputState, WorkKnownReference,
    WorkNativeReference, WorkOrigin, WorkOriginKind, WorkPhase, WorkPresentation, WorkRecord,
    WorkRevision, WorkUsage,
};
use kcoder_types::{ContentBlock, Message, TurnAttemptIdentity};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex as StdMutex},
    time::Duration,
};
use tokio::sync::{Semaphore, oneshot};
use tokio_util::sync::CancellationToken;

/// The resident owner supplies the original lease and process-owned work slots.
pub trait ForegroundSession {
    fn is_ephemeral(&self, thread_id: &str) -> bool;
    fn deferred_lease(&self, thread_id: &str, target: &Path)
    -> Option<DeferredSessionLeaseWitness>;
    fn initial_work_capacity(&self) -> NativeInitialWorkCapacity;
    fn initial_work_owners(&self, thread_id: &str) -> Option<InitialWorkOwners>;
}

pub type InitialWorkOwners = Arc<StdMutex<HashMap<String, NativeInitialWorkOwner>>>;
static PERMITS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(8)));
static WORKERS: LazyLock<StdMutex<Vec<tokio::task::JoinHandle<()>>>> =
    LazyLock::new(|| StdMutex::new(Vec::new()));

pub struct PendingInitialWork {
    engine: QueryEngine,
    attempt: TurnAttemptIdentity,
    original: Message,
    lease_target: PathBuf,
    lease: DeferredSessionLeaseWitness,
    previous_goal: Option<String>,
    principal: Option<String>,
    capacity: NativeInitialWorkCapacity,
    owners: InitialWorkOwners,
    source_reference: Option<WorkKnownReference>,
}

impl PendingInitialWork {
    /// Capture only in-memory ownership here. Directory reads happen in the worker.
    pub fn capture(
        engine: &QueryEngine,
        threads: &dyn ForegroundSession,
        attempt: &TurnAttemptIdentity,
        original: &Message,
        source_reference: Option<WorkKnownReference>,
    ) -> Option<Self> {
        let Message::User {
            content,
            origin: kcoder_types::MessageOrigin::User,
        } = original
        else {
            return None;
        };
        if !content.iter().all(|block| {
            matches!(
                block,
                ContentBlock::Text { .. } | ContentBlock::Image { .. }
            )
        }) || !content.iter().any(|block| match block {
            ContentBlock::Text { text } => !text.is_empty(),
            ContentBlock::Image { source } => !source.data.is_empty(),
            _ => false,
        }) || threads.is_ephemeral(&attempt.thread_id)
            || engine.native_input_requires_source_admission()
            || engine.settings_persistence_path().is_none()
        {
            return None;
        }
        if source_reference.as_ref().is_some_and(|source| {
            !matches!(source,
            WorkKnownReference::TaskCapabilityScope { initial_attempt, .. } if initial_attempt == attempt)
        }) {
            return None;
        }
        let observation = engine.state.try_goal_observation_snapshot()?;
        if observation.session_id != attempt.thread_id {
            return None;
        }
        let target = engine.session_lease_target();
        let lease = threads.deferred_lease(&attempt.thread_id, &target)?;
        let principal = match std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID") {
            Ok(value) => Some(value),
            Err(std::env::VarError::NotPresent) => None,
            Err(_) => return None,
        };
        Some(Self {
            engine: engine.clone(),
            attempt: attempt.clone(),
            original: original.clone(),
            lease_target: target,
            lease,
            previous_goal: observation.goal.map(|goal| goal.0),
            principal,
            capacity: threads.initial_work_capacity(),
            owners: threads.initial_work_owners(&attempt.thread_id)?,
            source_reference,
        })
    }

    /// The actual successful tool result and live Goal must name the same new goal.
    pub fn created_goal(&self, event: &EngineEvent) -> Option<(String, u64, u64)> {
        let EngineEvent::ToolResult { name, output, .. } = event else {
            return None;
        };
        if name != "create_goal" || output.is_error {
            return None;
        }
        let [ContentBlock::Text { text }] = output.content.as_slice() else {
            return None;
        };
        let result: Value = serde_json::from_str(text).ok()?;
        let reported = result.get("goal")?.get("goal_id")?.as_str()?;
        if result.get("success")?.as_bool() != Some(true)
            || self.previous_goal.as_deref() == Some(reported)
        {
            return None;
        }
        let snapshot = self.engine.state.try_goal_observation_snapshot()?;
        let (goal_id, revision, status) = snapshot.goal?;
        if snapshot.session_id != self.attempt.thread_id
            || goal_id != reported
            || status != GoalStatus::Active
        {
            return None;
        }
        Some((goal_id, revision, snapshot.goal_created_at_ms?))
    }

    /// A process-owned worker preserves the original publication outcome even
    /// when the frontend disconnects. It never retries an uncertain write.
    pub fn start(
        self,
        committed: kcoder_state::CommittedUserInput,
        goal: (String, u64, u64),
        original_in_provider_request: bool,
    ) -> Option<oneshot::Receiver<()>> {
        let permit = PERMITS.clone().try_acquire_owned().ok()?;
        let mut workers = WORKERS.try_lock().ok()?;
        let (sender, receiver) = oneshot::channel();
        workers.retain(|worker| !worker.is_finished());
        workers.push(tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if let Err(error) = self.admit(committed, goal, original_in_provider_request) {
                tracing::warn!(code = "CONTINUOUS_WORK_ADMISSION_UNCONFIRMED", %error, "Continuous work admission requires reconciliation");
            }
            let _ = sender.send(());
        }));
        Some(receiver)
    }

    fn admit(
        self,
        committed: kcoder_state::CommittedUserInput,
        goal: (String, u64, u64),
        original_in_provider_request: bool,
    ) -> Result<()> {
        self.lease.verify_target(&self.lease_target)?;
        ensure!(
            committed.attempt() == Some(&self.attempt),
            "CONTINUOUS_WORK_ATTEMPT_CHANGED"
        );
        ensure!(
            kcoder_turn_lifecycle::turn_attempts::records(&self.engine, &self.attempt.thread_id)?
                .iter()
                .any(|record| record.identity == self.attempt),
            "CONTINUOUS_WORK_ATTEMPT_UNAVAILABLE"
        );
        let settings = self
            .engine
            .settings_persistence_path()
            .context("CONTINUOUS_WORK_PROFILE_UNAVAILABLE")?;
        let profile = settings
            .parent()
            .context("CONTINUOUS_WORK_PROFILE_UNAVAILABLE")?;
        let workspace = self.engine.state.cwd();
        let host = HostWorkScope::capture(profile, &workspace, self.principal.as_deref())?;
        let current = self
            .engine
            .state
            .try_goal_observation_snapshot()
            .context("CONTINUOUS_WORK_GOAL_UNAVAILABLE")?;
        ensure!(
            current.session_id == self.attempt.thread_id
                && current
                    .goal
                    .as_ref()
                    .is_some_and(|value| value.0 == goal.0 && value.1 == goal.1),
            "CONTINUOUS_WORK_GOAL_CHANGED"
        );
        let Message::User { content, .. } = &self.original else {
            anyhow::bail!("CONTINUOUS_WORK_INPUT_INVALID")
        };
        let title: String = content
            .iter()
            .find_map(|block| match block {
                ContentBlock::Text { text } if !text.is_empty() => Some(text.as_str()),
                _ => None,
            })
            .unwrap_or_default()
            .chars()
            .filter(|character| !character.is_control())
            .take(100)
            .collect();
        let work_id = format!("work-{}", committed.uuid());
        let mut native_refs = vec![WorkNativeReference::Known(WorkKnownReference::Goal {
            thread_id: self.attempt.thread_id.clone(),
            goal_id: goal.0.clone(),
            revision: goal.1,
        })];
        if let Some(source) = self.source_reference {
            native_refs.push(WorkNativeReference::Known(source));
        }
        let work = WorkRecord {
            schema_version: CONTINUOUS_WORK_SCHEMA_V1,
            identity: WorkIdentity {
                scope: host.scope().clone(),
                work_id: work_id.clone(),
            },
            origin: WorkOrigin {
                kind: WorkOriginKind::Foreground,
                initial_attempt: self.attempt.clone(),
                schedule: None,
                native_source: None,
            },
            linked_thread_ids: vec![self.attempt.thread_id.clone()],
            phase: WorkPhase::Pending,
            revision: WorkRevision {
                revision: 1,
                requirements_revision: 1,
                control_epoch: 0,
                owner_epoch: 0,
                accepted_input_sequence: 1,
                required_input_sequence: 1,
                applied_input_sequence: 0,
                usage: WorkUsage::default(),
            },
            native_refs,
            presentation: Some(WorkPresentation {
                title: (!title.is_empty()).then_some(title),
                objective_summary: None,
                created_at_ms: Some(goal.2),
                updated_at_ms: Some(goal.2),
            }),
            waiting: None,
            result: None,
            extensions: BTreeMap::new(),
        };
        let source = WorkInputSource {
            kind: "foreground".into(),
            instance_id: host.scope().target_id.clone(),
            conversation_id: self.attempt.thread_id.clone(),
        };
        let request_id = committed.uuid().to_owned();
        let store = ContinuousWorkStore::open_or_create(host.profile_path())?;
        let admitted = store.admit_initial_from_native(NativeInitialWorkRequest {
            state: &self.engine.state,
            scope: host.scope(),
            work,
            source: &source,
            request_id: &request_id,
            committed,
            original_accepted: &self.original,
            accepted_deliveries: Vec::new(),
            capacity: &self.capacity,
        });
        let NativeInitialWorkAdmission::Accepted(owner) = admitted else {
            anyhow::bail!("CONTINUOUS_WORK_PUBLICATION_UNCONFIRMED")
        };
        self.lease.verify_target(&self.lease_target)?;
        host.verify()?;
        ensure!(
            self.engine.settings_persistence_path().as_ref() == Some(&settings)
                && self.engine.state.cwd() == workspace,
            "CONTINUOUS_WORK_SCOPE_CHANGED"
        );
        let current = self
            .engine
            .state
            .try_goal_observation_snapshot()
            .context("CONTINUOUS_WORK_GOAL_UNAVAILABLE")?;
        ensure!(
            current.session_id == self.attempt.thread_id
                && current.goal.as_ref().is_some_and(|value| value.0 == goal.0),
            "CONTINUOUS_WORK_GOAL_CHANGED"
        );
        if original_in_provider_request
            && let Err(error) = store.record_native_initial_applied(
                &self.engine.state,
                host.scope(),
                &source,
                &owner.observer(),
            )
        {
            tracing::warn!(code = "CONTINUOUS_WORK_APPLICATION_UNCONFIRMED", %error, "Original input application requires reconciliation");
        }
        self.owners
            .lock()
            .map_err(|_| anyhow::anyhow!("CONTINUOUS_WORK_OWNER_UNAVAILABLE"))?
            .insert(work_id, owner);
        Ok(())
    }
}

/// One ordinary foreground message on a live, explicitly Goal-bound Work.
pub struct PendingFollowupWork {
    engine: QueryEngine,
    attempt: TurnAttemptIdentity,
    initial_attempt: TurnAttemptIdentity,
    original: Message,
    work_id: String,
    goal_id: String,
    client_message_id: Option<String>,
    lease_target: PathBuf,
    lease: DeferredSessionLeaseWitness,
    principal: Option<String>,
}

pub struct ObservedFollowupWork {
    pending: PendingFollowupWork,
    committed: kcoder_state::CommittedUserInput,
    store: ContinuousWorkStore,
    host: HostWorkScope,
    source: WorkInputSource,
    input_id: String,
    control_epoch: u64,
}

impl PendingFollowupWork {
    pub fn matches_original(&self, committed: &kcoder_state::CommittedUserInput) -> bool {
        committed.outcome() == kcoder_state::UserInputCommit::Durable
            && committed.matches_original(&self.original)
    }

    pub fn capture(
        engine: &QueryEngine,
        threads: &dyn ForegroundSession,
        attempt: &TurnAttemptIdentity,
        original: &Message,
        client_message_id: Option<&str>,
    ) -> Option<Self> {
        let Message::User {
            content,
            origin: kcoder_types::MessageOrigin::User,
        } = original
        else {
            return None;
        };
        if content.is_empty()
            || !content.iter().all(|block| {
                matches!(
                    block,
                    ContentBlock::Text { .. } | ContentBlock::Image { .. }
                )
            })
            || threads.is_ephemeral(&attempt.thread_id)
            || engine.native_input_requires_source_admission()
            || engine.settings_persistence_path().is_none()
        {
            return None;
        }
        let snapshot = engine.state.try_goal_observation_snapshot()?;
        let (goal_id, _, status) = snapshot.goal?;
        if snapshot.session_id != attempt.thread_id || status != GoalStatus::Active {
            return None;
        }
        let owners = threads.initial_work_owners(&attempt.thread_id)?;
        let owners = owners.lock().ok()?;
        let mut matches = owners.values().filter_map(|owner| {
            let work = owner.initial_work();
            let matches_goal = work.native_refs.iter().any(|reference| matches!(reference,
                WorkNativeReference::Known(WorkKnownReference::Goal { thread_id, goal_id: saved, .. })
                    if thread_id == &attempt.thread_id && saved == &goal_id));
            (matches_goal && work.linked_thread_ids.len() == 1
                && work.linked_thread_ids[0] == attempt.thread_id)
                .then(|| (work.identity.work_id.clone(), work.origin.initial_attempt.clone()))
        });
        let (work_id, initial_attempt) = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        drop(owners);
        let lease_target = engine.session_lease_target();
        let lease = threads.deferred_lease(&attempt.thread_id, &lease_target)?;
        let principal = match std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID") {
            Ok(value) => Some(value),
            Err(std::env::VarError::NotPresent) => None,
            Err(_) => return None,
        };
        Some(Self {
            engine: engine.clone(),
            attempt: attempt.clone(),
            initial_attempt,
            original: original.clone(),
            work_id,
            goal_id,
            client_message_id: client_message_id.map(str::to_owned),
            lease_target,
            lease,
            principal,
        })
    }

    /// Wait for durable input observation before the provider is polled.
    pub async fn observe_input(
        self,
        committed: kcoder_state::CommittedUserInput,
        cancel: &CancellationToken,
    ) -> Result<Option<ObservedFollowupWork>, String> {
        wait_for_receipt(self.start(committed), cancel, "CONTINUOUS_WORK_INPUT").await
    }

    /// Start the existing two-phase publication before the model is polled.
    fn start(
        self,
        committed: kcoder_state::CommittedUserInput,
    ) -> Option<oneshot::Receiver<Result<Option<ObservedFollowupWork>>>> {
        let mut workers = WORKERS.lock().ok()?;
        let (mut sender, receiver) = oneshot::channel();
        workers.retain(|worker| !worker.is_finished());
        if workers.len() >= 64 {
            return None;
        }
        workers.push(tokio::spawn(async move {
            let permit = tokio::select! {
                _ = sender.closed() => return,
                permit = PERMITS.clone().acquire_owned() => match permit {
                    Ok(permit) => permit,
                    Err(_) => return,
                },
            };
            if sender.is_closed() {
                return;
            }
            let result = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                self.accept(committed)
            })
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("CONTINUOUS_WORK_INPUT_UNCONFIRMED")));
            let _ = sender.send(result);
        }));
        Some(receiver)
    }

    fn accept(
        self,
        committed: kcoder_state::CommittedUserInput,
    ) -> Result<Option<ObservedFollowupWork>> {
        self.lease.verify_target(&self.lease_target)?;
        ensure!(
            committed.attempt() == Some(&self.attempt)
                && committed.matches_original(&self.original)
                && committed.try_is_current().is_ok_and(|current| current),
            "CONTINUOUS_WORK_INPUT_UNCONFIRMED"
        );
        if !kcoder_engine::continuous_work::input_handoff::can_observe_unrepaired_input(
            &self.engine,
            &committed,
        ) {
            return Ok(None);
        }
        let attempts =
            kcoder_turn_lifecycle::turn_attempts::records(&self.engine, &self.attempt.thread_id)?;
        ensure!(
            attempts
                .iter()
                .any(|record| record.identity == self.initial_attempt)
                && attempts
                    .iter()
                    .any(|record| record.identity == self.attempt),
            "CONTINUOUS_WORK_ATTEMPT_UNAVAILABLE"
        );
        let settings = self
            .engine
            .settings_persistence_path()
            .context("CONTINUOUS_WORK_PROFILE_UNAVAILABLE")?;
        let profile = settings
            .parent()
            .context("CONTINUOUS_WORK_PROFILE_UNAVAILABLE")?;
        let workspace = self.engine.state.cwd();
        let host = HostWorkScope::capture(profile, &workspace, self.principal.as_deref())?;
        let store = ContinuousWorkStore::open_existing(host.profile_path())?
            .context("CONTINUOUS_WORK_NOT_FOUND")?;
        let work = store
            .read_work(host.scope(), &self.work_id)?
            .context("CONTINUOUS_WORK_NOT_FOUND")?;
        let current = self
            .engine
            .state
            .try_goal_observation_snapshot()
            .context("CONTINUOUS_WORK_GOAL_UNAVAILABLE")?;
        if work.revision.accepted_input_sequence == 1 && work.revision.applied_input_sequence == 0 {
            return Ok(None);
        }
        ensure!(
            work.origin.initial_attempt == self.initial_attempt
                && work.linked_thread_ids.len() == 1
                && work.linked_thread_ids[0] == self.attempt.thread_id
                && work.native_refs.iter().any(|reference| matches!(reference,
                    WorkNativeReference::Known(WorkKnownReference::Goal { thread_id, goal_id, .. })
                        if thread_id == &self.attempt.thread_id && goal_id == &self.goal_id))
                && current.session_id == self.attempt.thread_id
                && current
                    .goal
                    .as_ref()
                    .is_some_and(|goal| goal.0 == self.goal_id && goal.2 == GoalStatus::Active)
                && matches!(&work.phase, WorkPhase::Pending | WorkPhase::Running)
                && store.active_claim(host.scope(), &self.work_id)?.is_none()
                && store
                    .current_control(host.scope(), &self.work_id)?
                    .is_none(),
            "CONTINUOUS_WORK_INPUT_NOT_READY"
        );
        let payload = native_work_input_payload(&committed, &self.original, true)?;
        let source = WorkInputSource {
            kind: "foreground".into(),
            instance_id: host.scope().target_id.clone(),
            conversation_id: self.attempt.thread_id.clone(),
        };
        let input_id = self
            .client_message_id
            .as_ref()
            .map(|id| format!("followup-{}", hex_sha256(id.as_bytes())))
            .unwrap_or_else(|| format!("followup-{}", committed.uuid()));
        let deliveries = store
            .accepted_deliveries(host.scope(), &self.work_id)?
            .context("CONTINUOUS_WORK_NOT_FOUND")?;
        if work.revision.applied_input_sequence < work.revision.accepted_input_sequence {
            // The target is still consuming an earlier requirement. Keep this
            // input durable as queued instead of dropping it or reordering it,
            // and leave this turn untracked.
            store.queue_input(
                host.scope(),
                &self.work_id,
                &source,
                work.revision.revision,
                &input_id,
                &input_id,
                WorkInputKind::Requirement,
                payload,
                Some(deliveries),
            )?;
            tracing::info!(
                input = %input_id,
                "continuous work input was queued behind an earlier requirement"
            );
            return Ok(None);
        }
        let receipt = match store.accept_input(
            host.scope(),
            &self.work_id,
            &source,
            work.revision.revision,
            &input_id,
            &input_id,
            WorkInputKind::Requirement,
            payload,
            Some(deliveries),
        )? {
            InputAdmission::Accepted(receipt) | InputAdmission::Existing(receipt) => receipt,
        };
        ensure!(
            receipt.state == WorkInputState::Accepted,
            "CONTINUOUS_WORK_INPUT_NOT_READY"
        );
        self.lease.verify_target(&self.lease_target)?;
        host.verify()?;
        let current = self
            .engine
            .state
            .try_goal_observation_snapshot()
            .context("CONTINUOUS_WORK_GOAL_UNAVAILABLE")?;
        ensure!(
            self.engine.settings_persistence_path().as_ref() == Some(&settings)
                && self.engine.state.cwd() == workspace
                && committed.try_is_current().is_ok_and(|valid| valid)
                && current.session_id == self.attempt.thread_id
                && current
                    .goal
                    .as_ref()
                    .is_some_and(|goal| goal.0 == self.goal_id && goal.2 == GoalStatus::Active),
            "CONTINUOUS_WORK_INPUT_UNCONFIRMED"
        );
        Ok(Some(ObservedFollowupWork {
            pending: self,
            committed,
            store,
            host,
            source,
            input_id,
            control_epoch: work.revision.control_epoch,
        }))
    }
}

impl ObservedFollowupWork {
    pub fn matches_provider_request(&self) -> bool {
        kcoder_engine::continuous_work::input_handoff::current_provider_request_includes(
            &self.committed,
        )
    }

    /// Wait for the application receipt before polling the next event.
    pub async fn observe_application(self, cancel: &CancellationToken) -> Result<(), String> {
        wait_for_receipt(
            self.record_application(),
            cancel,
            "CONTINUOUS_WORK_APPLICATION",
        )
        .await
    }

    /// The worker records only the observed foreground application; it does
    /// not start, retry or authorize a model or tool operation.
    fn record_application(self) -> Option<oneshot::Receiver<Result<()>>> {
        let mut workers = WORKERS.lock().ok()?;
        workers.retain(|worker| !worker.is_finished());
        if workers.len() >= 64 {
            return None;
        }
        let (mut sender, receiver) = oneshot::channel();
        workers.push(tokio::spawn(async move {
            let permit = tokio::select! {
                _ = sender.closed() => return,
                permit = PERMITS.clone().acquire_owned() => match permit {
                    Ok(permit) => permit,
                    Err(_) => return,
                },
            };
            if sender.is_closed() {
                return;
            }
            let result = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                self.pending
                    .lease
                    .verify_target(&self.pending.lease_target)?;
                self.host.verify()?;
                self.store
                    .record_native_foreground_applied(NativeForegroundWorkApplication {
                        state: &self.pending.engine.state,
                        scope: self.host.scope(),
                        work_id: &self.pending.work_id,
                        source: &self.source,
                        input_id: &self.input_id,
                        goal_id: &self.pending.goal_id,
                        expected_control_epoch: self.control_epoch,
                        committed: &self.committed,
                        original_accepted: &self.pending.original,
                    })?;
                Ok(())
            })
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("CONTINUOUS_WORK_APPLICATION_UNCONFIRMED")));
            let _ = sender.send(result);
        }));
        Some(receiver)
    }
}

async fn wait_for_receipt<T>(
    receiver: Option<oneshot::Receiver<Result<T>>>,
    cancel: &CancellationToken,
    operation: &str,
) -> Result<T, String> {
    let Some(receiver) = receiver else {
        return Err(format!("{operation}_NOT_SCHEDULED"));
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(format!("{operation}_CANCELLED")),
        result = tokio::time::timeout(Duration::from_secs(10), receiver) => match result {
            Err(_) => Err(format!("{operation}_TIMEOUT")),
            Ok(Err(error)) => Err(format!("{operation}_WORKER_{error}")),
            Ok(Ok(Err(error))) => Err(error.to_string()),
            Ok(Ok(Ok(observed))) => Ok(observed),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_precedes_a_ready_worker_receipt() {
        let (tx, rx) = oneshot::channel();
        tx.send(Ok(())).unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            wait_for_receipt(Some(rx), &cancel, "CONTINUOUS_WORK_INPUT").await,
            Err("CONTINUOUS_WORK_INPUT_CANCELLED".to_owned())
        );
    }

    #[tokio::test]
    async fn missing_worker_and_unconfirmed_write_are_distinct() {
        let cancel = CancellationToken::new();
        assert_eq!(
            wait_for_receipt::<()>(None, &cancel, "CONTINUOUS_WORK_APPLICATION").await,
            Err("CONTINUOUS_WORK_APPLICATION_NOT_SCHEDULED".to_owned())
        );
        let (tx, rx) = oneshot::channel::<Result<()>>();
        tx.send(Err(anyhow::anyhow!("original receipt unavailable")))
            .unwrap();
        assert_eq!(
            wait_for_receipt(Some(rx), &cancel, "CONTINUOUS_WORK_APPLICATION").await,
            Err("original receipt unavailable".to_owned())
        );
    }
}
