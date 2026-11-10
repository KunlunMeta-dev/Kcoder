use super::*;

async fn git_ok(path: &Path, args: &[&str]) -> String {
    let result = run_git_command(path, args, 64 * 1024, Duration::from_secs(15))
        .await
        .unwrap();
    assert!(result.success, "{}", result.stderr);
    result.stdout.as_str().unwrap().trim().to_owned()
}

fn comparison_engine(cwd: &Path, services: kcoder_engine::WorkspaceRuntimeServices) -> QueryEngine {
    let settings = kcoder_config::Settings::default();
    QueryEngine::try_new_for_client_with_services(
        Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
            crate::tui_dev_mock::TuiDevScenario::FullTurn,
        )),
        kcoder_state::AppState::new(cwd),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        cwd.to_path_buf(),
        Some(true),
        services,
    )
    .unwrap()
}

struct ActiveWorkspaceWriter {
    stop: Arc<std::sync::atomic::AtomicBool>,
    writes: Arc<std::sync::atomic::AtomicUsize>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl ActiveWorkspaceWriter {
    async fn start(path: PathBuf) -> Self {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let worker_stop = stop.clone();
        let worker_writes = writes.clone();
        let worker = std::thread::spawn(move || {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .unwrap();
            while !worker_stop.load(std::sync::atomic::Ordering::Acquire) {
                let sequence = worker_writes.load(std::sync::atomic::Ordering::Relaxed);
                file.write_all(&(sequence as u64).to_le_bytes()).unwrap();
                if sequence > 0 && sequence.is_multiple_of(512 * 1024) {
                    file.set_len(0).unwrap();
                }
                worker_writes.fetch_add(1, std::sync::atomic::Ordering::Release);
                std::thread::yield_now();
            }
        });
        let active = Self {
            stop,
            writes,
            worker: Some(worker),
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while active.count() < 16 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "owned writer did not start"
            );
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        active
    }
    fn count(&self) -> usize {
        self.writes.load(std::sync::atomic::Ordering::Acquire)
    }
}
impl Drop for ActiveWorkspaceWriter {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !std::thread::panicking() {
                result.expect("owned active writer failed");
            }
        }
    }
}

