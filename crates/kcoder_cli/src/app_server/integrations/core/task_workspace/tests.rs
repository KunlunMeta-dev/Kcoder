//! Actual private Native context, persisted thread/goal/workflow and resident State.
use super::*;
use crate::app_server::{
    BackgroundEventPump, BackgroundFollowupScheduler, BackgroundFollowupState,
    BackgroundProjectionState, InteractionReceipts, ResidentTurnState, SessionLease,
    thread_runtime::ThreadRuntime,
};
use kcoder_config::PrivateDirectory;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex, atomic::AtomicU64},
};
use tokio::sync::{Mutex, mpsc};

struct Fixture {
    _temp: tempfile::TempDir,
    native: NativeIntegrationContext,
    engine: QueryEngine,
    profile: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let parent = PrivateDirectory::open_existing(temp.path()).unwrap();
        parent.create_private_child(OsStr::new("profile")).unwrap();
        parent
            .create_private_child(OsStr::new("workspace"))
            .unwrap();
        let profile = temp.path().join("profile");
        let workspace = temp.path().join("workspace");
        std::fs::write(
            profile.join("settings.json"),
            b"{\"integrations\":{\"office\":{\"enabled\":false}}}",
        )
        .unwrap();
        let engine = crate::app_server::tests::catalog_list_test_engine(&workspace)
            .with_settings_persistence_path(profile.join("settings.json"));
        let thread = engine.session_id();
        let history = profile.join(format!("{thread}.jsonl"));
        engine.state.with_history_path(history);
        engine.state.add_message(kcoder_types::Message::user_text(
            "Actual original task objective",
        ));
        engine
            .state
            .set_goal("Persistent original acceptance and unknowns", Some(1000));
        engine.state.save_history().unwrap();
        let native = NativeIntegrationContext::capture(
            &profile,
            &workspace,
            "task-workspace-actual",
            "configuration-1",
        )
        .unwrap();
        Self {
            _temp: temp,
            native,
            engine,
            profile,
        }
    }
    fn query(&self) -> TaskWorkspaceReadParams {
        TaskWorkspaceReadParams {
            thread_id: self.engine.session_id(),
            cursor: None,
            task_capability_scope_target: None,
        }
    }
    fn workflow(&self) {
        let run = kcoder_tools::workflow_runs::RunObservation::start(
            self.profile.join("workflow-runs"),
            kcoder_types::workflow_runs::WorkflowRunSnapshot {
                revision: 0,
                run_id: "original-workflow-run".into(),
                definition_id: Some("original-definition".into()),
                version: Some(3),
                thread_id: self.engine.session_id(),
                workspace: self.engine.state.cwd().to_string_lossy().into_owned(),
                status: "running".into(),
                error: None,
                started_at_ms: 1,
                updated_at_ms: 1,
                resume_count: 0,
                interaction_modified: false,
                node_states: vec![],
            },
        )
        .unwrap();
        drop(run);
    }
    fn resident(&self) -> ThreadRuntime {
        let projection = Arc::new(Mutex::new(BackgroundProjectionState::default()));
        let followups = Arc::new(BackgroundFollowupState::default());
        let (tx, _rx) = mpsc::channel(32);
        let turn = ResidentTurnState::new(
            tx.clone(),
            kcoder_config::PermissionMode::Bypass,
            Arc::new(AtomicU64::new(1)),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );
        let pump =
            BackgroundEventPump::spawn(&self.engine, projection.clone(), followups.clone(), tx);
        ThreadRuntime::new(
            self.engine.clone(),
            SessionLease::acquire(&self.engine.session_lease_target()).unwrap(),
            projection,
            followups,
            (pump, BackgroundFollowupScheduler::disabled_for_test()),
            turn,
        )
    }
    fn member(&self, index: usize, status: kcoder_types::TaskStatus) {
        let id = format!("member-{index:03}");
        let mut task = kcoder_state::Task::new(id.clone(), format!("Original member {index}"));
        task.kind = kcoder_state::TaskKind::Subagent;
        task.status = status;
        task.parent_session_id = Some(self.engine.session_id());
        task.output_path = Some(PathBuf::from("/private/not-a-ui-artifact"));
        task.transcript_path = Some(PathBuf::from("/private/not-a-ui-transcript"));
        task.background_run = Some(kcoder_types::BackgroundRunKey {
            parent_session_id: self.engine.session_id(),
            agent_id: id,
            run_id: format!("original-run-{index}"),
        });
        task.notify_parent_on_completion = false;
        self.engine.state.upsert_task(task);
    }
}
fn files(root: &Path) -> Vec<(String, Vec<u8>)> {
    fn visit(root: &Path, path: &Path, found: &mut Vec<(String, Vec<u8>)>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                visit(root, &entry.path(), found)
            } else if entry.file_type().unwrap().is_file() {
                found.push((
                    entry
                        .path()
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    std::fs::read(entry.path()).unwrap(),
                ));
            }
        }
    }
    let mut found = vec![];
    visit(root, root, &mut found);
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}
#[test]
fn query_requires_exact_bounded_native_thread_reference() {
    assert!(
        TaskWorkspaceReadParams {
            thread_id: "native-thread".into(),
            cursor: None,
            task_capability_scope_target: None,
        }
        .validate()
        .is_ok()
    );
    assert!(
        TaskWorkspaceReadParams {
            thread_id: "../other".into(),
            cursor: None,
            task_capability_scope_target: None,
        }
        .validate()
        .is_err()
    );
}
#[tokio::test]
async fn historical_native_thread_goal_and_workflow_are_read_without_reconciliation_or_initialization()
 {
    let fixture = Fixture::new();
    fixture.workflow();
    let before = files(fixture._temp.path());
    let current = fixture.engine.session_id();
    let original = fixture.engine.state.messages();
    let manager = ThreadManager::default();
    let mut reader = NativeTaskWorkspaceReader::default();
    let snapshot = reader
        .read(
            &fixture.native,
            &fixture.engine,
            &manager,
            &fixture.query(),
            &CancellationToken::new(),
        )
        .unwrap();
    assert_eq!(snapshot.thread.reference.thread_id(), current);
    assert!(snapshot.entries.iter().any(|entry|matches!(&entry.reference,TaskWorkspaceNativeRef::Goal{goal_id,..} if goal_id==&fixture.engine.state.goal().unwrap().goal_id)));
    assert!(snapshot.entries.iter().any(|entry|matches!(&entry.reference,TaskWorkspaceNativeRef::WorkflowRun{run_id,revision,..} if run_id=="original-workflow-run"&&*revision==0)&&entry.native_status.as_deref()==Some("running")));
    assert!(
        snapshot
            .facets
            .iter()
            .any(|facet| facet.kind == TaskWorkspaceFacetKind::Agents
                && facet.availability == TaskWorkspaceAvailability::Partial
                && facet.observed_count == Some(0)
                && facet.reason_code.as_deref() == Some("HISTORICAL_AGENTS_SNAPSHOT"))
    );
    assert!(manager.is_empty());
    assert_eq!(fixture.engine.session_id(), current);
    assert_eq!(fixture.engine.state.messages(), original);
    assert_eq!(files(fixture._temp.path()), before);
}

