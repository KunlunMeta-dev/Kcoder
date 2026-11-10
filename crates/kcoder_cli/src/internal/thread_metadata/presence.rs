//! Bounded, workspace-scoped thread presence observations for negotiated clients.

use anyhow::{Context, Result};
use kcoder_cli_storage::tracked_history_list::candidate_thread_history_path;
use kcoder_host_transport::protocol_io::{send, success_response};
use kcoder_workspace_resources::managed_worktrees::validate_thread_id;
use serde_json::Value;
use std::{future::Future, path::Path, pin::Pin};
use tokio::sync::mpsc;

use crate::history_scan_roots;
use kcoder_app_protocol::{
    ThreadPresenceReadAbsentReasonV1, ThreadPresenceReadParams, ThreadPresenceReadPresentReasonV1,
    ThreadPresenceReadResultV1, ThreadPresenceReadUnknownReasonV1,
};
use std::io;
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

pub enum ObservationInput {
    Resident {
        thread_id: String,
        resident_session_id: String,
        resident_cwd: PathBuf,
        workspace_cwd: PathBuf,
    },
    Cold {
        thread_id: String,
        workspace_history_path: Option<PathBuf>,
        workspace_cwd: PathBuf,
    },
}

pub struct CancellationGuard(CancellationToken);

impl CancellationGuard {
    pub fn new(cancellation: CancellationToken) -> Self {
        Self(cancellation)
    }
}

impl Drop for CancellationGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub fn parse_params(params: Value) -> std::result::Result<ThreadPresenceReadParams, ()> {
    let params = serde_json::from_value::<ThreadPresenceReadParams>(params).map_err(|_| ())?;
    validate_thread_id(&params.thread_id).map_err(|_| ())?;
    Ok(params)
}

fn observe_input(
    input: ObservationInput,
    cancellation: &CancellationToken,
) -> Option<ThreadPresenceReadResultV1> {
    if cancellation.is_cancelled() {
        return None;
    }
    match input {
        ObservationInput::Resident {
            thread_id,
            resident_session_id,
            resident_cwd,
            workspace_cwd,
        } => observe_resident(
            &thread_id,
            &resident_session_id,
            &resident_cwd,
            &workspace_cwd,
            cancellation,
        ),
        ObservationInput::Cold {
            thread_id,
            workspace_history_path,
            workspace_cwd,
        } => observe_cold(
            &thread_id,
            workspace_history_path.as_deref(),
            &workspace_cwd,
            cancellation,
        ),
    }
}

fn observe_resident(
    thread_id: &str,
    resident_session_id: &str,
    resident_cwd: &std::path::Path,
    workspace_cwd: &std::path::Path,
    cancellation: &CancellationToken,
) -> Option<ThreadPresenceReadResultV1> {
    if resident_session_id != thread_id {
        return Some(unknown(
            thread_id,
            ThreadPresenceReadUnknownReasonV1::ResidentIdentityMismatch,
        ));
    }
    if cancellation.is_cancelled() {
        return None;
    }
    let resident_workspace = dunce::canonicalize(resident_cwd);
    if cancellation.is_cancelled() {
        return None;
    }
    let current_workspace = dunce::canonicalize(workspace_cwd);
    if cancellation.is_cancelled() {
        return None;
    }
    Some(match (resident_workspace, current_workspace) {
        (Ok(resident), Ok(current)) if resident == current => ThreadPresenceReadResultV1::Present {
            thread_id: thread_id.to_string(),
            reason: ThreadPresenceReadPresentReasonV1::ResidentRuntime,
        },
        (Ok(_), Ok(_)) => unknown(
            thread_id,
            ThreadPresenceReadUnknownReasonV1::ResidentIdentityMismatch,
        ),
        _ => unknown(
            thread_id,
            ThreadPresenceReadUnknownReasonV1::ObservationFailed,
        ),
    })
}

