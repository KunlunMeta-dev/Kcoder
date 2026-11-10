use super::{
    QueryEngine, canonical_workspace, decorate_thread_snapshot_with_metadata, history_scan_roots,
    read_thread_metadata, recorded_thread_permission_mode_at_creation,
};
use anyhow::Result;
pub(super) use kcoder_cli_storage::tracked_history_list::{
    BuildPhase, BuildProgress, ListBudget, StepBudget,
};
use kcoder_cli_storage::tracked_history_list::{
    PersistedThreadSnapshotReport, TrackedHistoryHost, TrackedHistoryList as StorageList,
};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub(super) struct HistoryHost<'a>(pub(super) &'a QueryEngine);

impl TrackedHistoryHost for HistoryHost<'_> {
    fn history_path(&self) -> Option<PathBuf> {
        self.0.state.history_path()
    }

    fn client_storage_root(&self) -> PathBuf {
        self.0.client_storage_root()
    }

    fn history_scan_roots(&self, history: &Path) -> Vec<PathBuf> {
        match kcoder_config::Settings::project_data_dirs_for_read(self.0.state.cwd()) {
            Ok(project_dirs) if !project_dirs.is_empty() => {
                history_scan_roots(history, &project_dirs[0], &project_dirs)
            }
            _ => vec![history.to_owned()],
        }
    }

    fn canonical_workspace(&self) -> Result<String> {
        canonical_workspace(self.0)
    }

    fn has_creation_record(&self, id: &str) -> Result<bool> {
        Ok(recorded_thread_permission_mode_at_creation(self.0, id)?.is_some())
    }

    fn decorate_snapshot(&self, id: &str, snapshot: &mut Value) -> Result<()> {
        let stored = read_thread_metadata(self.0, id)?;
        decorate_thread_snapshot_with_metadata(snapshot, stored.as_ref(), true)
    }
}

#[derive(Default)]
pub(super) struct TrackedHistoryList(StorageList);

impl TrackedHistoryList {
    pub(super) fn begin(
        &mut self,
        engine: &QueryEngine,
        acknowledge_external_writers: bool,
    ) -> Result<BuildProgress> {
        self.0
            .begin(&HistoryHost(engine), acknowledge_external_writers)
    }

    pub(super) fn step(
        &mut self,
        engine: &QueryEngine,
        budget: StepBudget,
    ) -> Result<BuildProgress> {
        self.0.step(&HistoryHost(engine), budget)
    }

    pub(super) fn cancel(&mut self) {
        self.0.cancel();
    }

    pub(super) fn try_list(
        engine: &QueryEngine,
        running: &HashSet<String>,
        excluded: &HashSet<String>,
        budget: ListBudget,
    ) -> Result<Option<PersistedThreadSnapshotReport>> {
        StorageList::try_list(&HistoryHost(engine), running, excluded, budget)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::AppState;
    use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
    use kcoder_types::Message;
    use std::collections::HashSet;
    use std::sync::Arc;

    struct Fixture {
        workspace: tempfile::TempDir,
        history: tempfile::TempDir,
        engine: QueryEngine,
    }

    impl Fixture {
        fn new() -> Self {
            let workspace = tempfile::tempdir().unwrap();
            let history = tempfile::tempdir().unwrap();
            let settings = kcoder_config::Settings::default();
            let owner =
                Arc::new(kcoder_config::create_private_temp_dir("tracked-list-test").unwrap());
            let services =
                kcoder_engine::WorkspaceRuntimeServices::new(workspace.path(), "tracked-list-test")
                    .with_private_client_storage(owner);
            let engine = QueryEngine::try_new_for_client_with_services(
                Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
                    crate::tui_dev_mock::TuiDevScenario::FullTurn,
                )),
                AppState::new(workspace.path()),
                kcoder_tools::ToolRegistry::new(),
                kcoder_permissions::PermissionEngine::from_settings(&settings),
                settings,
                kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
                kcoder_skills::SkillRegistry::empty(),
                Arc::new(kcoder_tools::DenyAllUserQuestioner),
                workspace.path().to_owned(),
                Some(true),
                services,
            )
            .unwrap();
            engine.state.with_history_path(
                history
                    .path()
                    .join(format!("{}.jsonl", engine.session_id())),
            );
            Self {
                workspace,
                history,
                engine,
            }
        }

