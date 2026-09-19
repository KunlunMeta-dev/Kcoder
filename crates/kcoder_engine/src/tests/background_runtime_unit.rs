use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use kcoder_api::ProviderStream;
use kcoder_state::Task;
use std::sync::{Arc, Mutex};

#[test]
fn recent_notification_fallback_keeps_exact_eight_message_window() {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::new(root.path());
    state.add_message(Message::user_text(
        "<subagent_notification id=\"fixture\" status=\"completed\"/>",
    ));
    for _ in 0..7 {
        state.add_message(Message::assistant_text("filler"));
    }
    assert!(QueryEngine::has_recent_background_notification(
        &state, "fixture"
    ));
    state.add_message(Message::assistant_text("filler"));
    assert!(!QueryEngine::has_recent_background_notification(
        &state, "fixture"
    ));
    state.add_message(Message::assistant_text(
        "<subagent_notification id=\"fixture\"/>",
    ));
    assert!(!QueryEngine::has_recent_background_notification(
        &state, "fixture"
    ));
    state.add_message(Message::user_text(
        "<subagent_notification id=\"fixture\"/>",
    ));
    assert!(QueryEngine::has_recent_background_notification(
        &state, "fixture"
    ));
}

#[derive(Debug)]
struct RecordingProvider {
    name: &'static str,
    request: Arc<Mutex<Option<MessagesRequest>>>,
}

impl Provider for RecordingProvider {
    fn name(&self) -> &'static str {
        self.name
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        *self.request.lock().unwrap() = Some(request);
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

fn test_engine(provider: Arc<dyn Provider>, cwd: &std::path::Path) -> QueryEngine {
    TestEngineBuilder::new(cwd)
        .provider(provider)
        .skill_registry(SkillRegistry::empty())
        .build()
}
#[test]
fn artifact_validation_notification_adds_only_one_summary_to_existing_event() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(tmp.path()).build();
    let mut task = Task::new("artifact-job", "observe");
    task.kind = TaskKind::Subagent;
    task.status = TaskStatus::Completed;
    task.artifact_requirements =
        serde_json::from_value(serde_json::json!([{"path":"missing"}])).unwrap();
    engine.state.upsert_task(task.clone());
    let run = engine
        .state
        .begin_artifact_validation(&task.id, &task.artifact_requirements, None)
        .unwrap();
    engine
        .state
        .publish_artifact_validation(
            &task.id,
            kcoder_state::ArtifactValidationReport {
                run,
                observed_at_ms: 1,
                entries: vec![kcoder_state::ArtifactValidationEntry {
                    index: 0,
                    path: "missing".into(),
                    status: kcoder_state::ArtifactValidationStatus::Missing,
                    size_bytes: None,
                    sha256: None,
                }],
            },
        )
        .unwrap();
    for _ in 0..2 {
        QueryEngine::apply_background_event(
            &engine.state,
            BackgroundJobEvent::Completed {
                id: task.id.clone(),
                output: ToolOutput::text("done"),
            },
        );
    }
    let messages = engine.state.messages();
    assert_eq!(messages.len(), 1);
    let text = messages[0].preview(1000);
    assert!(text.contains("artifact_report=\"available\""));
    assert!(text.contains("artifact_failures=\"1\""));
    assert!(!text.contains("missing"));
}

#[test]
fn flush_background_jobs_recovers_final_task_without_broadcast() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let engine = test_engine(provider, tmp.path());
    let mut task = Task::new("job-lost", "lost completion");
    task.status = TaskStatus::Completed;
    task.output = Some("done".to_string());
    task.kind = TaskKind::Subagent;
    engine.state.upsert_task(task);

    let events = engine.flush_background_jobs();
    assert!(matches!(
        events.as_slice(),
        [EngineEvent::BackgroundJobCompleted { id, .. }] if id == "job-lost"
    ));
    assert!(engine.state.messages().iter().any(|m| {
        m.preview(200)
            .contains("<subagent_notification id=\"job-lost\" status=\"completed\"/>")
    }));
    assert!(
        engine
            .state
            .task("job-lost")
            .and_then(|task| task.notification_injected_at_ms)
            .is_some()
    );

    let second = engine.flush_background_jobs();
    assert!(
        second.is_empty(),
        "notification should not be emitted twice: {second:?}"
    );
}