#[tokio::test]
async fn task_comparison_real_worktrees_keep_dirty_peers_and_bind_selected_delivery_source() {
    let project = tempfile::tempdir().unwrap();
    const CHILD: &str = "KCODER_TASK_COMPARISON_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let config = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "app_server::task_comparison::tests::task_comparison_real_worktrees_keep_dirty_peers_and_bind_selected_delivery_source", "--nocapture"])
            .env(CHILD, "1").env("KCODER_CONFIG_DIR", config.path()).env_remove("KCODER_HISTORY_DIR").env_remove("KCODER_HOME")
            .status().unwrap();
        assert!(status.success());
        return;
    }
    let services = kcoder_engine::WorkspaceRuntimeServices::try_new_for_client(
        project.path(),
        "task-comparison-test",
    )
    .unwrap();
    let engine = comparison_engine(project.path(), services);
    let owner = engine.session_id();
    engine.state.with_history_path(
        kcoder_config::Settings::project_data_dir(project.path())
            .unwrap()
            .join(format!("{owner}.jsonl")),
    );
    engine.state.add_message(kcoder_types::Message::user_text(
        "compare independent solutions",
    ));
    engine.state.save_history().unwrap();
    git_ok(project.path(), &["init", "--initial-branch=main"]).await;
    git_ok(project.path(), &["config", "user.name", "Comparison Test"]).await;
    git_ok(
        project.path(),
        &["config", "user.email", "comparison@example.invalid"],
    )
    .await;
    std::fs::write(project.path().join("answer.txt"), "baseline\n").unwrap();
    git_ok(project.path(), &["add", "answer.txt"]).await;
    git_ok(project.path(), &["commit", "-m", "baseline"]).await;
    let base = git_ok(project.path(), &["rev-parse", "HEAD"]).await;
    let mut result = Value::Null;
    let mut paths = Vec::new();
    for (index, label) in [(0, "option-a"), (1, "option-b")] {
        let prepared = worktree_request(
            &engine,
            "runtime.worktrees.prepare",
            &json!({
                "deviceId":"test-target", "sourcePath":project.path(), "worktreeId":label,
                "ref":base, "branch":format!("comparison/{label}")
            }),
        )
        .await
        .unwrap();
        let path = prepared["path"].as_str().unwrap().to_owned();
        std::fs::write(
            Path::new(&path).join("answer.txt"),
            format!("solution {index}\n"),
        )
        .unwrap();
        std::fs::write(Path::new(&path).join("keep-untracked.txt"), label).unwrap();
        let task_services = kcoder_engine::WorkspaceRuntimeServices::try_new_for_client(
            Path::new(&path),
            "task-comparison-alternative",
        )
        .unwrap();
        let task_engine = comparison_engine(Path::new(&path), task_services);
        let state = &task_engine.state;
        let thread = task_engine.session_id();
        state.with_history_path(
            kcoder_config::Settings::project_data_dir(&path)
                .unwrap()
                .join(format!("{thread}.jsonl")),
        );
        state.add_message(kcoder_types::Message::user_text("same requirement"));
        state.add_message(kcoder_types::Message::Assistant {
            content: vec![kcoder_types::ContentBlock::Text {
                text: format!("result {index}"),
            }],
            usage: Some(kcoder_types::Usage {
                input_tokens: 10,
                output_tokens: 20,
                total_tokens: None,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                iterations: None,
            }),
        });
        state.save_history().unwrap();
        if index == 0 {
            let receipt = run_git_command(
                Path::new(&path),
                &["diff", "--exit-code"],
                4096,
                Duration::from_secs(15),
            )
            .await
            .unwrap();
            assert_eq!(receipt.exit_code, 1);
            let attempt = kcoder_types::TurnAttemptIdentity {
                thread_id: thread.clone(),
                turn_id: "check-turn".into(),
                attempt_id: "check-attempt".into(),
            };
            let mut tracker = turn_review_evidence::TurnReviewTracker::new(&task_engine, &attempt);
            tracker.observe(
                &task_engine,
                &EngineEvent::ToolUseStarted {
                    id: "actual-diff-check".into(),
                    name: "bash".into(),
                    input: json!({"command":"git diff --exit-code"}),
                },
            );
            let mut output =
                kcoder_tools::ToolOutput::error(receipt.stdout.as_str().unwrap_or_default());
            output
                .execution_metadata
                .push(kcoder_tools::ToolExecutionMetadata::Process {
                    exit_code: Some(receipt.exit_code),
                    signal: None,
                    cwd: PathBuf::from(&path),
                });
            tracker.observe(
                &task_engine,
                &EngineEvent::ToolResult {
                    id: "actual-diff-check".into(),
                    name: "bash".into(),
                    output,
                },
            );
            tracker.settle(&task_engine, false).unwrap();
        }
        let task = format!("test-target:{thread}");
        let linked = worktree_request(&engine, "runtime.worktrees.conversations.link", &json!({
            "path":path, "conversation":{"deviceId":"test-target", "taskId":task, "threadId":thread, "workspacePath":path}
        })).await.unwrap();
        let bind = json!({
            "sourcePath":project.path(), "deviceId":"test-target", "comparisonId":"same-requirement", "ownerThreadId":owner,
            "requirement":"same requirement", "label":label, "path":path,
            "expectedRevision":linked["revision"], "taskId":task, "threadId":thread
        });
        let active = if index == 0 {
            Some(ActiveWorkspaceWriter::start(Path::new(&path).join("active-writing.bin")).await)
        } else {
            None
        };
        let initial_writes = active.as_ref().map_or(0, ActiveWorkspaceWriter::count);
        if active.is_some() {
            let mut stale = bind.clone();
            stale["expectedRevision"] = (linked["revision"].as_u64().unwrap() + 1).into();
            assert!(
                task_comparison_request(&engine, p::TASK_COMPARISON_BIND, &stale)
                    .await
                    .is_err()
            );
            assert!(
                client_worktree_store(&engine).load().unwrap().records[&path]
                    .comparison
                    .is_none()
            );
        }
        result = task_comparison_request(&engine, p::TASK_COMPARISON_BIND, &bind)
            .await
            .unwrap();
        if let Some(active) = &active {
            assert!(
                active.count() > initial_writes,
                "the B workspace writer must remain active during association"
            );
            let candidate = &result["candidates"][0];
            assert_eq!(candidate["binding"]["threadId"], thread);
            assert_eq!(
                candidate["binding"]["branch"],
                format!("comparison/{label}")
            );
            assert_eq!(candidate["binding"]["baseCommit"], base);
            assert!(
                candidate["git"].is_null(),
                "active content must not be presented as a stable content proof"
            );
            assert!(
                candidate["unavailable"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|reason| reason == "git_unavailable")
            );
            let stored = client_worktree_store(&engine).load().unwrap();
            assert_eq!(
                stored.records[&path].comparison.as_ref().unwrap().thread_id,
                thread
            );
            let mut conflicting = bind.clone();
            conflicting["expectedRevision"] = stored.records[&path].revision.into();
            conflicting["label"] = "replace binding without consent".into();
            assert!(
                task_comparison_request(&engine, p::TASK_COMPARISON_BIND, &conflicting)
                    .await
                    .is_err()
            );
        }
        drop(active);
        paths.push(path);
    }
    assert_eq!(result["candidates"].as_array().unwrap().len(), 2);
    assert_eq!(result["candidates"][0]["usage"]["inputTokens"], 10);
    assert!(result["candidates"][0]["usage"]["costMicrousd"].is_null());
    assert_eq!(result["candidates"][0]["checks"][0]["outcome"], "failed");
    assert_eq!(result["candidates"][0]["checks"][0]["exitCode"], 1);
    assert!(
        result["candidates"][1]["checks"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(result["candidates"][1]["evidencePartial"], true);
    assert_eq!(client_worktree_store(&engine).load().unwrap().version, 3);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let marker = project.path().join("filter-executed");
        let script = project.path().join("unsafe-filter.sh");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf forbidden > '{}'\ncat\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        for path in &paths {
            std::fs::write(
                Path::new(path).join(".gitattributes"),
                "*.txt filter=guard\n",
            )
            .unwrap();
        }
        git_ok(
            project.path(),
            &["config", "filter.guard.clean", script.to_str().unwrap()],
        )
        .await;
        git_ok(
            project.path(),
            &["config", "filter.guard.process", script.to_str().unwrap()],
        )
        .await;
        git_ok(project.path(), &["config", "filter.guard.required", "true"]).await;
        git_ok(
            project.path(),
            &["config", "core.fsmonitor", script.to_str().unwrap()],
        )
        .await;
        let before = git_ok(project.path(), &["count-objects", "-v"]).await;
        result = task_comparison_request(&engine, p::TASK_COMPARISON_READ, &json!({
            "sourcePath":project.path(), "deviceId":"test-target", "comparisonId":"same-requirement", "ownerThreadId":owner
        })).await.unwrap();
        assert!(
            result["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .all(|candidate| !candidate["git"].is_null())
        );
        assert!(
            !marker.exists(),
            "comparison reads must not execute repository filters or fsmonitor"
        );
        assert_eq!(
            before,
            git_ok(project.path(), &["count-objects", "-v"]).await
        );
        for key in [
            "filter.guard.clean",
            "filter.guard.process",
            "filter.guard.required",
            "core.fsmonitor",
        ] {
            git_ok(project.path(), &["config", "--unset-all", key]).await;
        }
    }
    let chosen = &result["candidates"][1];
    let select = json!({"sourcePath":project.path(), "deviceId":"test-target", "comparisonId":"same-requirement", "ownerThreadId":owner,
        "threadId":chosen["binding"]["threadId"], "expectedRevision":chosen["revision"],
        "expectedHeadCommit":chosen["git"]["headCommit"], "expectedContentToken":chosen["git"]["contentToken"]});
    task_comparison_request(&engine, p::TASK_COMPARISON_SELECT, &select)
        .await
        .unwrap();
    let selected = selected_comparison_source(&engine, "same-requirement", &owner, "test-target")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        selected.thread_id,
        chosen["binding"]["threadId"].as_str().unwrap()
    );
    assert_eq!(selected.base_commit, base);
    let selected_project =
        kcoder_config::Settings::project_data_dir(&selected.workspace_root).unwrap();
    assert!(selected.history_path.starts_with(&selected_project));
    assert!(
        selected
            .artifact_root
            .starts_with(selected_project.join("client-sessions"))
    );
    assert!(
        !selected
            .artifact_root
            .starts_with(engine.client_storage_root())
    );
    assert!(comparison_task_storage(&engine, &selected.thread_id, project.path()).is_err());
    let _execution_owner = SessionLease::acquire_existing_history(&selected.history_path).unwrap();
    assert!(
        selected_comparison_source(&engine, "same-requirement", &owner, "test-target")
            .await
            .unwrap()
            .is_some()
    );
    for path in &paths {
        assert!(Path::new(path).join("keep-untracked.txt").is_file());
        assert!(
            git_ok(Path::new(path), &["status", "--porcelain"])
                .await
                .contains("answer.txt")
        );
    }
    let wrong_owner = json!({"sourcePath":project.path(), "deviceId":"peer", "comparisonId":"same-requirement", "ownerThreadId":owner});
    assert!(
        task_comparison_request(&engine, p::TASK_COMPARISON_READ, &wrong_owner)
            .await
            .is_err()
    );
    std::fs::write(
        selected.workspace_root.join("answer.txt"),
        "changed after selection",
    )
    .unwrap();
    assert!(
        selected_comparison_source(&engine, "same-requirement", &owner, "test-target")
            .await
            .is_err()
    );
    assert!(
        task_comparison_request(&engine, p::TASK_COMPARISON_SELECT, &select)
            .await
            .is_err()
    );
    assert!(Path::new(&paths[0]).join("keep-untracked.txt").is_file());
}

