//! Capture the owning thread state before starting bounded Goal observations.
use super::*;
use kcoder_thread_metadata::goal_batch::{
    self, CapturedBatch, Input, ResidentInput, StateSnapshot,
};
pub(super) use kcoder_thread_metadata::goal_batch::{parse_params, unavailable_result};
use tokio::sync::Semaphore;

/// Only nonblocking State reads and in-memory owner handoffs happen here.
fn capture_inputs(
    ids: &[String],
    workspace_engine: &QueryEngine,
    threads: &ThreadManager,
) -> Option<CapturedBatch> {
    let workspace = StateSnapshot::capture(&workspace_engine.state)?;
    let history_dir = workspace.history_path()?.parent()?;
    let mut inputs = Vec::with_capacity(ids.len());
    for id in ids {
        let input = (|| {
            let history_path = candidate_thread_history_path(history_dir, id).ok()?;
            let resident = match threads.state(id) {
                Some(state) => {
                    let snapshot = StateSnapshot::capture(state)?;
                    if !snapshot.matches_history(id, &history_path) {
                        return None;
                    }
                    let lease = threads.lease(id)?.deferred_witness(&history_path)?;
                    let lineage = snapshot.goal_identity().and_then(|(goal_id, created)| {
                        threads.goal_metadata_observer(id, goal_id, created)
                    });
                    Some(ResidentInput {
                        snapshot,
                        lease,
                        lineage,
                    })
                }
                None => None,
            };
            Some(Input {
                thread_id: id.clone(),
                history_path,
                resident,
            })
        })();
        inputs.push(input);
    }
    Some((workspace, inputs))
}

