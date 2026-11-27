use super::*;
use kcoder_config::{PrivateDirectory, Settings};
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::PermissionEngine;
use kcoder_skills::SkillRegistry;
use kcoder_state::{Task, TaskKind, TaskStatus};
use kcoder_tools::{DenyAllUserQuestioner, ToolRegistry};
fn fixture(
    completed: bool,
) -> (
    tempfile::TempDir,
    QueryEngine,
    BackgroundRunKey,
    SessionLease,
) {
    let temp = tempfile::tempdir().unwrap();
    PrivateDirectory::open_or_create(temp.path()).unwrap();
    let settings = Settings::default();
    let state = kcoder_state::AppState::new(temp.path());
    state.with_history_path(temp.path().join("owned.jsonl"));
    let engine = QueryEngine::new_with_folder_trust(
        Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
            crate::tui_dev_mock::TuiDevScenario::FullTurn,
        )),
        state,
        ToolRegistry::new(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::empty(),
        Arc::new(DenyAllUserQuestioner),
        temp.path().to_path_buf(),
        Some(true),
    );
    let mut task = Task::new("original-child", "Actual owned view");
    task.kind = TaskKind::Subagent;
    task.managed = true;
    task.parent_session_id = Some(engine.session_id());
    let key = engine.state.start_background_task_run(task).unwrap();
    if completed {
        engine
            .state
            .commit_background_terminal(
                &kcoder_types::BackgroundEventIdentity::terminal(key.clone()),
                TaskStatus::Completed,
                None,
            )
            .unwrap();
    }
    let lease = SessionLease::acquire(&engine.session_lease_target()).unwrap();
    (temp, engine, key, lease)
}
#[test]
fn exact_completed_native_owner_survives_read_but_not_foreign_or_replacement_run() {
    let (_temp, engine, key, lease) = fixture(true);
    let guard =
        AgentRunObservation::capture(&engine, &lease, &key.parent_session_id, &key.agent_id, &key)
            .unwrap();
    assert!(guard.verify(&engine).is_ok());
    assert!(verify_state(&engine, "foreign", &key.agent_id, Some(&key)).is_err());
    engine.state.begin_background_run(&key.agent_id).unwrap();
    let error = guard.verify(&engine).unwrap_err();
    assert_eq!(response_code(&error, 0), -32038);
    let closed = guard.closed("original-observer", &error);
    assert_eq!(closed.expected_background_run, key);
    assert_eq!(closed.reason_code, AgentStreamCloseReason::RunChanged);
}