#[tokio::test]
async fn historical_subagents_are_read_from_the_original_sidecar_without_resuming_or_writing() {
    let fixture = Fixture::new();
    fixture.member(0, kcoder_types::TaskStatus::Completed);
    fixture.member(1, kcoder_types::TaskStatus::Running);
    fixture.engine.state.save_history().unwrap();
    let before = files(fixture._temp.path());
    let manager = ThreadManager::default();
    let mut reader = NativeTaskWorkspaceReader::default();
    let snapshot = reader
        .read(
            &fixture.native,
            &fixture.engine,
            &manager,
            &fixture.query(),
            &CancellationToken::new(),
        )
        .unwrap();
    let facet = snapshot
        .facets
        .iter()
        .find(|facet| facet.kind == TaskWorkspaceFacetKind::Agents)
        .unwrap();
    assert_eq!(facet.availability, TaskWorkspaceAvailability::Partial);
    assert_eq!(facet.observed_count, Some(2));
    assert_eq!(
        facet.reason_code.as_deref(),
        Some("HISTORICAL_AGENTS_SNAPSHOT")
    );
    let agents = snapshot
        .entries
        .iter()
        .filter(|entry| matches!(entry.reference, TaskWorkspaceNativeRef::Agent { .. }))
        .collect::<Vec<_>>();
    assert_eq!(agents.len(), 2);
    assert!(
        agents
            .iter()
            .all(|entry| entry.source_method == "history/agents")
    );
    assert!(
        agents
            .iter()
            .any(|entry| entry.native_status.as_deref() == Some("completed"))
    );
    assert!(
        agents
            .iter()
            .any(|entry| entry.native_status.as_deref() == Some("running"))
    );
    assert_eq!(files(fixture._temp.path()), before);
    assert!(manager.is_empty());
}
#[tokio::test]
async fn readonly_native_profile_observation_can_read_a_task_without_settings_write_authority() {
    let fixture = Fixture::new();
    fixture.workflow();
    let before = files(fixture._temp.path());
    let mut readonly =
        crate::app_server::tests::catalog_list_test_engine(&fixture.engine.state.cwd())
            .with_native_readonly_settings_source_from(&fixture.engine)
            .unwrap();
    readonly.state = fixture.engine.state.clone();
    assert!(readonly.settings_persistence_path().is_none());
    let mut reader = NativeTaskWorkspaceReader::default();
    let snapshot = reader
        .read(
            &fixture.native,
            &readonly,
            &ThreadManager::default(),
            &fixture.query(),
            &CancellationToken::new(),
        )
        .unwrap();
    assert_eq!(
        snapshot.thread.reference.thread_id(),
        fixture.engine.session_id()
    );
    assert!(
        snapshot
            .entries
            .iter()
            .any(|entry| matches!(&entry.reference,
        TaskWorkspaceNativeRef::WorkflowRun {run_id,..} if run_id=="original-workflow-run"))
    );
    assert!(
        readonly
            .persist_allowed_tool("unapproved-tool")
            .await
            .is_err()
    );
    let foreign = Fixture::new();
    assert!(
        reader
            .read(
                &foreign.native,
                &readonly,
                &ThreadManager::default(),
                &fixture.query(),
                &CancellationToken::new()
            )
            .is_err()
    );
    assert_eq!(files(fixture._temp.path()), before);
}
#[tokio::test]
async fn actual_resident_members_keep_original_runs_and_do_not_complete_the_parent() {
    let fixture = Fixture::new();
    for index in 0..24 {
        fixture.member(index, kcoder_types::TaskStatus::Completed);
    }
    let mut manager = ThreadManager::default();
    manager.insert(fixture.resident()).map_err(|_| ()).unwrap();
    let mut reader = NativeTaskWorkspaceReader::default();
    let first = reader
        .read(
            &fixture.native,
            &fixture.engine,
            &manager,
            &fixture.query(),
            &CancellationToken::new(),
        )
        .unwrap();
    assert_eq!(first.entries.len(), 10);
    assert_eq!(
        fixture.engine.state.goal().unwrap().status,
        kcoder_state::GoalStatus::Active
    );
    let serialized = serde_json::to_string(&first).unwrap();
    assert!(
        !serialized.contains("/private/")
            && !serialized.contains("transcriptPath")
            && !serialized.contains("outputPath")
    );
    assert!(first.entries.iter().any(|entry|matches!(&entry.reference,TaskWorkspaceNativeRef::Agent{background_run:Some(run),agent_id,..}if run.agent_id==*agent_id&&run.parent_session_id==fixture.engine.session_id())));
    fixture.member(99, kcoder_types::TaskStatus::Running);
    let mut query = fixture.query();
    query.cursor = first.next_cursor.clone();
    let next = reader
        .read(
            &fixture.native,
            &fixture.engine,
            &manager,
            &query,
            &CancellationToken::new(),
        )
        .unwrap();
    assert_eq!(first.snapshot_id, next.snapshot_id);
    assert_eq!(next.entries.len(), 10);
    assert!(!serde_json::to_string(&next).unwrap().contains("member-099"));
    std::fs::write(
        fixture.profile.join("settings.json"),
        b"{\"integrations\":{\"office\":{\"enabled\":false}},\"max_retries\":2}",
    )
    .unwrap();
    assert!(
        reader
            .read(
                &fixture.native,
                &fixture.engine,
                &manager,
                &query,
                &CancellationToken::new()
            )
            .is_err()
    );
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        reader
            .read(
                &fixture.native,
                &fixture.engine,
                &manager,
                &fixture.query(),
                &cancelled
            )
            .is_err()
    );
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}
#[tokio::test]
async fn foreign_native_owner_and_workspace_cannot_reuse_a_cursor_or_read_a_member() {
    let fixture = Fixture::new();
    for index in 0..12 {
        fixture.member(index, kcoder_types::TaskStatus::Completed);
    }
    let mut manager = ThreadManager::default();
    manager.insert(fixture.resident()).map_err(|_| ()).unwrap();
    let mut reader = NativeTaskWorkspaceReader::default();
    let first = reader
        .read(
            &fixture.native,
            &fixture.engine,
            &manager,
            &fixture.query(),
            &CancellationToken::new(),
        )
        .unwrap();
    let other = Fixture::new();
    let query = TaskWorkspaceReadParams {
        thread_id: fixture.engine.session_id(),
        cursor: first.next_cursor,
        task_capability_scope_target: None,
    };
    assert!(
        reader
            .read(
                &other.native,
                &other.engine,
                &ThreadManager::default(),
                &query,
                &CancellationToken::new()
            )
            .is_err()
    );
    assert!(
        reader
            .read(
                &other.native,
                &fixture.engine,
                &manager,
                &fixture.query(),
                &CancellationToken::new()
            )
            .is_err()
    );
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}