fn observe_cold(
    thread_id: &str,
    workspace_history_path: Option<&std::path::Path>,
    workspace_cwd: &std::path::Path,
    cancellation: &CancellationToken,
) -> Option<ThreadPresenceReadResultV1> {
    // A cold physical history file is not enough to prove that its session sidecar
    // belongs to this workspace. This V1 therefore authorizes only bounded absence.
    let Some(workspace_history_path) = workspace_history_path else {
        return Some(unknown(
            thread_id,
            ThreadPresenceReadUnknownReasonV1::PrimarySourceUnavailable,
        ));
    };
    let Some(history_dir) = workspace_history_path.parent() else {
        return Some(unknown(
            thread_id,
            ThreadPresenceReadUnknownReasonV1::ObservationFailed,
        ));
    };
    let history_path = match candidate_thread_history_path(history_dir, thread_id) {
        Ok(path) => path,
        Err(_) => {
            return Some(unknown(
                thread_id,
                ThreadPresenceReadUnknownReasonV1::ObservationFailed,
            ));
        }
    };
    if cancellation.is_cancelled() {
        return None;
    }
    let observation =
        match kcoder_state::observe_session_history_source_presence(&history_path, workspace_cwd) {
            Ok(observation) => observation,
            Err(error) => {
                let reason = if error
                    .downcast_ref::<kcoder_state::HistorySourceObservationBusy>()
                    .is_some()
                {
                    ThreadPresenceReadUnknownReasonV1::Busy
                } else if error
                    .downcast_ref::<kcoder_state::HistorySourcePresenceUnsupported>()
                    .is_some()
                {
                    ThreadPresenceReadUnknownReasonV1::Unsupported
                } else {
                    ThreadPresenceReadUnknownReasonV1::ObservationFailed
                };
                return Some(unknown(thread_id, reason));
            }
        };
    if cancellation.is_cancelled() {
        return None;
    }

    Some(match observation {
        kcoder_state::HistorySourceObservation::Unknown(reason) => {
            unknown(thread_id, unknown_state_reason(reason))
        }
        kcoder_state::HistorySourceObservation::PhysicalSourceFileObserved { .. } => unknown(
            thread_id,
            ThreadPresenceReadUnknownReasonV1::ColdSourceNotAuthorized,
        ),
        kcoder_state::HistorySourceObservation::BoundDeletedSourceAbsent(reference) => {
            if reference.thread_id() != thread_id {
                return Some(unknown(
                    thread_id,
                    ThreadPresenceReadUnknownReasonV1::ObservationFailed,
                ));
            }
            if cancellation.is_cancelled() {
                return None;
            }
            match compatibility_roots_are_missing(history_dir, workspace_cwd, cancellation) {
                None => return None,
                Some(Ok(true)) => ThreadPresenceReadResultV1::Absent {
                    thread_id: thread_id.to_string(),
                    reason: ThreadPresenceReadAbsentReasonV1::BoundDeletedPrimarySource,
                },
                Some(Ok(false)) => unknown(
                    thread_id,
                    ThreadPresenceReadUnknownReasonV1::CompatibilityRootPresent,
                ),
                Some(Err(_)) => unknown(
                    thread_id,
                    ThreadPresenceReadUnknownReasonV1::ObservationFailed,
                ),
            }
        }
    })
}

fn unknown_state_reason(
    reason: kcoder_state::HistorySourceUnknown,
) -> ThreadPresenceReadUnknownReasonV1 {
    use kcoder_state::HistorySourceUnknown as StateReason;
    match reason {
        StateReason::MissingHistoryParent => {
            ThreadPresenceReadUnknownReasonV1::MissingHistoryParent
        }
        StateReason::MissingControlDirectory => {
            ThreadPresenceReadUnknownReasonV1::MissingControlDirectory
        }
        StateReason::MissingControlRecord => {
            ThreadPresenceReadUnknownReasonV1::MissingControlRecord
        }
        StateReason::MissingSourceForLiveRecord => {
            ThreadPresenceReadUnknownReasonV1::MissingSourceForLiveRecord
        }
        StateReason::LegacyDeletionWithoutBinding => {
            ThreadPresenceReadUnknownReasonV1::LegacyDeletionWithoutBinding
        }
        StateReason::BoundDeletionMissingSourceWithoutLock => {
            ThreadPresenceReadUnknownReasonV1::BoundDeletionMissingSourceWithoutLock
        }
        StateReason::BoundDeletionResidualSameIdentity => {
            ThreadPresenceReadUnknownReasonV1::BoundDeletionResidualSameIdentity
        }
    }
}