#[tokio::test]
async fn a_completed_exact_observer_does_not_hold_a_live_subscription_slot() {
    let (_temp, engine, key, lease) = fixture(true);
    let exact =
        AgentRunObservation::capture(&engine, &lease, &key.parent_session_id, &key.agent_id, &key)
            .unwrap();
    let subscription = engine
        .subscribe_subagent_conversation(&key.agent_id)
        .unwrap();
    assert!(!subscription.snapshot.active);
    let (outbound, _receiver) = mpsc::channel(4);
    tokio::time::timeout(
        std::time::Duration::from_millis(100),
        super::super::agent_conversation::pump(
            kcoder_app_protocol::AgentStreamSubscribeParams {
                thread_id: key.parent_session_id.clone(),
                agent_id: key.agent_id.clone(),
                subscription_id: "finished-view".into(),
                expected_background_run: Some(key),
                include_reasoning: false,
            },
            subscription,
            engine,
            outbound,
            "owned-server".into(),
            super::super::agent_conversation::StreamObservation::Exact(exact),
        ),
    )
    .await
    .expect("a retained completed stream must not keep polling")
    .unwrap();
}
#[test]
fn observation_does_not_extend_or_rebind_an_original_native_session_lease() {
    let (_temp, engine, key, lease) = fixture(true);
    let guard =
        AgentRunObservation::capture(&engine, &lease, &key.parent_session_id, &key.agent_id, &key)
            .unwrap();
    drop(lease);
    assert!(guard.verify(&engine).is_err());
    let replacement = SessionLease::acquire(&engine.session_lease_target()).unwrap();
    assert!(guard.verify(&engine).is_err());
    assert!(
        AgentRunObservation::capture(
            &engine,
            &replacement,
            &key.parent_session_id,
            &key.agent_id,
            &key
        )
        .is_ok()
    );
}
#[test]
fn exact_output_reads_only_actual_current_per_run_file_and_rejects_legacy_transcript() {
    let (_temp, engine, key, _lease) = fixture(false);
    let legacy = engine.state.subagent_output_path(&key.agent_id);
    let output = legacy
        .parent()
        .unwrap()
        .join("runs")
        .join(&key.run_id)
        .join("output.md");
    let directory = PrivateDirectory::open_or_create(output.parent().unwrap()).unwrap();
    directory
        .atomic_replace(
            std::ffi::OsStr::new("output.md"),
            b"Actual completed original output",
        )
        .unwrap();
    engine
        .state
        .update_task(&key.agent_id, |task| {
            task.output_path = Some(output.clone())
        })
        .unwrap();
    engine
        .state
        .commit_background_terminal(
            &kcoder_types::BackgroundEventIdentity::terminal(key.clone()),
            TaskStatus::Completed,
            Some(output),
        )
        .unwrap();
    let params = kcoder_app_protocol::AgentArtifactReadParams {
        thread_id: key.parent_session_id.clone(),
        agent_id: key.agent_id.clone(),
        kind: None,
        path: None,
        offset: None,
        limit: None,
        revision: None,
        tail: None,
        expected_background_run: Some(key.clone()),
    };
    let actual = super::super::agent_artifacts::read(&engine, &params).unwrap();
    assert_eq!(actual.content, "Actual completed original output");
    assert_eq!(actual.background_run, Some(key.clone()));
    let mut transcript = params.clone();
    transcript.kind = Some(kcoder_app_protocol::AgentArtifactKind::Transcript);
    assert!(super::super::agent_artifacts::read(&engine, &transcript).is_err());
    let (_other_temp, other, other_key, _other_lease) = fixture(false);
    let other_legacy = other.state.subagent_output_path(&other_key.agent_id);
    let legacy_dir = PrivateDirectory::open_or_create(other_legacy.parent().unwrap()).unwrap();
    legacy_dir
        .atomic_replace(std::ffi::OsStr::new("output.md"), b"Unbound legacy output")
        .unwrap();
    other
        .state
        .update_task(&other_key.agent_id, |task| {
            task.output_path = Some(other_legacy.clone())
        })
        .unwrap();
    other
        .state
        .commit_background_terminal(
            &kcoder_types::BackgroundEventIdentity::terminal(other_key.clone()),
            TaskStatus::Completed,
            Some(other_legacy),
        )
        .unwrap();
    let legacy_params = kcoder_app_protocol::AgentArtifactReadParams {
        thread_id: other_key.parent_session_id.clone(),
        agent_id: other_key.agent_id.clone(),
        expected_background_run: Some(other_key),
        ..params
    };
    assert!(super::super::agent_artifacts::read(&other, &legacy_params).is_err());
}

#[tokio::test]
async fn each_stream_reverification_fails_closed_after_run_or_owner_revocation() {
    use super::super::agent_conversation::exact_run_still_current;
    for revoke_owner in [false, true] {
        let (_temp, engine, key, lease) = fixture(true);
        let exact = AgentRunObservation::capture(
            &engine,
            &lease,
            &key.parent_session_id,
            &key.agent_id,
            &key,
        )
        .unwrap();
        let (outbound, mut receiver) = mpsc::channel(4);
        assert!(
            exact_run_still_current(&exact, &engine, &outbound, "live-view")
                .await
                .unwrap()
        );
        assert!(receiver.try_recv().is_err());
        // A previous successful check must not mask the revocation.
        let reason = if revoke_owner {
            drop(lease);
            "owner_unavailable"
        } else {
            engine.state.begin_background_run(&key.agent_id).unwrap();
            "run_changed"
        };
        assert!(
            !exact_run_still_current(&exact, &engine, &outbound, "live-view")
                .await
                .unwrap()
        );
        let closed = receiver.try_recv().unwrap();
        assert_eq!(closed["method"], kcoder_app_protocol::AGENT_STREAM_CLOSED);
        assert_eq!(closed["params"]["subscriptionId"], "live-view");
        assert_eq!(closed["params"]["reasonCode"], reason);
        assert!(receiver.try_recv().is_err());
    }
}