#[test]
fn steer_applied_event_is_presentation_only_and_never_enters_parent_followup() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let engine = test_engine(
        Arc::new(RecordingProvider {
            name: "recording",
            request,
        }),
        tmp.path(),
    );
    let mut task = Task::new("agent-steer-only", "General agent: steer-only event");
    task.kind = TaskKind::Subagent;
    task.managed = true;
    task.status = TaskStatus::Running;
    engine.state.upsert_task(task);

    assert!(
        engine
            .background_jobs
            .report_subagent_steer_applied("agent-steer-only", "msg-1", 0)
    );

    assert!(engine.drain_background_events().is_empty());
    assert!(engine.state.messages().is_empty());
    assert!(engine.flush_background_jobs().is_empty());
}

#[tokio::test]
async fn flush_background_jobs_with_hooks_does_not_recover_duplicate_broadcast() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let engine = test_engine(provider, tmp.path());

    engine
        .background_jobs
        .spawn_subagent_with_id_with_cap(
            "job-dup",
            "duplicate completion",
            Box::pin(async { ToolOutput::text("done") }),
            None,
        )
        .expect("spawn subagent");

    for _ in 0..50 {
        if engine
            .state
            .task("job-dup")
            .is_some_and(|task| task.status == TaskStatus::Completed)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        engine
            .state
            .task("job-dup")
            .is_some_and(|task| task.status == TaskStatus::Completed),
        "subagent should complete before flush"
    );

    let events = engine.flush_background_jobs_with_hooks().await;
    let completed_count = events
        .iter()
        .filter(|event| {
            matches!(
                event,
                EngineEvent::BackgroundJobCompleted { id, .. } if id == "job-dup"
            )
        })
        .count();
    assert_eq!(
        completed_count, 1,
        "completed broadcast should not also be recovered: {events:?}"
    );

    let second = engine.flush_background_jobs_with_hooks().await;
    assert!(
        second.is_empty(),
        "notification should not be emitted twice: {second:?}"
    );
}

#[test]
fn duplicate_completed_event_is_not_emitted_twice() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let engine = test_engine(provider, tmp.path());
    let mut task = Task::new("job-duplicate-event", "duplicate completion");
    task.status = TaskStatus::Completed;
    task.output = Some("done".to_string());
    task.kind = TaskKind::Subagent;
    engine.state.upsert_task(task);
    let event = BackgroundJobEvent::Completed {
        id: "job-duplicate-event".to_string(),
        output: ToolOutput::text("done"),
    };

    let first = QueryEngine::apply_background_event(&engine.state, event.clone());
    let second = QueryEngine::apply_background_event(&engine.state, event);

    assert!(first.is_some(), "the first terminal event must be emitted");
    assert!(
        second.is_none(),
        "a duplicate terminal event must not schedule another follow-up"
    );
}

#[test]
fn tool_background_started_event_is_suppressed() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let engine = test_engine(provider, tmp.path());
    let mut task = Task::new("job-fg", "tool-background:bash: run tests");
    task.status = TaskStatus::Running;
    task.kind = TaskKind::Generic;
    engine.state.upsert_task(task);

    let suppressed = QueryEngine::apply_background_event(
        &engine.state,
        BackgroundJobEvent::Started {
            id: "job-fg".to_string(),
            description: "tool-background:bash: run tests".to_string(),
            continuation: false,
        },
    );
    assert!(
        suppressed.is_none(),
        "foreground tool registrations must not surface a dangling started event"
    );

    let mut subagent = Task::new("job-agent", "Explore agent: inspect");
    subagent.status = TaskStatus::Running;
    subagent.kind = TaskKind::Subagent;
    engine.state.upsert_task(subagent);
    let surfaced = QueryEngine::apply_background_event(
        &engine.state,
        BackgroundJobEvent::Started {
            id: "job-agent".to_string(),
            description: "Explore agent: inspect".to_string(),
            continuation: false,
        },
    );
    assert!(
        surfaced.is_some(),
        "explicit sub-agent jobs must keep their started event"
    );
}

#[test]
fn subagent_notification_includes_output_file_when_present() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let engine = test_engine(provider, tmp.path());
    let mut task = Task::new("job-agent", "Explore agent: inspect project");
    task.status = TaskStatus::Completed;
    task.output = Some("done".to_string());
    task.output_path = Some(
        tmp.path()
            .join(".kcoder/projects/session/subagents/job-agent/output.md"),
    );
    task.kind = kcoder_state::TaskKind::Subagent;
    engine.state.upsert_task(task);

    QueryEngine::apply_background_event(
        &engine.state,
        BackgroundJobEvent::Completed {
            id: "job-agent".to_string(),
            output: ToolOutput::text("done"),
        },
    );

    assert!(engine.state.messages().iter().any(|m| {
        let preview = m.preview(300);
        preview.contains("<subagent_notification id=\"job-agent\" status=\"completed\"")
            && preview.contains("output_file=")
            && preview.contains("subagents/job-agent/output.md")
    }));
}