/// `true` means every non-primary path the persisted list searches is securely absent.
/// Existing roots, relative paths, symlink components, and non-NotFound I/O are inconclusive.
fn compatibility_roots_are_missing(
    history_dir: &Path,
    workspace: &Path,
    cancellation: &CancellationToken,
) -> Option<Result<bool>> {
    if cancellation.is_cancelled() {
        return None;
    }
    let project_dirs = match kcoder_config::Settings::project_data_dirs_for_read(workspace) {
        Ok(project_dirs) => project_dirs,
        Err(error) => return Some(Err(error)),
    };
    if cancellation.is_cancelled() {
        return None;
    }
    let roots = match compatibility_scan_roots(history_dir, &project_dirs) {
        Ok(roots) => roots,
        Err(error) => return Some(Err(error)),
    };
    for root in roots.iter().filter(|root| root.as_path() != history_dir) {
        if cancellation.is_cancelled() {
            return None;
        }
        match observe_compatibility_root(root) {
            Ok(CompatibilityRootObservation::Present) => return Some(Ok(false)),
            Ok(CompatibilityRootObservation::Missing) => {}
            Err(error) => return Some(Err(error)),
        }
    }
    Some(Ok(true))
}

fn compatibility_scan_roots(history_dir: &Path, project_dirs: &[PathBuf]) -> Result<Vec<PathBuf>> {
    let Some(project_dir) = project_dirs.first() else {
        anyhow::bail!("compatibility project roots are unavailable");
    };
    anyhow::ensure!(
        history_dir.strip_prefix(project_dir).is_ok(),
        "primary history root is outside the project root mapping"
    );
    Ok(history_scan_roots(history_dir, project_dir, project_dirs))
}

fn observe_compatibility_root(root: &Path) -> Result<CompatibilityRootObservation> {
    if !root.is_absolute() {
        anyhow::bail!("compatibility root is not absolute");
    }
    match kcoder_config::PrivateDirectory::open_existing(root) {
        Ok(_directory) => Ok(CompatibilityRootObservation::Present),
        Err(error) if has_not_found(&error) => Ok(CompatibilityRootObservation::Missing),
        Err(error) => Err(error).context("compatibility root observation failed"),
    }
}

fn has_not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<io::Error>()
            .is_some_and(|error| error.kind() == io::ErrorKind::NotFound)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompatibilityRootObservation {
    Missing,
    Present,
}

pub fn unknown(
    thread_id: &str,
    reason: ThreadPresenceReadUnknownReasonV1,
) -> ThreadPresenceReadResultV1 {
    ThreadPresenceReadResultV1::Unknown {
        thread_id: thread_id.to_string(),
        reason,
    }
}

pub fn spawn_observation_task(
    tasks: &mut tokio::task::JoinSet<()>,
    id: Value,
    thread_id: String,
    outbound_tx: mpsc::Sender<Value>,
    permit: tokio::sync::OwnedSemaphorePermit,
    cancellation: CancellationToken,
    input: ObservationInput,
) {
    spawn_observation_task_with(
        tasks,
        id,
        thread_id,
        outbound_tx,
        permit,
        cancellation,
        move |cancel| observe_input(input, &cancel),
    );
}