fn test_stream(
    engine: &QueryEngine,
    key: &BackgroundRunKey,
) -> (
    kcoder_app_protocol::AgentStreamSubscribeParams,
    kcoder_engine::agent_conversation_stream::AgentConversationSubscription,
    tokio::sync::broadcast::Sender<
        kcoder_engine::agent_conversation_stream::AgentConversationFrame,
    >,
) {
    let mut subscription = engine
        .subscribe_subagent_conversation(&key.agent_id)
        .unwrap();
    assert!(subscription.snapshot.active);
    let (frames, receiver) = tokio::sync::broadcast::channel(256);
    subscription.receiver = receiver;
    let params = kcoder_app_protocol::AgentStreamSubscribeParams {
        thread_id: key.parent_session_id.clone(),
        agent_id: key.agent_id.clone(),
        subscription_id: "owned-view".into(),
        expected_background_run: Some(key.clone()),
        include_reasoning: true,
    };
    (params, subscription, frames)
}

fn reasoning_frame(
    sequence: u64,
) -> kcoder_engine::agent_conversation_stream::AgentConversationFrame {
    use kcoder_engine::agent_conversation_stream::{
        AgentConversationDelta, AgentConversationFrame,
    };
    AgentConversationFrame {
        sequence,
        occurred_at_ms: 1000 + sequence,
        delta: AgentConversationDelta::ThinkingDelta {
            item_id: "first-item".into(),
            block_id: "first-phase".into(),
            text: format!("delta-{sequence}").into(),
        },
    }
}

#[tokio::test(start_paused = true)]
async fn ready_deltas_publish_together_and_idle_receivers_do_not_wait_for_the_timer() {
    use kcoder_engine::{
        EngineEvent,
        agent_conversation_stream::{AgentConversationDelta, AgentConversationFrame},
    };

    let (_temp, engine, key, lease) = fixture(false);
    let exact =
        AgentRunObservation::capture(&engine, &lease, &key.parent_session_id, &key.agent_id, &key)
            .unwrap();
    let verifications = exact.verifications.clone();
    let before = verifications.load(std::sync::atomic::Ordering::Relaxed);
    let (params, subscription, frames) = test_stream(&engine, &key);
    let mut sequence = subscription.snapshot.sequence;
    for event in [
        EngineEvent::AssistantMessageStarted,
        EngineEvent::AssistantTextDelta("first".into()),
        EngineEvent::AssistantTextDelta("second".into()),
    ] {
        sequence += 1;
        frames
            .send(AgentConversationFrame {
                sequence,
                occurred_at_ms: 1000 + sequence,
                delta: AgentConversationDelta::Event(event),
            })
            .unwrap();
    }
    let (outbound, mut receiver) = mpsc::channel(8);
    let mut pump = Box::pin(super::super::agent_conversation::pump(
        params,
        subscription,
        engine,
        outbound,
        "owned-server".into(),
        super::super::agent_conversation::StreamObservation::Exact(exact),
    ));
    tokio::select! {
        biased;
        result = &mut pump => panic!("observer exited: {result:?}"),
        _ = std::future::ready(()) => {}
    }
    assert_eq!(
        receiver.try_recv().unwrap()["params"]["method"],
        "item/started"
    );
    assert_eq!(
        receiver.try_recv().unwrap()["params"]["params"]["delta"]["text"],
        "first"
    );
    assert_eq!(
        receiver.try_recv().unwrap()["params"]["params"]["delta"]["text"],
        "second"
    );
    assert_eq!(
        verifications.load(std::sync::atomic::Ordering::Relaxed) - before,
        2
    );

    sequence += 1;
    frames
        .send(AgentConversationFrame {
            sequence,
            occurred_at_ms: 1000 + sequence,
            delta: AgentConversationDelta::Event(EngineEvent::AssistantTextDelta("later".into())),
        })
        .unwrap();
    tokio::select! {
        biased;
        result = &mut pump => panic!("observer exited: {result:?}"),
        _ = std::future::ready(()) => {}
    }
    assert_eq!(
        receiver.try_recv().unwrap()["params"]["params"]["delta"]["text"],
        "later"
    );
    assert_eq!(
        verifications.load(std::sync::atomic::Ordering::Relaxed) - before,
        3
    );
}

