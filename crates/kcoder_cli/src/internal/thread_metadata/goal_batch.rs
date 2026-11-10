//! Bounded, opt-in point-in-time Goal observations.
use anyhow::{Context, Result};
use kcoder_app_protocol::{
    ThreadGoalStatusBatchObservation as Observation, ThreadGoalStatusBatchParams,
    ThreadGoalStatusBatchResult,
};
use kcoder_cli_storage::session_lease::DeferredSessionLeaseWitness;
use kcoder_host_transport::protocol_io::{send, success_response};
use kcoder_workspace_resources::managed_worktrees::validate_thread_id;
use serde_json::Value;
use std::sync::{LazyLock, Mutex as StdMutex};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::mpsc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};
use tokio_util::sync::CancellationToken;

const WAIT: Duration = Duration::from_millis(500);
const GLOBAL_WORKERS: usize = 4;
pub const MAX_SIDECAR_BYTES: u64 = 1024 * 1024;

/// Owns every blocking worker until it has actually exited, including after a
/// request timeout or connection closure. The permit lives in that worker.
struct WorkerOwner {
    permits: Arc<Semaphore>,
    workers: StdMutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl WorkerOwner {
    fn new(limit: usize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(limit)),
            workers: StdMutex::new(Vec::with_capacity(limit)),
        }
    }

    fn try_spawn<T: Send + 'static>(
        &self,
        connection: Arc<Semaphore>,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Option<oneshot::Receiver<T>> {
        let connection_permit = connection.try_acquire_owned().ok()?;
        let global_permit = self.permits.clone().try_acquire_owned().ok()?;
        let mut workers = self.workers.try_lock().ok()?;
        workers.retain(|worker| !worker.is_finished());
        let (start, admitted) = std::sync::mpsc::sync_channel::<()>(1);
        let (send, receive) = oneshot::channel();
        let worker = tokio::task::spawn_blocking(move || {
            let _owned_permits: (OwnedSemaphorePermit, OwnedSemaphorePermit) =
                (connection_permit, global_permit);
            if admitted.recv().is_ok() {
                let _ = send.send(work());
            }
        });
        workers.push(worker);
        let _ = start.send(());
        Some(receive)
    }
}

static WORKERS: LazyLock<WorkerOwner> = LazyLock::new(|| WorkerOwner::new(GLOBAL_WORKERS));

#[derive(Clone)]
pub struct StateSnapshot {
    state: kcoder_state::WeakGoalObservation,
    owner: kcoder_state::AppStateLifecycleIdentity,
    session_id: String,
    artifact_session_id: String,
    cwd: PathBuf,
    history_path: Option<PathBuf>,
    goal: Option<(String, u64, kcoder_state::GoalStatus)>,
    goal_created_at_ms: Option<u64>,
}

impl StateSnapshot {
    pub fn capture(state: &kcoder_state::AppState) -> Option<Self> {
        Self::capture_weak(state.weak_goal_observation())
    }

    pub fn history_path(&self) -> Option<&Path> {
        self.history_path.as_deref()
    }

    pub fn matches_history(&self, thread_id: &str, history_path: &Path) -> bool {
        self.session_id == thread_id && self.history_path() == Some(history_path)
    }

    pub fn goal_identity(&self) -> Option<(&str, u64)> {
        let (goal_id, _, _) = self.goal.as_ref()?;
        Some((goal_id.as_str(), self.goal_created_at_ms?))
    }

    fn capture_weak(state: kcoder_state::WeakGoalObservation) -> Option<Self> {
        let snapshot = state.try_snapshot()?;
        Some(Self {
            state,
            owner: snapshot.lifecycle,
            session_id: snapshot.session_id,
            artifact_session_id: snapshot.artifact_session_id,
            cwd: snapshot.cwd,
            history_path: snapshot.history_path,
            goal: snapshot.goal,
            goal_created_at_ms: snapshot.goal_created_at_ms,
        })
    }

    fn still_current(&self) -> bool {
        let Some(current) = Self::capture_weak(self.state.clone()) else {
            return false;
        };
        self.owner.same_lifecycle(&current.owner)
            && self.session_id == current.session_id
            && self.artifact_session_id == current.artifact_session_id
            && self.cwd == current.cwd
            && self.history_path == current.history_path
            && self.goal == current.goal
            && self.goal_created_at_ms == current.goal_created_at_ms
    }
}

pub struct ResidentInput {
    pub snapshot: StateSnapshot,
    pub lease: DeferredSessionLeaseWitness,
    pub lineage: Option<kcoder_state::NativeGoalMetadataObserver>,
}