#[test]
fn workflow_completion_uses_workflow_notification() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let engine = test_engine(provider, tmp.path());
    let mut task = Task::new("workflow-1", "Workflow: review");
    task.status = TaskStatus::Completed;
    task.output_path = Some(tmp.path().join("workflows/workflow-1/output.json"));
    task.kind = kcoder_state::TaskKind::Workflow;
    engine.state.upsert_task(task);

    QueryEngine::apply_background_event(
        &engine.state,
        BackgroundJobEvent::Completed {
            id: "workflow-1".to_string(),
            output: ToolOutput::text("done"),
        },
    );

    let messages = engine.state.messages();
    assert!(messages.iter().any(|message| {
        message
            .preview(300)
            .contains("<workflow_notification id=\"workflow-1\" status=\"completed\"")
    }));
    assert!(!messages.iter().any(|message| {
        message
            .preview(300)
            .contains("<subagent_notification id=\"workflow-1\"")
    }));
    assert!(!engine.background_job_triggers_followup("workflow-1"));
}

#[test]
fn cancelled_workflow_notification_is_not_reported_as_failed() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let engine = test_engine(provider, tmp.path());
    let mut task = Task::new("workflow-cancelled", "Workflow: review");
    task.status = TaskStatus::Cancelled;
    task.kind = TaskKind::Workflow;
    engine.state.upsert_task(task);

    QueryEngine::apply_background_event(
        &engine.state,
        BackgroundJobEvent::Failed {
            id: "workflow-cancelled".to_string(),
            error: "cancelled by user".to_string(),
        },
    );

    let transcript = engine
        .state
        .messages()
        .iter()
        .map(|message| message.preview(500))
        .collect::<String>();
    assert!(transcript.contains("status=\"cancelled\""));
    assert!(!transcript.contains("status=\"failed\""));
    assert!(!engine.background_job_triggers_followup("workflow-cancelled"));
}

#[test]
fn subagent_notification_allows_later_run_with_same_agent_id() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let engine = test_engine(provider, tmp.path());
    engine.state.add_message(Message::user_text(
        "<subagent_notification id=\"job-agent\" status=\"completed\"/>",
    ));

    let mut task = Task::new("job-agent", "General agent: continuation");
    task.status = TaskStatus::Completed;
    task.output = Some("second".to_string());
    task.kind = kcoder_state::TaskKind::Subagent;
    task.run_started_at_ms = Some(300);
    task.notification_injected_at_ms = Some(200);
    engine.state.upsert_task(task);

    QueryEngine::apply_background_event(
        &engine.state,
        BackgroundJobEvent::Completed {
            id: "job-agent".to_string(),
            output: ToolOutput::text("second"),
        },
    );

    let count = engine
        .state
        .messages()
        .iter()
        .filter(|m| {
            m.preview(300)
                .contains("<subagent_notification id=\"job-agent\"")
        })
        .count();
    assert_eq!(count, 2);
}

#[test]
fn internal_background_jobs_do_not_inject_subagent_notification() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let engine = test_engine(provider, tmp.path());
    let mut task = Task::new(
        "job-review",
        format!(
            "{} after 10 tool call(s)",
            crate::skill_review::INTERNAL_SKILL_REVIEW_PREFIX
        ),
    );
    task.status = TaskStatus::Completed;
    task.output = Some("Nothing to save.".to_string());
    engine.state.upsert_task(task);

    let events = engine.flush_background_jobs();
    assert!(matches!(
        events.as_slice(),
        [EngineEvent::BackgroundJobCompleted { id, .. }] if id == "job-review"
    ));
    assert!(
        !engine
            .state
            .messages()
            .iter()
            .any(|m| m.preview(200).contains("<subagent_notification"))
    );
    assert!(
        engine
            .state
            .task("job-review")
            .and_then(|task| task.notification_injected_at_ms)
            .is_some()
    );
}

