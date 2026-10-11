use super::super::context::source_task_is_current;

#[test]
fn foreground_source_is_invalid_after_same_agent_starts_a_new_run() {
    let mut task = kcoder_state::Task::new("actual", "work");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.parent_session_id = Some("parent".into());
    task.run_started_at_ms = Some(10);
    task.status = kcoder_state::TaskStatus::Running;
    let source = kcoder_types::SourceAgent {
        agent_id: "actual".into(),
        parent_session_id: "parent".into(),
        background_run: None,
    };
    assert!(source_task_is_current(&task, &source, Some(10)));
    task.run_started_at_ms = Some(11);
    assert!(!source_task_is_current(&task, &source, Some(10)));
    assert!(!source_task_is_current(&task, &source, None));
    task.run_started_at_ms = Some(10);
    task.kind = kcoder_state::TaskKind::Workflow;
    assert!(!source_task_is_current(&task, &source, Some(10)));
    task.kind = kcoder_state::TaskKind::Subagent;
    task.status = kcoder_state::TaskStatus::Unknown("future_review".into());
    assert!(!source_task_is_current(&task, &source, Some(10)));
    task.status = kcoder_state::TaskStatus::Cancelled;
    assert!(!source_task_is_current(&task, &source, Some(10)));
}
#[test]
fn background_source_requires_exact_owned_run_and_parent() {
    let run = kcoder_types::BackgroundRunKey {
        parent_session_id: "parent".into(),
        agent_id: "actual".into(),
        run_id: "run-1".into(),
    };
    let source = kcoder_types::SourceAgent {
        parent_session_id: "parent".into(),
        agent_id: "actual".into(),
        background_run: Some(run.clone()),
    };
    let mut task = kcoder_state::Task::new("actual", "work");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.parent_session_id = Some("parent".into());
    task.run_started_at_ms = Some(10);
    task.background_run = Some(run);
    assert!(source_task_is_current(&task, &source, Some(10)));
    task.background_run.as_mut().unwrap().run_id = "run-2".into();
    assert!(!source_task_is_current(&task, &source, Some(10)));
    task.background_run = source.background_run.clone();
    task.parent_session_id = Some("other-parent".into());
    assert!(!source_task_is_current(&task, &source, Some(10)));
}