#[test]
fn task_comparison_checks_never_infer_success_from_model_prose_or_missing_receipts() {
    let usage = p::TaskComparisonUsage::default();
    assert_eq!(usage.input_tokens, None);
    assert_eq!(usage.cost_microusd, None);
    let state = ClientWorktreeState::default();
    assert!(validate_comparison_registry(&state).is_ok());
    assert!(
        matching(
            &state,
            &p::TaskComparisonReadParams {
                source_path: "/test".into(),
                device_id: "test".into(),
                comparison_id: "../escape".into(),
                owner_thread_id: "owner".into()
            }
        )
        .is_err()
    );
}

#[tokio::test]
async fn task_comparison_revision_detects_same_mtime_writes_inventory_changes_without_git_writes() {
    let root = tempfile::tempdir().unwrap();
    git_ok(root.path(), &["init", "--initial-branch=main"]).await;
    git_ok(root.path(), &["config", "user.name", "Revision Test"]).await;
    git_ok(
        root.path(),
        &["config", "user.email", "revision@example.invalid"],
    )
    .await;
    let path = root.path().join("tracked.txt");
    std::fs::write(&path, "one").unwrap();
    git_ok(root.path(), &["add", "tracked.txt"]).await;
    git_ok(root.path(), &["commit", "-m", "base"]).await;
    let before_index = std::fs::read(root.path().join(".git/index")).unwrap();
    let before_objects = git_ok(root.path(), &["count-objects", "-v"]).await;
    let first = worktree_capture::observe_workspace_revision(root.path())
        .await
        .unwrap();
    let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, "two").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(mtime))
        .unwrap();
    let second = worktree_capture::observe_workspace_revision(root.path())
        .await
        .unwrap();
    assert_ne!(first, second);
    let added = root.path().join("untracked.txt");
    std::fs::write(&added, "new").unwrap();
    let third = worktree_capture::observe_workspace_revision(root.path())
        .await
        .unwrap();
    assert_ne!(second, third);
    std::fs::remove_file(&added).unwrap();
    assert_eq!(
        second,
        worktree_capture::observe_workspace_revision(root.path())
            .await
            .unwrap()
    );
    assert_eq!(
        before_index,
        std::fs::read(root.path().join(".git/index")).unwrap()
    );
    assert_eq!(
        before_objects,
        git_ok(root.path(), &["count-objects", "-v"]).await
    );
}

#[cfg(unix)]
#[tokio::test]
async fn task_comparison_revision_refuses_linked_paths() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    git_ok(root.path(), &["init", "--initial-branch=main"]).await;
    let target = outside.path().join("outside.txt");
    std::fs::write(&target, "outside").unwrap();
    let linked = root.path().join("linked.txt");
    std::os::unix::fs::symlink(&target, &linked).unwrap();
    assert!(
        worktree_capture::observe_workspace_revision(root.path())
            .await
            .is_err()
    );
    std::fs::remove_file(&linked).unwrap();
    std::fs::hard_link(&target, &linked).unwrap();
    assert!(
        worktree_capture::observe_workspace_revision(root.path())
            .await
            .is_err()
    );
}