#[tokio::test]
async fn a_blocked_stream_rechecks_authority_before_releasing_a_private_frame() {
    enum Change {
        Run,
        Owner,
        #[cfg(unix)]
        LeaseFile,
    }
    let changes = [
        Change::Run,
        Change::Owner,
        #[cfg(unix)]
        Change::LeaseFile,
    ];
    for change in changes {
        let (_temp, engine, key, lease) = fixture(false);
        let exact = AgentRunObservation::capture(
            &engine,
            &lease,
            &key.parent_session_id,
            &key.agent_id,
            &key,
        )
        .unwrap();
        let (params, subscription, frames) = test_stream(&engine, &key);
        frames
            .send(reasoning_frame(subscription.snapshot.sequence + 1))
            .unwrap();
        let (outbound, mut receiver) = mpsc::channel(1);
        outbound.try_send(json!("occupied")).unwrap();
        let mut pump = Box::pin(super::super::agent_conversation::pump(
            params,
            subscription,
            engine.clone(),
            outbound,
            "owned-server".into(),
            super::super::agent_conversation::StreamObservation::Exact(exact),
        ));
        tokio::select! {
            biased;
            result = &mut pump => panic!("observer exited before release: {result:?}"),
            _ = std::future::ready(()) => {}
        }
        assert_eq!(
            frames.len(),
            0,
            "the original frame is waiting for outbound capacity"
        );
        let reason = match change {
            Change::Owner => {
                drop(lease);
                "owner_unavailable"
            }
            Change::Run => {
                engine
                    .state
                    .commit_background_terminal(
                        &kcoder_types::BackgroundEventIdentity::terminal(key.clone()),
                        TaskStatus::Completed,
                        None,
                    )
                    .unwrap();
                engine.state.begin_background_run(&key.agent_id).unwrap();
                "run_changed"
            }
            #[cfg(unix)]
            Change::LeaseFile => {
                let path = lease.target().with_extension("lease");
                std::fs::rename(&path, path.with_extension("removed")).unwrap();
                let replacement = SessionLease::acquire(lease.target()).unwrap();
                replacement.native_witness().unwrap();
                "owner_unavailable"
            }
        };
        assert_eq!(receiver.recv().await.unwrap(), json!("occupied"));
        let next = tokio::select! {
            biased;
            value = receiver.recv() => value,
            result = &mut pump => { result.unwrap(); receiver.recv().await }
        }
        .unwrap();
        assert_eq!(next["method"], kcoder_app_protocol::AGENT_STREAM_CLOSED);
        assert_eq!(next["params"]["reasonCode"], reason);
        assert!(receiver.try_recv().is_err());
    }
}