#[test]
fn tool_background_jobs_inject_task_notification_without_subagent_notification() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let engine = test_engine(provider, tmp.path());
    let mut task = Task::new(
        "job-shell",
        kcoder_tools::background::tool_background_description("bash", "cargo test"),
    );
    task.status = TaskStatus::Completed;
    task.output = Some("stdout:\nok".to_string());
    task.managed = true;
    task.delivery = kcoder_state::TaskDelivery::Background;
    task.output_path = Some(tmp.path().join("session/tasks/job-shell/output.txt"));
    engine.state.upsert_task(task);

    let events = engine.flush_background_jobs();
    assert!(matches!(
        events.as_slice(),
        [EngineEvent::BackgroundJobCompleted { id, .. }] if id == "job-shell"
    ));
    assert!(
        !engine
            .state
            .messages()
            .iter()
            .any(|m| m.preview(200).contains("<subagent_notification"))
    );
    assert!(engine.state.messages().iter().any(|m| {
        let preview = m.preview(500);
        preview.contains("<task_notification id=\"job-shell\" status=\"completed\"")
            && preview.contains("output_file=")
    }));
    assert!(
        engine
            .state
            .task("job-shell")
            .and_then(|task| task.notification_injected_at_ms)
            .is_some()
    );
}

#[tokio::test]
async fn task_output_terminal_delivery_suppresses_later_task_notification() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let engine = test_engine(provider, tmp.path());
    let mut task = Task::new(
        "job-claimed",
        kcoder_tools::background::tool_background_description("ocr", "review"),
    );
    task.managed = true;
    task.delivery = kcoder_state::TaskDelivery::Background;
    task.status = TaskStatus::Completed;
    task.output = Some("done".to_string());
    engine.state.upsert_task(task);

    let ctx = ToolContext::new(engine.state.clone());
    kcoder_tools::TaskOutputTool
        .call(
            serde_json::json!({"task_id": "job-claimed", "block": false}),
            &ctx,
        )
        .await
        .unwrap();

    assert!(!engine.flush_background_jobs().iter().any(|event| {
        matches!(event, EngineEvent::BackgroundJobCompleted { id, .. } if id == "job-claimed")
            || matches!(event, EngineEvent::BackgroundJobFailed { id, .. } if id == "job-claimed")
    }));
    assert!(
        !engine
            .state
            .messages()
            .iter()
            .any(|message| message.preview(300).contains("job-claimed"))
    );
}

#[test]
fn followup_trigger_only_applies_to_subagent_background_jobs() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let engine = test_engine(provider, tmp.path());

    let mut subagent = Task::new("job-agent", "Explore agent: inspect project");
    subagent.status = TaskStatus::Completed;
    subagent.kind = TaskKind::Subagent;
    engine.state.upsert_task(subagent);

    let mut tool_task = Task::new(
        "job-tool",
        kcoder_tools::background::tool_background_description("bash", "cargo test"),
    );
    tool_task.status = TaskStatus::Completed;
    engine.state.upsert_task(tool_task);

    let mut internal = Task::new(
        "job-internal",
        format!(
            "{} after 10 tool call(s)",
            crate::skill_review::INTERNAL_SKILL_REVIEW_PREFIX
        ),
    );
    internal.status = TaskStatus::Completed;
    engine.state.upsert_task(internal);

    assert!(engine.background_job_triggers_followup("job-agent"));
    assert!(!engine.background_job_triggers_followup("job-tool"));
    assert!(!engine.background_job_triggers_followup("job-internal"));
}

#[test]
fn foreground_subagent_completion_does_not_notify_or_trigger_followup() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let engine = test_engine(provider, tmp.path());
    let mut task = Task::new("job-foreground", "General agent: foreground");
    task.kind = TaskKind::Subagent;
    task.status = TaskStatus::Completed;
    task.output = Some("inline result".to_string());
    task.notify_parent_on_completion = false;
    engine.state.upsert_task(task);

    QueryEngine::apply_background_event(
        &engine.state,
        BackgroundJobEvent::Completed {
            id: "job-foreground".to_string(),
            output: ToolOutput::text("inline result"),
        },
    );

    assert!(!engine.background_job_triggers_followup("job-foreground"));
    assert!(!engine.state.messages().iter().any(|message| {
        message
            .preview(300)
            .contains("<subagent_notification id=\"job-foreground\"")
    }));
}

#[test]
fn completion_notification_is_suppressed_after_wait_reported_the_run() {
    let state = kcoder_state::AppState::new("/tmp");
    let mut task = Task::new("job-wait", "Explore agent: survey");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.notify_parent_on_completion = true;
    task.status = kcoder_state::TaskStatus::Completed;
    task.run_started_at_ms = Some(10);
    state.upsert_task(task);

    // Simulate `wait` having reported the terminal state to the parent.
    assert!(state.claim_task_notification_injected("job-wait"));

    let applied = QueryEngine::apply_background_event(
        &state,
        BackgroundJobEvent::Completed {
            id: "job-wait".into(),
            output: ToolOutput::text("done"),
        },
    );
    assert!(
        applied.is_none(),
        "an already-delivered run must not inject a second notification"
    );
}