fn explicit_task_capability_scope_target(
    thread: &str,
    attempt: &str,
    operation: Option<&str>,
) -> IntegrationTaskCapabilityScopeControlTarget {
    IntegrationTaskCapabilityScopeControlTarget {
        initial_attempt: kcoder_types::TurnAttemptIdentity {
            thread_id: thread.into(),
            turn_id: "explicit-turn".into(),
            attempt_id: attempt.into(),
        },
        runtime_operation_id: operation.map(str::to_owned),
    }
}
#[tokio::test]
async fn task_capability_scope_target_labels_without_native_observation_keep_other_facets_and_unknown_counts()
 {
    let fixture = Fixture::new();
    let mut manager = ThreadManager::default();
    assert!(manager.insert(fixture.resident()).is_ok());
    let mut query = fixture.query();
    query.task_capability_scope_target = Some(explicit_task_capability_scope_target(
        &query.thread_id,
        "unobserved-attempt",
        Some("unobserved-runtime-op"),
    ));
    let before = files(fixture._temp.path());
    let mut reader = NativeTaskWorkspaceReader::default();
    let snapshot = reader
        .read(
            &fixture.native,
            &fixture.engine,
            &manager,
            &query,
            &CancellationToken::new(),
        )
        .unwrap();
    assert_eq!(
        snapshot.task_capability_scope_target,
        query.task_capability_scope_target
    );
    assert!(snapshot.runtime.is_none() && snapshot.task_capability_scope_selection.is_none());
    for kind in [
        TaskWorkspaceFacetKind::Runtime,
        TaskWorkspaceFacetKind::Sources,
    ] {
        let facet = snapshot
            .facets
            .iter()
            .find(|facet| facet.kind == kind)
            .unwrap();
        assert_eq!(facet.availability, TaskWorkspaceAvailability::Unknown);
        assert_eq!(facet.observed_count, None);
    }
    assert_eq!(snapshot.thread.reference.thread_id(), query.thread_id);
    assert!(
        snapshot
            .facets
            .iter()
            .any(|facet| facet.kind == TaskWorkspaceFacetKind::Goal
                && facet.availability == TaskWorkspaceAvailability::Available)
    );
    assert_eq!(files(fixture._temp.path()), before);
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}
#[tokio::test]
async fn frozen_source_and_runtime_metadata_pages_bind_the_complete_selected_tuple_and_do_not_refresh()
 {
    let fixture = Fixture::new();
    for index in 0..12 {
        fixture.member(index, kcoder_types::TaskStatus::Completed);
    }
    let mut manager = ThreadManager::default();
    assert!(manager.insert(fixture.resident()).is_ok());
    let mut query = fixture.query();
    query.task_capability_scope_target = Some(explicit_task_capability_scope_target(
        &query.thread_id,
        "explicit-attempt",
        Some("exact-runtime-op"),
    ));
    let selection = NativeTaskWorkspaceSelection::capture(&manager, &query).unwrap();
    // Synthetic projection values exercise pagination only; the separate actual
    // SourceRuntime/Pump probe supplies genuine native Accepted observations.
    let source = IntegrationTaskCapabilityScopeSnapshot {
        thread_id: query.thread_id.clone(),
        revision: 3,
        selection: IntegrationTaskCapabilityScopeSelection {
            mode: IntegrationTaskCapabilityScopeMode::None,
            sources: vec![],
        },
        effective_sources: vec![],
        effective_from: IntegrationTaskCapabilityScopeBoundary::CurrentSnapshot,
        resource_bindings: None,
        effective_resource_bindings: None,
    };
    let runtime = IntegrationRuntimeTask {
        thread_id: query.thread_id.clone(),
        turn_id: Some("original-runtime-turn".into()),
        task_id: None,
        state: IntegrationTaskState::Running,
        output: None,
        artifact_refs: vec![],
        pending_interactions: vec![],
    };
    let observed = enrichment::ObservedEnrichment {
        task_capability_scope_target: query.task_capability_scope_target.clone(),
        task_capability_scope_selection: Some(source.clone()),
        runtime: Some(runtime.clone()),
        ..Default::default()
    };
    let mut reader = NativeTaskWorkspaceReader::default();
    let first = reader
        .read_owned_enriched(
            &fixture.native,
            &fixture.engine,
            &selection,
            &query,
            observed,
            &CancellationToken::new(),
        )
        .unwrap();
    query.cursor = first.next_cursor;
    assert!(query.cursor.is_some());
    let second = reader
        .read_owned(
            &fixture.native,
            &fixture.engine,
            &selection,
            &query,
            &CancellationToken::new(),
        )
        .unwrap();
    assert_eq!(second.task_capability_scope_selection, Some(source));
    assert_eq!(second.runtime, Some(runtime));
    assert_eq!(second.snapshot_id, first.snapshot_id);
    let original = query.task_capability_scope_target.clone();
    query
        .task_capability_scope_target
        .as_mut()
        .unwrap()
        .initial_attempt
        .attempt_id = "another-explicit-attempt".into();
    assert!(
        reader
            .read_owned(
                &fixture.native,
                &fixture.engine,
                &selection,
                &query,
                &CancellationToken::new()
            )
            .is_err()
    );
    query.task_capability_scope_target = original;
    query
        .task_capability_scope_target
        .as_mut()
        .unwrap()
        .runtime_operation_id = Some("other-runtime-op".into());
    assert!(
        reader
            .read_owned(
                &fixture.native,
                &fixture.engine,
                &selection,
                &query,
                &CancellationToken::new()
            )
            .is_err()
    );
    query.task_capability_scope_target = None;
    assert!(
        reader
            .read_owned(
                &fixture.native,
                &fixture.engine,
                &selection,
                &query,
                &CancellationToken::new()
            )
            .is_err()
    );
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}