#[tokio::test(start_paused = true)]
async fn a_ready_burst_preserves_all_frames_and_bounds_native_identity_reads() {
    use kcoder_engine::agent_conversation_stream::{
        AgentConversationDelta, AgentConversationFrame,
    };
    let (_temp, engine, key, lease) = fixture(false);
    let exact =
        AgentRunObservation::capture(&engine, &lease, &key.parent_session_id, &key.agent_id, &key)
            .unwrap();
    let verifications = exact.verifications.clone();
    let before = verifications.load(Ordering::Relaxed);
    let (params, subscription, frames) = test_stream(&engine, &key);
    let first = subscription.snapshot.sequence + 1;
    for sequence in first..first + 200 {
        frames.send(reasoning_frame(sequence)).unwrap();
    }
    frames
        .send(AgentConversationFrame {
            sequence: first + 200,
            occurred_at_ms: 1000 + first + 200,
            delta: AgentConversationDelta::Finished {
                status: "completed".into(),
            },
        })
        .unwrap();
    let (outbound, mut receiver) = mpsc::channel(256);
    tokio::time::timeout(
        Duration::from_secs(5),
        super::super::agent_conversation::pump(
            params,
            subscription,
            engine,
            outbound,
            "owned-server".into(),
            super::super::agent_conversation::StreamObservation::Exact(exact),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    for sequence in first..first + 200 {
        let frame = receiver.try_recv().unwrap();
        let params = &frame["params"];
        assert_eq!(frame["method"], method::AGENT_STREAM_EVENT);
        assert_eq!(params["sequence"], sequence);
        assert_eq!(params["occurredAtMs"], 1000 + sequence);
        assert_eq!(
            params["params"]["event"]["text"],
            format!("delta-{sequence}")
        );
    }
    assert_eq!(
        receiver.try_recv().unwrap()["params"]["method"],
        "turn/completed"
    );
    assert!(receiver.try_recv().is_err());
    let checks = verifications.load(Ordering::Relaxed) - before;
    assert!(
        (2..=5).contains(&checks),
        "200 small frames took {checks} full checks"
    );
}

#[tokio::test(start_paused = true)]
async fn a_full_normal_batch_publishes_when_no_extra_fragment_is_ready() {
    let (_temp, engine, key, lease) = fixture(false);
    let exact =
        AgentRunObservation::capture(&engine, &lease, &key.parent_session_id, &key.agent_id, &key)
            .unwrap();
    let (params, subscription, frames) = test_stream(&engine, &key);
    let first = subscription.snapshot.sequence + 1;
    // One immediate fragment, then exactly enough to reach the normal cap.
    for sequence in first..first + 33 {
        frames.send(reasoning_frame(sequence)).unwrap();
    }
    let (outbound, receiver) = mpsc::channel(64);
    let mut pump = Box::pin(super::super::agent_conversation::pump(
        params,
        subscription,
        engine,
        outbound,
        "owned-server".into(),
        super::super::agent_conversation::StreamObservation::Exact(exact),
    ));
    tokio::select! {
        biased;
        result = &mut pump => panic!("stream closed with an open producer: {result:?}"),
        _ = std::future::ready(()) => {}
    }
    assert_eq!(receiver.len(), 33);
}

#[tokio::test]
async fn an_idle_exact_stream_observes_loss_of_the_original_lease() {
    let (_temp, engine, key, lease) = fixture(false);
    let exact =
        AgentRunObservation::capture(&engine, &lease, &key.parent_session_id, &key.agent_id, &key)
            .unwrap();
    let (params, subscription, _frames) = test_stream(&engine, &key);
    let (outbound, mut receiver) = mpsc::channel(4);
    let mut pump = Box::pin(super::super::agent_conversation::pump(
        params,
        subscription,
        engine,
        outbound,
        "owned-server".into(),
        super::super::agent_conversation::StreamObservation::Exact(exact),
    ));
    tokio::select! {
        biased;
        result = &mut pump => panic!("active observer unexpectedly exited: {result:?}"),
        _ = std::future::ready(()) => {}
    }
    drop(lease);
    tokio::time::timeout(Duration::from_secs(2), pump)
        .await
        .unwrap()
        .unwrap();
    let frame = receiver.try_recv().unwrap();
    assert_eq!(frame["method"], kcoder_app_protocol::AGENT_STREAM_CLOSED);
    assert_eq!(frame["params"]["reasonCode"], "owner_unavailable");
}