pub struct Input {
    pub thread_id: String,
    pub history_path: PathBuf,
    pub resident: Option<ResidentInput>,
}

pub type CapturedBatch = (StateSnapshot, Vec<Option<Input>>);

pub fn parse_params(value: Value) -> std::result::Result<Vec<String>, ()> {
    let params: ThreadGoalStatusBatchParams = serde_json::from_value(value).map_err(|_| ())?;
    if params.thread_ids.is_empty()
        || params.thread_ids.len() > kcoder_app_protocol::MAX_THREAD_GOAL_STATUS_BATCH
    {
        return Err(());
    }
    let mut unique = HashSet::new();
    for id in &params.thread_ids {
        validate_thread_id(id).map_err(|_| ())?;
        if !unique.insert(id) {
            return Err(());
        }
    }
    Ok(params.thread_ids)
}

fn unavailable(id: &str) -> Observation {
    Observation::Unavailable {
        thread_id: id.to_owned(),
    }
}

fn label(status: kcoder_state::GoalStatus) -> &'static str {
    use kcoder_state::GoalStatus::*;
    match status {
        Active => "active",
        Paused => "paused",
        Blocked => "blocked",
        UsageLimited => "usageLimited",
        BudgetLimited => "budgetLimited",
        Complete => "complete",
        Cancelled => "cancelled",
    }
}

pub fn observe_one(
    workspace: &StateSnapshot,
    input: &Input,
    cancel: &CancellationToken,
    deadline: std::time::Instant,
) -> Option<Option<String>> {
    let check = || -> Result<()> {
        anyhow::ensure!(
            !cancel.is_cancelled() && std::time::Instant::now() < deadline,
            "goal observation stopped"
        );
        Ok(())
    };
    (|| -> Result<Option<String>> {
        check()?;
        let workspace_cwd = dunce::canonicalize(&workspace.cwd)?;
        check()?;
        if let Some(resident) = &input.resident {
            resident.lease.verify_target(&input.history_path)?;
            anyhow::ensure!(
                dunce::canonicalize(&resident.snapshot.cwd)? == workspace_cwd,
                "resident workspace changed"
            );
        }
        check()?;
        let tracked = match &input.resident {
            Some(resident) if resident.snapshot.goal.is_some() => match &resident.lineage {
                Some(lineage) if lineage.matches_lifecycle(&resident.snapshot.owner) => {
                    lineage.try_capture(MAX_SIDECAR_BYTES, check)?
                }
                _ => None,
            },
            _ => None,
        };
        let captured = match tracked {
            Some(captured) => captured,
            None => kcoder_state::CapturedSessionMetadata::try_capture_fenced_goal(
                &input.history_path,
                MAX_SIDECAR_BYTES,
                check,
            )?,
        };
        let metadata = captured.prepare_goal_observation()?;
        check()?;
        anyhow::ensure!(
            dunce::canonicalize(metadata.base_cwd.as_ref().context("workspace missing")?)?
                == workspace_cwd,
            "history workspace changed"
        );
        if let Some(resident) = &input.resident {
            resident.lease.verify_target(&input.history_path)?;
            anyhow::ensure!(
                resident.snapshot.still_current()
                    && resident.snapshot.goal == metadata.goal
                    && resident.snapshot.goal_created_at_ms == metadata.goal_created_at_ms,
                "resident goal changed"
            );
        }
        anyhow::ensure!(workspace.still_current(), "workspace lifecycle changed");
        check()?;
        Ok(metadata.goal.map(|(_, _, status)| label(status).to_owned()))
    })()
    .ok()
}

fn unknown_all(ids: &[String]) -> Vec<Observation> {
    ids.iter().map(|id| unavailable(id)).collect()
}

pub fn unavailable_result(ids: &[String]) -> ThreadGoalStatusBatchResult {
    ThreadGoalStatusBatchResult {
        observations: unknown_all(ids),
    }
}

