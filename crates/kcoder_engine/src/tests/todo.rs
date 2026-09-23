#[test]
fn todo_update_reminder_fires_after_twenty_tools_without_todowrite() {
    let tmp = tempfile::tempdir().unwrap();
    let engine =
        test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), Settings::default());
    engine.state.set_todos(vec![TodoItem {
        id: "todo-1".to_string(),
        content: "Run focused tests".to_string(),
        active_form: None,
        status: TodoStatus::InProgress,
    }]);

    let calls =
        vec![("read".to_string(), false); todo_runtime::TODO_UPDATE_REMINDER_TOOL_INTERVAL - 1];
    assert!(engine.todo_update_reminder_after_tools(&calls).is_none());

    let reminder = engine
        .todo_update_reminder_after_tools(&[("grep".to_string(), false)])
        .expect("twentieth tool call should trigger TodoList reminder");
    assert!(reminder.contains("TodoList maintenance reminder"));
    assert!(reminder.contains("20 tool calls"));
    assert!(reminder.contains("Run focused tests"));
    assert!(reminder.contains("call TodoWrite now"));
}

#[test]
fn todo_update_reminder_resets_after_successful_todowrite() {
    let tmp = tempfile::tempdir().unwrap();
    let engine =
        test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), Settings::default());
    engine.state.set_todos(vec![TodoItem {
        id: "todo-1".to_string(),
        content: "Patch renderer".to_string(),
        active_form: None,
        status: TodoStatus::Pending,
    }]);

    let calls = vec![("read".to_string(), false); 10];
    assert!(engine.todo_update_reminder_after_tools(&calls).is_none());
    assert!(
        engine
            .todo_update_reminder_after_tools(&[("TodoWrite".to_string(), false)])
            .is_none()
    );

    let calls =
        vec![("grep".to_string(), false); todo_runtime::TODO_UPDATE_REMINDER_TOOL_INTERVAL - 1];
    assert!(engine.todo_update_reminder_after_tools(&calls).is_none());
    assert!(
        engine
            .todo_update_reminder_after_tools(&[("read".to_string(), false)])
            .is_some()
    );
}

#[test]
fn idle_final_answer_requests_one_todo_review_when_list_was_not_updated() {
    let tmp = tempfile::tempdir().unwrap();
    let engine =
        test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), Settings::default());
    engine.state.set_todos(vec![TodoItem {
        id: "todo-1".to_string(),
        content: "Run focused tests".to_string(),
        active_form: None,
        status: TodoStatus::InProgress,
    }]);

    let reminder = engine
        .todo_idle_update_reminder(false, false)
        .expect("an idle final answer should trigger a one-shot TodoList review");

    assert!(reminder.starts_with("<system-reminder>"));
    assert!(reminder.contains("no TodoWrite update occurred during this turn"));
    assert!(reminder.contains("Run focused tests"));
    assert!(engine.todo_idle_update_reminder(true, false).is_none());
    assert!(engine.todo_idle_update_reminder(false, true).is_none());
}

#[test]
fn idle_todo_review_waits_while_managed_work_is_running() {
    let tmp = tempfile::tempdir().unwrap();
    let engine =
        test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), Settings::default());
    engine.state.set_todos(vec![TodoItem {
        id: "todo-1".to_string(),
        content: "Wait for verifier".to_string(),
        active_form: None,
        status: TodoStatus::Pending,
    }]);
    let mut running = kcoder_state::Task::new("job-1", "background verifier");
    running.managed = true;
    running.status = TaskStatus::Running;
    engine.state.upsert_task(running);

    assert!(engine.todo_idle_update_reminder(false, false).is_none());
}

#[tokio::test]
async fn idle_todo_review_is_sent_back_to_model_once_before_turn_ends() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(TextDraftProvider {
        text: "work is complete".to_string(),
        requests: requests.clone(),
        delay: None,
    });
    let engine = test_engine_with_settings(provider, tmp.path(), Settings::default());
    engine.state.set_todos(vec![TodoItem {
        id: "todo-1".to_string(),
        content: "Update status".to_string(),
        active_form: None,
        status: TodoStatus::InProgress,
    }]);
    engine
        .state
        .add_message(Message::user_text("finish the work"));

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    let requests = requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        2,
        "the reminder must produce one follow-up request"
    );
    assert!(
        requests[1]
            .messages
            .iter()
            .any(|message| message.preview(2_000).contains("<system-reminder>"))
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, EngineEvent::AssistantMessageDone))
            .count(),
        2
    );
}