fn spawn_observation_task_with<F>(
    tasks: &mut tokio::task::JoinSet<()>,
    id: Value,
    thread_id: String,
    outbound_tx: mpsc::Sender<Value>,
    permit: tokio::sync::OwnedSemaphorePermit,
    cancellation: CancellationToken,
    observe: F,
) where
    F: FnOnce(CancellationToken) -> Option<ThreadPresenceReadResultV1> + Send + 'static,
{
    let failure_thread_id = thread_id.clone();
    let task: Pin<Box<dyn Future<Output = ()> + Send>> = Box::pin(async move {
        let worker_cancellation = cancellation.clone();
        let mut worker = tokio::task::spawn_blocking(move || {
            // Keep the connection's capacity permit in the actual blocking worker.
            // Aborting this async task cannot release capacity while filesystem work runs.
            let _permit = permit;
            observe(worker_cancellation)
        });
        let joined = tokio::select! {
            _ = cancellation.cancelled() => {
                worker.abort();
                return;
            }
            joined = &mut worker => joined,
        };
        if cancellation.is_cancelled() {
            return;
        }
        let result = match joined {
            Ok(Some(result)) => result,
            Ok(None) => return,
            Err(_) => unknown(
                &failure_thread_id,
                ThreadPresenceReadUnknownReasonV1::ObservationFailed,
            ),
        };
        let response = success_response(
            id,
            serde_json::to_value(result).expect("presence result serializes"),
        );
        tokio::select! {
            _ = cancellation.cancelled() => {}
            result = send(&outbound_tx, response) => {
                if let Err(error) = result {
                    tracing::warn!(%error, "failed to send thread presence observation");
                }
            }
        }
    });
    tasks.spawn(task);
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        sync::{Arc, Barrier},
        time::Duration,
    };

    #[test]
    fn compatibility_root_observation_is_nofollow_missing_aware_and_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing").join("compat");
        assert_eq!(
            observe_compatibility_root(&missing).unwrap(),
            CompatibilityRootObservation::Missing
        );
        assert_eq!(
            std::fs::read_dir(temp.path()).unwrap().count(),
            0,
            "missing-path observation must not create ancestors"
        );

        let existing = temp.path().join("existing");
        std::fs::create_dir(&existing).unwrap();
        assert_eq!(
            observe_compatibility_root(&existing).unwrap(),
            CompatibilityRootObservation::Present
        );

        let target = temp.path().join("target");
        std::fs::create_dir(&target).unwrap();
        let link = temp.path().join("linked");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let symlink_error = observe_compatibility_root(&link.join("compat")).unwrap_err();
        assert!(!has_not_found(&symlink_error));

        let file = temp.path().join("ordinary-file");
        std::fs::write(&file, b"x").unwrap();
        let not_directory_error = observe_compatibility_root(&file.join("compat")).unwrap_err();
        assert!(!has_not_found(&not_directory_error));
        assert!(observe_compatibility_root(Path::new("relative/compat")).is_err());
    }

    #[test]
    fn compatibility_roots_require_a_proven_primary_mapping() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let history = project.join("custom-history");
        let mapped = compatibility_scan_roots(&history, std::slice::from_ref(&project)).unwrap();
        assert_eq!(mapped, vec![history]);

        let foreign = temp.path().join("foreign-history");
        assert!(compatibility_scan_roots(&foreign, &[project]).is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn canceled_connection_keeps_presence_capacity_until_worker_exits() {
        let gate = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = gate.clone().try_acquire_owned().unwrap();
        let cancellation = CancellationToken::new();
        let (outbound_tx, mut outbound_rx) = mpsc::channel(1);
        let mut tasks = tokio::task::JoinSet::new();
        let worker_started = Arc::new(Barrier::new(2));
        let worker_release = Arc::new(Barrier::new(2));
        let started_in_worker = worker_started.clone();
        let release_in_worker = worker_release.clone();

        spawn_observation_task_with(
            &mut tasks,
            json!(1),
            "thread-1".into(),
            outbound_tx,
            permit,
            cancellation.clone(),
            move |_| {
                started_in_worker.wait();
                release_in_worker.wait();
                Some(unknown(
                    "thread-1",
                    ThreadPresenceReadUnknownReasonV1::ColdSourceNotAuthorized,
                ))
            },
        );

        let wait_for_worker = worker_started.clone();
        tokio::task::spawn_blocking(move || wait_for_worker.wait())
            .await
            .unwrap();
        cancellation.cancel();
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        assert!(
            gate.clone().try_acquire_owned().is_err(),
            "aborting the connection wrapper must not release a running worker's permit"
        );

        let release_worker = worker_release.clone();
        tokio::task::spawn_blocking(move || release_worker.wait())
            .await
            .unwrap();
        let permit = tokio::time::timeout(Duration::from_secs(2), gate.acquire_owned())
            .await
            .expect("worker exit releases its connection capacity")
            .unwrap();
        drop(permit);
        assert!(outbound_rx.try_recv().is_err());
    }
}