pub fn spawn(
    tasks: &mut tokio::task::JoinSet<()>,
    request_id: Value,
    ids: Vec<String>,
    capture: &mut dyn FnMut(&[String]) -> Option<CapturedBatch>,
    outbound: mpsc::Sender<Value>,
    connection: Arc<Semaphore>,
    cancellation: CancellationToken,
) {
    let deadline = std::time::Instant::now() + WAIT;
    let input = if connection.available_permits() == 0 || WORKERS.permits.available_permits() == 0 {
        None
    } else {
        capture(&ids)
    };
    let worker_ids = ids.clone();
    let worker_cancel = cancellation.child_token();
    let cancel_on_timeout = worker_cancel.clone();
    let receive = input.and_then(|(workspace, inputs)| {
        WORKERS.try_spawn(connection, move || {
            worker_ids
                .iter()
                .zip(inputs)
                .map(|(id, input)| match input {
                    Some(input) => {
                        match observe_one(&workspace, &input, &worker_cancel, deadline) {
                            Some(status) => Observation::Available {
                                thread_id: input.thread_id,
                                status,
                            },
                            None => unavailable(id),
                        }
                    }
                    None => unavailable(id),
                })
                .collect::<Vec<_>>()
        })
    });
    tasks.spawn(async move {
        let observations = match receive {
            Some(receive) => tokio::select! {
                _ = cancellation.cancelled() => { cancel_on_timeout.cancel(); return; }
                result = tokio::time::timeout_at(deadline.into(), receive) => match result {
                    Ok(Ok(observations)) => observations,
                    _ => { cancel_on_timeout.cancel(); unknown_all(&ids) }
                },
            },
            None => unknown_all(&ids),
        };
        if cancellation.is_cancelled() {
            return;
        }
        let result = ThreadGoalStatusBatchResult { observations };
        let response = success_response(
            request_id,
            serde_json::to_value(result).expect("goal observations serialize"),
        );
        tokio::select! {
            _ = cancellation.cancelled() => {}
            _ = send(&outbound, response) => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_cli_storage::session_lease::SessionLease;
    use serde_json::json;

    #[test]
    fn batch_validates_limit_duplicates_and_unknown_fields() {
        let ids = (0..100)
            .map(|index| format!("thread-{index}"))
            .collect::<Vec<_>>();
        assert_eq!(
            parse_params(serde_json::json!({"threadIds":ids}))
                .unwrap()
                .len(),
            100
        );
        let too_many = (0..101)
            .map(|index| format!("thread-{index}"))
            .collect::<Vec<_>>();
        assert!(parse_params(serde_json::json!({"threadIds":too_many})).is_err());
        assert!(parse_params(serde_json::json!({"threadIds":["same","same"]})).is_err());
        assert!(
            parse_params(serde_json::json!({"threadIds":["valid"],"path":"/private"})).is_err()
        );
        assert!(parse_params(serde_json::json!({"threadIds":["../outside"]})).is_err());
        assert!(parse_params(serde_json::json!({"threadIds":[]})).is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn timeout_or_dropped_observer_never_releases_a_running_worker_permit() {
        let owner = WorkerOwner::new(1);
        let connection = Arc::new(Semaphore::new(1));
        let (entered, wait_entered) = std::sync::mpsc::channel();
        let (release, wait_release) = std::sync::mpsc::channel();
        let mut result = owner
            .try_spawn(connection.clone(), move || {
                entered.send(()).unwrap();
                wait_release.recv().unwrap();
                42
            })
            .unwrap();
        let start = tokio::time::Instant::now();
        loop {
            if wait_entered.try_recv().is_ok() {
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(3));
            tokio::task::yield_now().await;
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut result)
                .await
                .is_err()
        );
        assert_eq!(owner.permits.available_permits(), 0);
        assert_eq!(connection.available_permits(), 0);
        assert!(owner.try_spawn(connection.clone(), || 9).is_none());
        drop(result);
        assert_eq!(owner.workers.lock().unwrap().len(), 1);
        release.send(()).unwrap();
        let until = tokio::time::Instant::now() + Duration::from_secs(3);
        while connection.available_permits() == 0 || owner.permits.available_permits() == 0 {
            assert!(tokio::time::Instant::now() < until);
            tokio::task::yield_now().await;
        }
        assert_eq!(owner.permits.available_permits(), 1);
        assert_eq!(owner.try_spawn(connection, || 9).unwrap().await.unwrap(), 9);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn panicked_worker_releases_capacity_only_after_exit() {
        let owner = WorkerOwner::new(1);
        let connection = Arc::new(Semaphore::new(1));
        let result = owner
            .try_spawn(connection.clone(), || -> () {
                panic!("controlled worker panic")
            })
            .unwrap();
        assert!(result.await.is_err());
        let until = tokio::time::Instant::now() + Duration::from_secs(3);
        while connection.available_permits() == 0 || owner.permits.available_permits() == 0 {
            assert!(tokio::time::Instant::now() < until);
            tokio::task::yield_now().await;
        }
        assert_eq!(owner.permits.available_permits(), 1);
        assert_eq!(owner.try_spawn(connection, || 7).unwrap().await.unwrap(), 7);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cold_observation_uses_only_a_current_native_metadata_receipt() {
        #[cfg(unix)]
        let temp = {
            use std::os::unix::fs::PermissionsExt;
            tempfile::Builder::new()
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap()
        };
        #[cfg(not(unix))]
        let temp = tempfile::tempdir().unwrap();
        let workspace_path = temp.path().join("workspace");
        let history_dir = temp.path().join("history");
        std::fs::create_dir(&workspace_path).unwrap();
        kcoder_config::PrivateDirectory::open_or_create(&history_dir).unwrap();
        let history = history_dir.join("session.jsonl");
        let state = kcoder_state::AppState::new(&workspace_path);
        state.with_history_path(&history);
        state.add_message(kcoder_types::Message::user_text("input"));
        state.save_history().unwrap();
        state.set_goal("goal", None);
        let workspace = StateSnapshot::capture(&state).unwrap();
        let input = Input {
            thread_id: "session".into(),
            history_path: history,
            resident: None,
        };
        let cancellation = CancellationToken::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        assert_eq!(
            observe_one(&workspace, &input, &cancellation, deadline),
            Some(Some("active".into()))
        );
        let other = temp.path().join("other");
        std::fs::create_dir(&other).unwrap();
        let wrong = StateSnapshot::capture(&kcoder_state::AppState::new(other)).unwrap();
        assert_eq!(observe_one(&wrong, &input, &cancellation, deadline), None);
        state.add_message(kcoder_types::Message::user_text("later input"));
        state.flush_history().await.unwrap();
        let current = StateSnapshot::capture(&state).unwrap();
        assert_eq!(observe_one(&current, &input, &cancellation, deadline), None);
        cancellation.cancel();
        assert_eq!(
            observe_one(&workspace, &input, &cancellation, deadline),
            None
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn tool_created_goal_after_append_requires_original_host_registration() {
        use kcoder_tools::Tool;
        #[cfg(unix)]
        let temp = {
            use std::os::unix::fs::PermissionsExt;
            tempfile::Builder::new()
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap()
        };
        #[cfg(not(unix))]
        let temp = tempfile::tempdir().unwrap();
        let workspace_path = temp.path().join("workspace");
        let history_dir = temp.path().join("history");
        std::fs::create_dir(&workspace_path).unwrap();
        kcoder_config::PrivateDirectory::open_or_create(&history_dir).unwrap();
        let state = kcoder_state::AppState::new(&workspace_path);
        let thread_id = state.session_id();
        let history = history_dir.join(format!("{thread_id}.jsonl"));
        state.with_history_path(&history);
        state.add_message(kcoder_types::Message::user_text("initial"));
        state.save_history().unwrap();
        let lease = SessionLease::acquire(&history).unwrap();
        let turn = kcoder_types::TurnAttemptIdentity {
            thread_id: thread_id.clone(),
            turn_id: "turn-fixture".into(),
            attempt_id: "attempt-fixture".into(),
        };
        let scope = state.history_attempt_scope(turn).unwrap();
        let context = kcoder_tools::ToolContext::new(state.clone());
        let output = scope
            .run(async {
                kcoder_tools::goal::CreateGoalTool
                    .call(json!({"objective":"tool-owned fixture"}), &context)
                    .await
            })
            .await
            .unwrap();
        assert!(!output.is_error);
        let deferred = lease.deferred_witness(&history).unwrap();
        let snapshot = StateSnapshot::capture(&state).unwrap();
        let mut input = Input {
            thread_id: thread_id.clone(),
            history_path: history.clone(),
            resident: Some(ResidentInput {
                snapshot: snapshot.clone(),
                lease: deferred,
                lineage: None,
            }),
        };
        let cancel = CancellationToken::new();
        assert_eq!(
            observe_one(
                &snapshot,
                &input,
                &cancel,
                std::time::Instant::now() + Duration::from_secs(3)
            ),
            Some(Some("active".into()))
        );
        state.add_message(kcoder_types::Message::user_text("later input"));
        state.flush_history().await.unwrap();
        let snapshot = StateSnapshot::capture(&state).unwrap();
        input.resident.as_mut().unwrap().snapshot = snapshot.clone();
        assert_eq!(
            observe_one(
                &snapshot,
                &input,
                &cancel,
                std::time::Instant::now() + Duration::from_secs(3)
            ),
            None
        );
    }
}