#[expect(
    clippy::too_many_arguments,
    reason = "Request, connection owner and bounded worker are distinct"
)]
pub(super) fn spawn(
    tasks: &mut tokio::task::JoinSet<()>,
    request_id: Value,
    ids: Vec<String>,
    workspace_engine: &QueryEngine,
    threads: &ThreadManager,
    outbound: mpsc::Sender<Value>,
    connection: Arc<Semaphore>,
    cancellation: CancellationToken,
) {
    goal_batch::spawn(
        tasks,
        request_id,
        ids,
        &mut |ids| capture_inputs(ids, workspace_engine, threads),
        outbound,
        connection,
        cancellation,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_thread_metadata::goal_batch::{MAX_SIDECAR_BYTES, observe_one};

    struct GoalToolProvider(Arc<std::sync::atomic::AtomicUsize>);

    impl kcoder_api::Provider for GoalToolProvider {
        fn name(&self) -> &'static str {
            "owned-goal-tool-provider"
        }

        fn supports_client_runtime_reconfiguration(&self) -> bool {
            false
        }

        fn stream_messages(
            &self,
            _: kcoder_types::MessagesRequest,
        ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            use kcoder_types::{ContentBlock, ContentDelta, StreamEvent, StreamingMessage};
            let first = self.0.fetch_add(1, Ordering::SeqCst) == 0;
            let (block, delta) = if first {
                (
                    ContentBlock::ToolUse {
                        id: "owned-create-goal".into(),
                        name: "create_goal".into(),
                        input: json!({}),
                    },
                    ContentDelta::InputJsonDelta {
                        partial_json: json!({"objective":"owned tool goal"}).to_string(),
                    },
                )
            } else {
                (
                    ContentBlock::Text {
                        text: String::new(),
                    },
                    ContentDelta::TextDelta {
                        text: "owned tool result observed".into(),
                    },
                )
            };
            let events = vec![
                StreamEvent::MessageStart {
                    message: StreamingMessage {
                        id: "owned-message".into(),
                        role: "assistant".into(),
                        content: Vec::new(),
                        model: "owned-model".into(),
                        stop_reason: None,
                        stop_sequence: None,
                        usage: None,
                    },
                },
                StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: block,
                },
                StreamEvent::ContentBlockDelta { index: 0, delta },
                StreamEvent::ContentBlockStop { index: 0 },
                StreamEvent::MessageStop,
            ];
            Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires an isolated owned profile and workspace"]
    async fn accepted_turn_tool_goal_and_later_append_keep_the_original_observer() {
        use kcoder_config::{PermissionMode, Settings};
        use kcoder_engine::WorkspaceRuntimeServices;
        use kcoder_memory::{MemoryManager, MemoryStore};
        use kcoder_permissions::PermissionEngine;
        use kcoder_skills::SkillRegistry;
        use kcoder_tools::{DenyAllUserQuestioner, ToolRegistry};
        use std::sync::atomic::AtomicUsize;

        #[cfg(unix)]
        let root = {
            use std::os::unix::fs::PermissionsExt;
            tempfile::Builder::new()
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap()
        };
        #[cfg(not(unix))]
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("AGENTS.md"), "").unwrap();
        let owner = Arc::new(
            kcoder_config::create_private_temp_dir_in(root.path(), "goal-tool-test").unwrap(),
        );
        let settings = Settings {
            history_enabled: false,
            permission_mode: PermissionMode::Bypass,
            goal_max_auto_continuations: 0,
            ..Default::default()
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let factory = AppServerEngineFactory::new(
            Arc::new(GoalToolProvider(calls.clone())),
            ToolRegistry::new().register(kcoder_tools::goal::CreateGoalTool),
            PermissionEngine::from_settings(&settings),
            settings,
            MemoryManager::global_only(MemoryStore::empty()),
            SkillRegistry::empty(),
            kcoder_plugins::EffectivePluginSnapshot::default(),
            root.path().to_path_buf(),
            None,
            false,
            WorkspaceRuntimeServices::new(root.path(), "owned-goal-tool")
                .with_private_client_storage(owner),
            None,
            root.path().join("short-ids"),
        );
        let mut engine = factory
            .create_new_thread(Arc::new(DenyAllUserQuestioner))
            .unwrap();
        let thread_id = engine.session_id();
        let history = root.path().join(format!("{thread_id}.jsonl"));
        engine.state.with_history_path(&history);
        assert!(!history.exists(), "the first input must create the body");
        let lease = SessionLease::acquire(&history).unwrap();
        let (tx, mut rx) = mpsc::channel(1024);
        let sequence = Arc::new(AtomicU64::new(1));
        let turn_state = ResidentTurnState::new(
            tx.clone(),
            PermissionMode::Bypass,
            Arc::new(AtomicU64::new(2_000_000)),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );
        let runtime = build_resident_thread_runtime(
            engine.clone(),
            lease,
            0,
            turn_state.clone(),
            tx.clone(),
            "owned-server".into(),
            sequence.clone(),
        );
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let mut connection = ConnectionState {
            thread_goal_status_batch_v1: true,
            ..ConnectionState::default()
        };
        let mut attachments = AttachmentDirectories::default();
        crate::app_server::turn_requests::dispatch(
            "turn/start",
            json!("owned-turn"),
            json!({"threadId":thread_id,"input":[{"type":"text","text":"create this goal"}]}),
            &mut engine,
            &factory,
            &tx,
            &mut manager,
            "owned-server",
            &sequence,
            &mut connection,
            &mut attachments,
            None,
        )
        .await
        .unwrap();
        let until = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let event = tokio::time::timeout_at(until, rx.recv())
                .await
                .expect("owned turn timed out")
                .expect("owned event channel closed");
            if event["method"] == "turn/completed" {
                assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
                break;
            }
        }
        let goal = engine.state.goal().expect("real tool did not create Goal");
        assert_eq!(goal.objective, "owned tool goal");
        assert!(calls.load(Ordering::SeqCst) >= 2);
        let mut calls_in_history = 0;
        let mut results_in_history = 0;
        for message in engine.state.messages() {
            let content = match message {
                kcoder_types::Message::Assistant { content, .. }
                | kcoder_types::Message::User { content, .. } => content,
            };
            for block in content {
                match block {
                    kcoder_types::ContentBlock::ToolUse { id, name, .. }
                        if id == "owned-create-goal" && name == "create_goal" =>
                    {
                        calls_in_history += 1;
                    }
                    kcoder_types::ContentBlock::ToolResult {
                        tool_use_id,
                        is_error,
                        ..
                    } if tool_use_id == "owned-create-goal" && is_error == Some(false) => {
                        results_in_history += 1;
                    }
                    _ => {}
                }
            }
        }
        assert_eq!((calls_in_history, results_in_history), (1, 1));
        let attempts = turn_attempts::records(&engine, &thread_id).unwrap();
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].identity.thread_id, thread_id);
        assert_eq!(
            attempts[0].status,
            kcoder_types::TurnAttemptStatus::Completed
        );
        assert!(
            manager
                .goal_metadata_observer(&thread_id, &goal.goal_id, goal.created_at_ms)
                .is_some()
        );
        let control: Value = serde_json::from_slice(
            &std::fs::read(history.with_extension("hctl").join("source.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(control["commit"]["last_operation"]["kind"], "append");
        let (workspace, mut inputs) =
            capture_inputs(std::slice::from_ref(&thread_id), &engine, &manager).unwrap();
        let input = inputs.pop().unwrap().unwrap();
        assert_eq!(
            observe_one(
                &workspace,
                &input,
                &CancellationToken::new(),
                std::time::Instant::now() + Duration::from_secs(3)
            ),
            Some(Some("active".into()))
        );
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn revoked_resident_lineage_can_rearm_without_reviving_its_old_observer() {
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
        let state = kcoder_state::AppState::new(temp.path());
        state.with_history_path(temp.path().join("session.jsonl"));
        state.add_message(kcoder_types::Message::user_text("initial"));
        state.save_history().unwrap();
        let owner = state.inspection_lifecycle_identity();
        let tracker = state
            .try_reserve_native_goal_metadata_lineage(&owner)
            .unwrap()
            .unwrap();
        let original = state.set_goal("original", None);
        let old_observer = tracker.observer();
        let mut resident = Some((
            crate::app_server::thread_runtime::GoalMetadataSubject::Explicit {
                goal_id: original.goal_id,
                created_at_ms: original.created_at_ms,
            },
            tracker,
        ));
        assert!(!crate::app_server::thread_runtime::retire_revoked_goal_lineage(&mut resident));
        for _ in 0..257 {
            state.add_message(kcoder_types::Message::user_text("append"));
            state.flush_history().await.unwrap();
        }
        assert!(crate::app_server::thread_runtime::retire_revoked_goal_lineage(&mut resident));
        assert!(resident.is_none());
        let renewed = state
            .try_reserve_native_goal_metadata_lineage(&owner)
            .unwrap()
            .unwrap();
        state.set_goal("new actual metadata", None);
        assert!(
            renewed
                .try_capture(MAX_SIDECAR_BYTES, || Ok(()))
                .unwrap()
                .is_some()
        );
        assert!(
            old_observer
                .try_capture(MAX_SIDECAR_BYTES, || Ok(()))
                .unwrap()
                .is_none()
        );
    }
}