        fn seed(&self) {
            self.engine
                .state
                .add_message(Message::user_text("known prompt"));
            self.engine.state.save_history().unwrap();
        }

        fn legacy(&self, id: &str, body: &[u8], workspace: &Path) {
            std::fs::write(self.history.path().join(format!("{id}.jsonl")), body).unwrap();
            let path = kcoder_state::session_state_path(self.history.path(), id);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let metadata = serde_json::json!({"schema_version": 1, "base_cwd": workspace});
            std::fs::write(path, serde_json::to_vec(&metadata).unwrap()).unwrap();
        }
    }

    fn tree(root: &Path) -> Vec<PathBuf> {
        let mut paths = Vec::new();
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                paths.extend(tree(&path));
            }
            paths.push(path);
        }
        paths.sort();
        paths
    }

    fn finish(
        service: &mut TrackedHistoryList,
        engine: &QueryEngine,
        budget: StepBudget,
    ) -> BuildProgress {
        for _ in 0..100 {
            let progress = service.step(engine, budget).unwrap();
            if progress.phase != BuildPhase::Building {
                return progress;
            }
        }
        panic!("bounded fixture build did not terminate")
    }

    #[test]
    fn explicit_empty_task_survives_cold_and_tracked_listing_without_bootstrap_ghosts() {
        let fixture = Fixture::new();
        let id = fixture.engine.session_id();
        let path = fixture.engine.state.history_path().unwrap();
        fixture.engine.activate_client_session();
        super::super::record_thread_permission_mode_for_thread(
            &fixture.engine,
            &id,
            kcoder_config::PermissionMode::Ask,
        )
        .unwrap();
        fixture.engine.state.materialize_history().unwrap();
        fixture.legacy("unadmitted", b"", fixture.workspace.path());
        let foreign = tempfile::tempdir().unwrap();
        fixture.legacy("foreign", b"", foreign.path());
        super::super::record_thread_permission_mode_for_thread(
            &fixture.engine,
            "foreign",
            kcoder_config::PermissionMode::Ask,
        )
        .unwrap();
        let cold = super::super::persisted_thread_snapshot_report(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(cold.issue_count, 0);
        assert_eq!(cold.threads.len(), 1);
        assert_eq!(cold.threads[0]["id"], id);
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        assert_eq!(
            finish(&mut service, &fixture.engine, StepBudget::default()).phase,
            BuildPhase::Ready
        );
        let hot = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(hot.issue_count, 0);
        assert_eq!(hot.threads, cold.threads);
        assert_eq!(std::fs::read(&path).unwrap(), b"");
        assert!(fixture.engine.state.messages().is_empty());
        kcoder_state::delete_session_history_files(&path).unwrap();
        let deleted = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert!(deleted.threads.is_empty());
        assert!(
            super::super::persisted_thread_snapshot_report(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
            )
            .unwrap()
            .threads
            .is_empty()
        );
        assert!(!path.exists(), "listing must never recreate deleted tasks");
    }

    #[test]
    fn tracked_list_opt_in_and_hot_missing_catalog_never_create_files() {
        let fixture = Fixture::new();
        let root = fixture.engine.client_storage_root();
        let before = (tree(&root), tree(fixture.history.path()));
        assert!(
            TrackedHistoryList::try_list(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
                ListBudget::default()
            )
            .unwrap()
            .is_none()
        );
        assert!(
            TrackedHistoryList::default()
                .begin(&fixture.engine, false)
                .is_err()
        );
        assert_eq!((tree(&root), tree(fixture.history.path())), before);
    }

    #[test]
    fn tracked_list_acknowledged_empty_deferred_history_becomes_ready() {
        let fixture = Fixture::new();
        let directory = fixture.history.path().join("deferred");
        fixture.engine.state.with_deferred_history_path(
            directory.join(format!("{}.jsonl", fixture.engine.session_id())),
        );
        assert!(!directory.exists());
        assert!(
            TrackedHistoryList::try_list(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
                ListBudget::default()
            )
            .unwrap()
            .is_none()
        );
        let mut service = TrackedHistoryList::default();
        assert!(service.begin(&fixture.engine, false).is_err());
        assert!(!directory.exists());
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(&mut service, &fixture.engine, StepBudget::default());
        assert_eq!(progress.phase, BuildPhase::Ready);
        assert_eq!((progress.indexed_sessions, progress.issue_count), (0, 0));
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert!(report.threads.is_empty());
        assert!(!fixture.engine.state.history_path().unwrap().exists());
    }

    #[test]
    fn tracked_list_chunked_rebuild_exceeds_step_budget_without_rewriting_source() {
        let fixture = Fixture::new();
        fixture.seed();
        let source = fixture.engine.state.history_path().unwrap();
        let control = source.with_extension("hctl").join("source.json");
        let before_control = std::fs::read(&control).unwrap();
        let mut body = std::fs::read(&source).unwrap();
        let line = format!(
            "{}\n",
            serde_json::json!({"timestamp_ms": 9999999999999u64, "padding": "x".repeat(4000)})
        );
        while body.len() <= StepBudget::default().body_bytes as usize {
            body.extend_from_slice(line.as_bytes());
        }
        std::fs::write(&source, &body).unwrap();
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        let first = service
            .step(&fixture.engine, StepBudget::default())
            .unwrap();
        assert_eq!(first.phase, BuildPhase::Building);
        assert_eq!(first.indexed_sessions, 0);
        assert_eq!(
            service.0.test_active_source_bytes_read(),
            Some(StepBudget::default().body_bytes)
        );
        let progress = finish(&mut service, &fixture.engine, StepBudget::default());
        assert_eq!(progress.phase, BuildPhase::Ready);
        assert_eq!(progress.indexed_sessions, 1);
        assert!(
            std::fs::read(&source).unwrap() == body,
            "refresh must not rewrite source bytes"
        );
        assert_eq!(std::fs::read(&control).unwrap(), before_control);
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        let oracle = super::super::persisted_thread_value(
            &fixture.engine,
            &fixture.engine.session_id(),
            &source,
            false,
        )
        .unwrap();
        assert_eq!(report.threads, vec![oracle]);
    }

    #[test]
    fn tracked_list_chunked_external_shrink_and_half_line_keep_authority_unchanged() {
        let fixture = Fixture::new();
        fixture.seed();
        let source = fixture.engine.state.history_path().unwrap();
        let control = source.with_extension("hctl").join("source.json");
        let original_control = std::fs::read(&control).unwrap();
        let body = b"{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"shrunk\"}],\"timestamp_ms\":2}\n";
        assert!(body.len() < std::fs::metadata(&source).unwrap().len() as usize);
        std::fs::write(&source, body).unwrap();
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(
            &mut service,
            &fixture.engine,
            StepBudget {
                body_bytes: 7,
                ..Default::default()
            },
        );
        assert_eq!(progress.phase, BuildPhase::Ready);
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        let oracle = super::super::persisted_thread_value(
            &fixture.engine,
            &fixture.engine.session_id(),
            &source,
            false,
        )
        .unwrap();
        assert_eq!(report.threads, vec![oracle]);
        assert_eq!(std::fs::read(&source).unwrap(), body);
        assert_eq!(std::fs::read(&control).unwrap(), original_control);
        std::fs::write(&source, &body[..body.len() - 1]).unwrap();
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(&mut service, &fixture.engine, StepBudget::default());
        assert_eq!(progress.phase, BuildPhase::Incomplete);
        assert_eq!(progress.issue_count, 1);
        assert_eq!(std::fs::read(&source).unwrap(), &body[..body.len() - 1]);
        assert_eq!(std::fs::read(&control).unwrap(), original_control);
    }

    #[test]
    fn tracked_list_chunked_finish_reconciles_a_large_late_managed_rewrite() {
        let fixture = Fixture::new();
        fixture.seed();
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        for _ in 0..100 {
            service
                .step(&fixture.engine, StepBudget::default())
                .unwrap();
            if service.0.test_scan_drained() {
                break;
            }
        }
        let mut messages = vec![Message::user_text("late managed rewrite")];
        for _ in 0..8500 {
            messages.push(Message::assistant_text("x".repeat(4000)));
        }
        fixture.engine.state.set_messages(messages);
        fixture.engine.state.save_history().unwrap();
        assert!(
            std::fs::metadata(fixture.engine.state.history_path().unwrap())
                .unwrap()
                .len()
                > StepBudget::default().body_bytes
        );
        let progress = finish(&mut service, &fixture.engine, StepBudget::default());
        assert_eq!(progress.phase, BuildPhase::Ready);
        assert_eq!(progress.indexed_sessions, 1);
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(report.threads[0]["title"], "late managed rewrite");
    }

    #[test]
    fn tracked_list_chunked_sidecar_change_during_read_never_publishes_old_ownership() {
        let fixture = Fixture::new();
        fixture.seed();
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        let budget = StepBudget {
            body_bytes: 13,
            ..Default::default()
        };
        assert_eq!(
            service.step(&fixture.engine, budget).unwrap().phase,
            BuildPhase::Building
        );
        assert!(service.0.test_has_active_source());
        let sidecar =
            kcoder_state::session_state_path(fixture.history.path(), &fixture.engine.session_id());
        let mut metadata: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
        let foreign = tempfile::tempdir().unwrap();
        metadata["base_cwd"] = serde_json::json!(foreign.path());
        std::fs::write(&sidecar, serde_json::to_vec(&metadata).unwrap()).unwrap();
        let progress = finish(&mut service, &fixture.engine, budget);
        assert_eq!(progress.phase, BuildPhase::Incomplete);
        assert!(progress.issue_count > 0);
    }

    #[test]
    fn tracked_list_builds_known_and_legacy_sources_and_consumes_dirty() {
        let fixture = Fixture::new();
        fixture.seed();
        let body = format!(
            "{}\n",
            serde_json::to_string(&kcoder_state::HistoryEntry {
                web_sources: Vec::new(),
                history_attempt: None,
                session_id: "legacy".into(),
                timestamp_ms: 7,
                uuid: None,
                parent_uuid: None,
                message: Message::user_text("legacy prompt")
            })
            .unwrap()
        );
        fixture.legacy("legacy", body.as_bytes(), fixture.workspace.path());
        let mut service = TrackedHistoryList::default();
        assert_eq!(
            service.begin(&fixture.engine, true).unwrap().phase,
            BuildPhase::Building
        );
        assert!(
            TrackedHistoryList::default()
                .begin(&fixture.engine, true)
                .is_err()
        );
        assert!(
            TrackedHistoryList::try_list(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
                ListBudget::default()
            )
            .unwrap()
            .is_none()
        );
        let progress = finish(
            &mut service,
            &fixture.engine,
            StepBudget {
                entries: 2,
                ..Default::default()
            },
        );
        assert_eq!(progress.phase, BuildPhase::Ready);
        assert_eq!((progress.indexed_sessions, progress.issue_count), (2, 0));
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(report.threads.len(), 2);
        assert!(
            report
                .threads
                .iter()
                .any(|row| row["title"] == "legacy prompt")
        );
        let params = serde_json::from_value(serde_json::json!({"threadId": fixture.engine.session_id(), "title":"renamed", "archivedAt":"100"})).unwrap();
        super::super::update_thread_metadata(&fixture.engine, params, &HashSet::new(), true)
            .unwrap();
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert!(
            report
                .threads
                .iter()
                .any(|row| row["title"] == "renamed" && row["archivedAt"] == "100")
        );
    }

    #[test]
    fn tracked_list_dirty_over_budget_never_serves_stale_rows_and_refresh_recovers() {
        let fixture = Fixture::new();
        let ids: Vec<_> = (0..129).map(|index| format!("dirty{index:04}")).collect();
        for id in &ids {
            let entry = kcoder_state::HistoryEntry {
                web_sources: Vec::new(),
                history_attempt: None,
                session_id: id.clone(),
                timestamp_ms: 7,
                uuid: None,
                parent_uuid: None,
                message: Message::user_text("original"),
            };
            let body = format!("{}\n", serde_json::to_string(&entry).unwrap());
            fixture.legacy(id, body.as_bytes(), fixture.workspace.path());
        }
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        assert_eq!(
            finish(&mut service, &fixture.engine, StepBudget::default()).phase,
            BuildPhase::Ready
        );
        for id in &ids {
            let params = serde_json::from_value(serde_json::json!({
                "threadId": id, "title": format!("updated-{id}")
            }))
            .unwrap();
            super::super::update_thread_metadata(&fixture.engine, params, &HashSet::new(), true)
                .unwrap();
        }
        // A dirty set larger than the hot-read budget must never publish a partial update.
        for _ in 0..2 {
            assert!(
                TrackedHistoryList::try_list(
                    &fixture.engine,
                    &HashSet::new(),
                    &HashSet::new(),
                    ListBudget::default()
                )
                .unwrap()
                .is_none()
            );
        }
        service.begin(&fixture.engine, true).unwrap();
        assert_eq!(
            finish(&mut service, &fixture.engine, StepBudget::default()).phase,
            BuildPhase::Ready
        );
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(report.threads.len(), ids.len());
        for id in ids {
            let row = report.threads.iter().find(|row| row["id"] == id).unwrap();
            assert_eq!(row["title"], format!("updated-{id}"));
        }
    }

    #[test]
    fn tracked_list_issues_never_publish_a_partial_ready_baseline() {
        let fixture = Fixture::new();
        fixture.seed();
        fixture.legacy("broken", b"\xff\n", fixture.workspace.path());
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(&mut service, &fixture.engine, StepBudget::default());
        assert_eq!(progress.phase, BuildPhase::Incomplete);
        assert!(progress.issue_count > 0);
        assert!(
            TrackedHistoryList::try_list(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
                ListBudget::default()
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn tracked_list_finish_reconciles_writes_after_enumeration_and_later_deletion() {
        let fixture = Fixture::new();
        fixture.seed();
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        for _ in 0..100 {
            let progress = service
                .step(
                    &fixture.engine,
                    StepBudget {
                        entries: 1,
                        ..Default::default()
                    },
                )
                .unwrap();
            assert_eq!(progress.phase, BuildPhase::Building);
            if service.0.test_scan_drained() {
                break;
            }
        }
        let state = AppState::new(fixture.workspace.path());
        let path = fixture
            .history
            .path()
            .join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        state.add_message(Message::user_text("late birth"));
        state.save_history().unwrap();
        assert_eq!(
            finish(&mut service, &fixture.engine, StepBudget::default()).indexed_sessions,
            2
        );
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(report.threads.len(), 2);
        kcoder_state::delete_session_history_files(&path).unwrap();
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(report.threads.len(), 1);
        assert_eq!(report.threads[0]["id"], fixture.engine.session_id());
    }

    #[test]
    fn tracked_list_hot_read_uses_journals_and_explicit_refresh_observes_manual_metadata() {
        let fixture = Fixture::new();
        fixture.seed();
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        assert_eq!(
            finish(&mut service, &fixture.engine, StepBudget::default()).phase,
            BuildPhase::Ready
        );
        let directory = super::super::ensure_thread_metadata_directory(
            &fixture.engine,
            &fixture.engine.session_id(),
        )
        .unwrap();
        let metadata = serde_json::json!({"version":1,"revision":1,"thread_id":fixture.engine.session_id(),"workspace":super::super::canonical_workspace(&fixture.engine).unwrap(),"fields":{"title":"manual title"},"updated_at":"1"});
        std::fs::write(
            directory.join(super::super::THREAD_METADATA_FILE),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        let source = fixture.engine.state.history_path().unwrap();
        let original = std::fs::read(&source).unwrap();
        // External edits are outside the journal contract until an explicit refresh.
        std::fs::write(&source, vec![0xff; original.len()]).unwrap();
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(report.threads[0]["title"], "known prompt");
        std::fs::write(&source, original).unwrap();
        let mut fence =
            JournalFence::try_acquire(fixture.history.path(), JournalDomain::History).unwrap();
        let mutation = fence.begin(&fixture.engine.session_id()).unwrap();
        assert!(
            TrackedHistoryList::try_list(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
                ListBudget::default()
            )
            .unwrap()
            .is_none()
        );
        mutation.finish().unwrap();
        drop(fence);
        service.begin(&fixture.engine, true).unwrap();
        assert_eq!(
            finish(&mut service, &fixture.engine, StepBudget::default()).phase,
            BuildPhase::Ready
        );
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(report.threads[0]["title"], "manual title");
    }

    #[test]
    fn tracked_list_budget_defers_candidates_and_oversize_lines_never_look_complete() {
        let fixture = Fixture::new();
        fixture.seed();
        let source = fixture.engine.state.history_path().unwrap();
        let body = std::fs::read(&source).unwrap();
        fixture.legacy("legacy", &body, fixture.workspace.path());
        let foreign = tempfile::tempdir().unwrap();
        fixture.legacy("foreign", b"\xff\n", foreign.path());
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(
            &mut service,
            &fixture.engine,
            StepBudget {
                body_bytes: body.len() as u64 + 1,
                ..Default::default()
            },
        );
        assert_eq!(progress.phase, BuildPhase::Ready);
        assert_eq!(progress.indexed_sessions, 2);
        assert!(
            TrackedHistoryList::try_list(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
                ListBudget {
                    max_rows: 1,
                    ..Default::default()
                }
            )
            .unwrap()
            .is_none()
        );
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(
            &mut service,
            &fixture.engine,
            StepBudget {
                line_bytes: 1,
                ..Default::default()
            },
        );
        assert_eq!(progress.phase, BuildPhase::Incomplete);
        assert_eq!(progress.issue_count, 2);
        assert!(
            TrackedHistoryList::try_list(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
                ListBudget::default()
            )
            .unwrap()
            .is_none()
        );
        service.begin(&fixture.engine, true).unwrap();
        service.cancel();
        assert!(
            TrackedHistoryList::default()
                .begin(&fixture.engine, true)
                .is_ok()
        );
    }

    #[test]
    fn workspace_identity_comparison_uses_simplified_forms() {
        // Both sides of the workspace ownership comparison must be produced
        // through the same normalization. On Linux the helpers are the
        // identity, so this pins the helper choice and the comparison contract:
        // the scope workspace string and a fresh canonicalization agree.
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let canonical = dunce::canonicalize(&workspace).unwrap();
        let scope_workspace = canonical.to_string_lossy().into_owned();
        assert_eq!(
            dunce::canonicalize(&workspace).unwrap(),
            Path::new(&scope_workspace)
        );
        assert_eq!(
            dunce::simplified(&canonical).to_string_lossy(),
            dunce::simplified(Path::new(&scope_workspace)).to_string_lossy()
        );
    }

    #[test]
    fn tracked_list_skips_sessions_from_deleted_directories_without_counting_issues() {
        let fixture = Fixture::new();
        fixture.seed();
        let gone = tempfile::tempdir().unwrap();
        let body = format!(
            "{}\n",
            serde_json::to_string(&kcoder_state::HistoryEntry {
                web_sources: Vec::new(),
                history_attempt: None,
                session_id: "gone01".into(),
                timestamp_ms: 7,
                uuid: None,
                parent_uuid: None,
                message: Message::user_text("orphaned prompt")
            })
            .unwrap()
        );
        fixture.legacy("gone01", body.as_bytes(), gone.path());
        drop(gone);

        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(&mut service, &fixture.engine, StepBudget::default());
        assert_eq!(progress.phase, BuildPhase::Ready);
        assert_eq!(
            progress.issue_count, 0,
            "a session from a deleted directory must not block the index build"
        );
        assert_eq!(progress.indexed_sessions, 1);
    }

    #[test]
    fn tracked_list_reports_issue_details_for_broken_sources() {
        let fixture = Fixture::new();
        fixture.seed();
        // A session whose .hctl control record has an unsupported schema version
        // fails source validation at scan level; the refresh response must
        // carry the per-entry reason instead of an opaque count.
        let id = "broken1";
        std::fs::write(
            fixture.history.path().join(format!("{id}.jsonl")),
            b"{\"schema_version\":1}
",
        )
        .unwrap();
        let control = fixture.history.path().join(format!("{id}.hctl"));
        std::fs::create_dir_all(&control).unwrap();
        std::fs::write(
            control.join("source.json"),
            br#"{"schema_version":3,"incarnation":"00000000-0000-0000-0000-000000000000","deleted":false}"#,
        )
        .unwrap();

        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(&mut service, &fixture.engine, StepBudget::default());
        assert_eq!(progress.phase, BuildPhase::Incomplete);
        assert_eq!(progress.issue_count, 1);
        assert_eq!(progress.issues.len(), 1);
        assert!(
            progress.issues[0].reason.contains(id),
            "reason names the entry: {}",
            progress.issues[0].reason
        );
        assert!(
            progress.issues[0]
                .reason
                .contains("unsupported history source version"),
            "reason carries the validation error: {}",
            progress.issues[0].reason
        );
    }
}
