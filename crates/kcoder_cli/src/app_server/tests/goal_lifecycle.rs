#[test]
fn goal_lifecycle_preserves_permissions_and_rejects_stale_finishes() {
    let temp = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(temp.path(), None);
    engine.state.set_goal("goal one", None);
    let mut lifecycle = goal_lifecycle::GoalLifecycle::default();
    assert!(lifecycle.is_suspended());
    assert!(!lifecycle.pending());
    let ticket = lifecycle.begin(&engine, Some(kcoder_config::PermissionMode::DontAsk), None);
    lifecycle.finish(&engine, ticket, "completed", None);
    assert!(lifecycle.pending());
    assert!(lifecycle.automatic_allowed(&engine));
    let cancel = CancellationToken::new();
    let automatic = lifecycle.begin(&engine, None, Some(cancel.clone()));
    assert_eq!(
        automatic.permission_mode,
        Some(kcoder_config::PermissionMode::DontAsk)
    );
    lifecycle.invalidate();
    assert!(cancel.is_cancelled());
    engine.state.clear_goal();
    engine.state.set_goal("replacement", None);
    lifecycle.finish(&engine, automatic, "interrupted", None);
    assert_eq!(engine.state.goal().unwrap().status, GoalStatus::Active);
    assert!(!lifecycle.pending());
}

#[test]
fn goal_lifecycle_bounds_automatic_turns_without_fabricating_completion() {
    let temp = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(temp.path(), None);
    engine.settings.write().unwrap().goal_max_auto_continuations = 1;
    engine.state.set_goal("one audit", None);
    let mut lifecycle = goal_lifecycle::GoalLifecycle::default();
    assert!(lifecycle.automatic_allowed(&engine));
    let ticket = lifecycle.begin(&engine, None, Some(CancellationToken::new()));
    lifecycle.finish(&engine, ticket, "completed", None);
    assert!(!lifecycle.automatic_allowed(&engine));
    assert!(lifecycle.take_limit_notice(&engine).is_some());
    assert!(lifecycle.take_limit_notice(&engine).is_none());
    assert!(!lifecycle.pending());
    assert_eq!(engine.state.goal().unwrap().status, GoalStatus::Active);
}

#[test]
fn goal_lifecycle_stops_on_budget_and_explicit_suspend() {
    let temp = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(temp.path(), None);
    engine.state.set_goal("budgeted fixture", Some(1));
    let mut lifecycle = goal_lifecycle::GoalLifecycle::default();
    let ticket = lifecycle.begin(&engine, None, None);
    engine.state.account_active_goal_usage(1, 0);
    lifecycle.finish(&engine, ticket, "completed", None);
    assert!(!lifecycle.pending());
    assert!(goal_lifecycle::GoalLifecycle::prompt(&engine).is_none());
    engine.state.clear_goal();
    engine.state.set_goal("suspended fixture", None);
    let ticket = lifecycle.begin(&engine, None, None);
    lifecycle.suspend();
    lifecycle.finish(&engine, ticket, "completed", None);
    assert!(lifecycle.is_suspended());
    assert!(!lifecycle.pending());
}

#[test]
fn goal_lifecycle_pauses_failed_turns_and_never_arms_cleared_or_completed_goals() {
    let temp = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(temp.path(), None);
    for status in ["failed", "interrupted"] {
        engine.state.clear_goal();
        engine.state.set_goal("failing fixture", None);
        let mut lifecycle = goal_lifecycle::GoalLifecycle::default();
        let ticket = lifecycle.begin(&engine, None, None);
        lifecycle.finish(&engine, ticket, status, None);
        assert_eq!(engine.state.goal().unwrap().status, GoalStatus::Paused);
        assert!(!lifecycle.pending());
    }
    for clear in [true, false] {
        engine.state.clear_goal();
        engine.state.set_goal("terminal fixture", None);
        let mut lifecycle = goal_lifecycle::GoalLifecycle::default();
        let ticket = lifecycle.begin(&engine, None, None);
        if clear {
            engine.state.clear_goal();
        } else {
            engine.state.update_goal_status(GoalStatus::Complete);
        }
        lifecycle.finish(&engine, ticket, "completed", None);
        assert!(!lifecycle.pending());
    }
}

#[test]
fn provider_failure_app_server_goal_status_preserves_typed_quota() {
    for automatic in [false, true] {
        for (category, message, expected) in [
            (kcoder_types::ProviderFailureCategory::AuthenticationError, "insufficient_quota usage limit", GoalStatus::Paused),
            (kcoder_types::ProviderFailureCategory::QuotaExceeded, "opaque failure", GoalStatus::UsageLimited),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let engine = runtime_context_test_engine(temp.path(), None);
            engine.state.set_goal("failure fixture", None);
            let mut lifecycle = goal_lifecycle::GoalLifecycle::default();
            let turn = lifecycle.begin(&engine, None, automatic.then(CancellationToken::new));
            let details = kcoder_types::ProviderFailureDetails {
                category,
                recovery_action: kcoder_types::ProviderFailureRecoveryAction::NeedsHuman,
                http_status: None,
                retryable: false,
                resume_safe: false,
                retry_after_ms: None,
            };
            let event = EngineEvent::ProviderFailed { message: message.into(), details: details.clone() };
            let (status, _) = terminal_outcome(&event, false).unwrap();
            lifecycle.finish(&engine, turn, status, Some(&details));
            let goal = engine.state.goal().unwrap();
            assert_eq!(goal.status, expected, "automatic={automatic}, {category:?}");
            assert_eq!(goal.blocked_candidate_count, 0);
            assert!(!lifecycle.pending());
        }
    }
}

#[test]
fn goal_lifecycle_cancelled_wire_state_does_not_resume_or_accept_stale_finish() {
    let temp = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(temp.path(), None);
    engine.state.set_goal("cancel me", None);
    let mut lifecycle = goal_lifecycle::GoalLifecycle::default();
    let ticket = lifecycle.begin(&engine, None, None);
    assert_eq!(parse_goal_status("cancelled").unwrap(), GoalStatus::Cancelled);
    let goal = engine.state.update_goal_status(GoalStatus::Cancelled).unwrap();
    assert!(ensure_goal_status_transition(goal.status, Some(GoalStatus::Active)).is_err());
    assert_eq!(thread_goal("thread", &goal).status, "cancelled");
    lifecycle.finish(&engine, ticket, "completed", None);
    assert!(!lifecycle.pending());
    assert_eq!(engine.state.goal().unwrap().status, GoalStatus::Cancelled);
}
