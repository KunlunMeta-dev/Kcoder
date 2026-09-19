use super::*;

const MAX_SUBAGENT_DELIVERY_BYTES: usize = 64 * 1024;
const MAX_SUBAGENT_DELIVERY_QUEUE_MESSAGES: usize = 64;
const MAX_SUBAGENT_DELIVERY_QUEUE_BYTES: usize = 1024 * 1024;
use sha2::Digest as _;

pub(super) fn persistable_delegated_tasks(tasks: &HashMap<String, Task>) -> HashMap<String, Task> {
    tasks
        .iter()
        .filter(|(_, task)| {
            (task.managed
                && matches!(task.kind, TaskKind::Generic)
                && matches!(task.delivery, TaskDelivery::Background))
                || matches!(task.kind, TaskKind::Subagent)
                || matches!(task.kind, TaskKind::Workflow)
        })
        .map(|(id, task)| (id.clone(), task.clone()))
        .collect()
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    #[test]
    fn task_activity_counts_without_copying_payloads_and_reports_contention() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        assert_eq!(state.try_task_activity_counts(), Some((0, 0)));
        let mut task = subagent_task("running");
        task.output = Some("large output".repeat(100_000));
        state.upsert_task(task);
        state.upsert_task(Task::new("pending", "pending"));
        assert_eq!(state.try_task_activity_counts(), Some((1, 1)));
        let guard = state.write_inner();
        assert!(state.shares_state_with(&state.clone()));
        assert!(!state.shares_state_with(&AppState::new(root.path())));
        assert_eq!(state.try_task_activity_counts(), None);
        drop(guard);
        assert_eq!(state.try_task_activity_counts(), Some((1, 1)));
    }

    fn subagent_task(id: &str) -> Task {
        let mut task = Task::new(id, "General agent: delivery test");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Running;
        task
    }

    #[test]
    fn wait_report_claims_terminal_notification_for_the_current_run() {
        let state = AppState::new("/tmp");
        let mut task = Task::new("job-wait", "Explore agent: survey");
        task.status = TaskStatus::Completed;
        task.run_started_at_ms = Some(10);
        state.upsert_task(task);

        let reported = state.task_for_wait_report("job-wait").expect("task exists");
        assert_eq!(reported.status, TaskStatus::Completed);
        let stored = state.task("job-wait").unwrap();
        assert!(
            stored.notification_injected_at_ms.is_some(),
            "wait must consume the completion notification"
        );

        // A second report must not move the marker again (idempotent per run).
        let first_marker = stored.notification_injected_at_ms;
        let _ = state.task_for_wait_report("job-wait");
        assert_eq!(
            state.task("job-wait").unwrap().notification_injected_at_ms,
            first_marker
        );

        // A later run of the same agent id must be claimable again.
        let mut respawned = state.task("job-wait").unwrap();
        respawned.run_started_at_ms = Some(stored.notification_injected_at_ms.unwrap() + 1);
        state.upsert_task(respawned);
        assert!(
            state.claim_task_notification_injected("job-wait"),
            "a new run must be able to deliver its own notification"
        );
    }

    #[test]
    fn claimed_delivery_remains_durable_until_acknowledged() {
        let state = AppState::new("/tmp/kcoder-delivery-lease");
        state.upsert_task(subagent_task("agent-lease"));

        let receipt = state
            .enqueue_subagent_delivery("agent-lease", "follow up")
            .unwrap()
            .unwrap();
        let claim = state
            .claim_next_subagent_delivery("agent-lease", 120, 8)
            .unwrap();
        let AgentDeliveryClaimOutcome::Claimed(claim) = claim else {
            panic!("expected a claimed delivery")
        };

        assert_eq!(claim.message_id, receipt.message_id);
        assert_eq!(claim.body, "follow up");
        let task = state.task("agent-lease").unwrap();
        assert_eq!(task.message_queue.len(), 1);
        assert_eq!(task.message_queue[0].status, AgentMessageStatus::Leased);

        assert!(
            state
                .ack_subagent_delivery("agent-lease", &claim.message_id, &claim.lease_id,)
                .unwrap()
        );
        assert!(state.task("agent-lease").unwrap().message_queue.is_empty());
    }

    #[test]
    fn failed_delivery_requeues_then_blocks_at_attempt_limit() {
        let state = AppState::new("/tmp/kcoder-delivery-retry");
        state.upsert_task(subagent_task("agent-retry"));
        state
            .enqueue_subagent_delivery("agent-retry", "retry me")
            .unwrap()
            .unwrap();

        let first = state
            .claim_next_subagent_delivery("agent-retry", 120, 2)
            .unwrap();
        let AgentDeliveryClaimOutcome::Claimed(first) = first else {
            panic!("expected first claim")
        };
        assert_eq!(
            state
                .fail_subagent_delivery(
                    "agent-retry",
                    &first.message_id,
                    &first.lease_id,
                    2,
                    "provider timeout",
                )
                .unwrap(),
            AgentDeliveryFailureOutcome::Requeued
        );

        let second = state
            .claim_next_subagent_delivery("agent-retry", 120, 2)
            .unwrap();
        let AgentDeliveryClaimOutcome::Claimed(second) = second else {
            panic!("expected second claim")
        };
        assert_eq!(second.message_id, first.message_id);
        assert_eq!(second.attempts, 2);
        assert_eq!(
            state
                .fail_subagent_delivery(
                    "agent-retry",
                    &second.message_id,
                    &second.lease_id,
                    2,
                    "provider timeout",
                )
                .unwrap(),
            AgentDeliveryFailureOutcome::Blocked
        );
        assert!(matches!(
            state
                .claim_next_subagent_delivery("agent-retry", 120, 2)
                .unwrap(),
            AgentDeliveryClaimOutcome::Blocked { .. }
        ));
    }

    #[test]
    fn expired_lease_recovery_is_audited_before_the_next_claim() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(temp.path());
        state.with_history_path(temp.path().join("session.jsonl"));
        state.enter_orchestrate_before_first_message().unwrap();
        let mut task = subagent_task("agent-expired");
        task.parent_session_id = Some(state.session_id());
        state.upsert_task(task);
        state
            .enqueue_subagent_delivery("agent-expired", "recover this")
            .unwrap()
            .unwrap();
        let first = state
            .claim_next_subagent_delivery("agent-expired", 120, 8)
            .unwrap();
        assert!(matches!(first, AgentDeliveryClaimOutcome::Claimed(_)));
        state.update_task("agent-expired", |task| {
            task.message_queue[0].lease.as_mut().unwrap().expires_at_ms = 0;
        });

        let second = state
            .claim_next_subagent_delivery("agent-expired", 120, 8)
            .unwrap();
        assert!(matches!(second, AgentDeliveryClaimOutcome::Claimed(_)));
        let events = state.read_orchestrate_runtime_events().unwrap();
        assert!(events.iter().any(|event| {
            event.kind == "message_requeued" && event.metadata["source"] == "lease_expired"
        }));
    }

    #[test]
    fn legacy_pending_messages_migrate_in_fifo_order() {
        let mut task = subagent_task("agent-legacy");
        task.pending_messages = vec!["first".to_string(), "second".to_string()];
        assert!(task.migrate_legacy_pending_messages());
        assert!(task.pending_messages.is_empty());
        assert_eq!(
            task.message_queue
                .iter()
                .map(|message| message.body.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert!(
            task.message_queue
                .iter()
                .all(|message| message.status == AgentMessageStatus::Queued)
        );
    }

    #[test]
    fn closing_queue_rejects_late_delivery_without_dropping_blocked_head() {
        let state = AppState::new("/tmp/kcoder-delivery-close");
        state.upsert_task(subagent_task("agent-close"));
        assert!(
            state
                .close_subagent_delivery_queue_if_empty("agent-close")
                .unwrap()
        );
        assert!(
            state
                .enqueue_subagent_delivery("agent-close", "too late")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn closing_nonempty_queue_returns_false_and_keeps_the_worker_contract_open() {
        let state = AppState::new("/tmp/kcoder-delivery-close-race");
        state.upsert_task(subagent_task("agent-close-race"));
        state
            .enqueue_subagent_delivery("agent-close-race", "arrived after empty claim")
            .unwrap()
            .unwrap();

        assert!(
            !state
                .close_subagent_delivery_queue_if_empty("agent-close-race")
                .unwrap()
        );
        let task = state.task("agent-close-race").unwrap();
        assert!(task.accepting_subagent_messages);
        assert_eq!(task.message_queue.len(), 1);
    }

    #[test]
    fn delivery_limits_reject_oversized_messages_without_mutating_the_queue() {
        let state = AppState::new("/tmp/kcoder-delivery-size-limit");
        state.upsert_task(subagent_task("agent-size-limit"));

        let error = state
            .enqueue_subagent_delivery(
                "agent-size-limit",
                "x".repeat(MAX_SUBAGENT_DELIVERY_BYTES + 1),
            )
            .unwrap_err();

        assert!(error.to_string().contains("byte limit"));
        assert!(
            state
                .task("agent-size-limit")
                .unwrap()
                .message_queue
                .is_empty()
        );
    }

    #[test]
    fn delivery_limits_bound_message_count_and_total_bytes() {
        let count_state = AppState::new("/tmp/kcoder-delivery-count-limit");
        count_state.upsert_task(subagent_task("agent-count-limit"));
        for index in 0..MAX_SUBAGENT_DELIVERY_QUEUE_MESSAGES {
            count_state
                .enqueue_subagent_delivery("agent-count-limit", format!("message-{index}"))
                .unwrap()
                .unwrap();
        }
        let error = count_state
            .enqueue_subagent_delivery("agent-count-limit", "overflow")
            .unwrap_err();
        assert!(error.to_string().contains("queue is full"));

        let byte_state = AppState::new("/tmp/kcoder-delivery-byte-limit");
        byte_state.upsert_task(subagent_task("agent-byte-limit"));
        for _ in 0..(MAX_SUBAGENT_DELIVERY_QUEUE_BYTES / MAX_SUBAGENT_DELIVERY_BYTES) {
            byte_state
                .enqueue_subagent_delivery(
                    "agent-byte-limit",
                    "x".repeat(MAX_SUBAGENT_DELIVERY_BYTES),
                )
                .unwrap()
                .unwrap();
        }
        let error = byte_state
            .enqueue_subagent_delivery("agent-byte-limit", "x")
            .unwrap_err();
        assert!(error.to_string().contains("queue exceeds"));
    }

    #[test]
    fn prepare_and_ack_persistence_failures_keep_the_delivery_durable() {
        let tmp = tempfile::tempdir().unwrap();
        let history = tmp.path().join("delivery-failpoints.jsonl");
        let state = AppState::new(tmp.path());
        state.with_history_path(&history);
        state.upsert_task(subagent_task("agent-failpoints"));
        let sidecar = state.session_state_path().unwrap();
        let receipt = state
            .enqueue_subagent_delivery("agent-failpoints", "never disappear")
            .unwrap()
            .unwrap();
        let claim = state
            .claim_next_subagent_delivery("agent-failpoints", 120, 8)
            .unwrap();
        let AgentDeliveryClaimOutcome::Claimed(claim) = claim else {
            panic!("expected a claimed delivery")
        };
        let anchor = TranscriptDeliveryAnchor {
            baseline_message_count: 2,
            baseline_sha256: "baseline".to_string(),
            body_sha256: "body".to_string(),
        };

        {
            let _failpoint = install_atomic_replace_failpoint(sidecar.clone());
            let error = state
                .prepare_subagent_delivery(
                    "agent-failpoints",
                    &receipt.message_id,
                    &claim.lease_id,
                    anchor.clone(),
                )
                .unwrap_err();
            assert!(error.to_string().contains("failed to persist reliable"));
        }
        let task = state.task("agent-failpoints").unwrap();
        assert_eq!(task.message_queue.len(), 1);
        assert_eq!(task.message_queue[0].status, AgentMessageStatus::Leased);
        assert!(task.message_queue[0].transcript_anchor.is_none());

        assert!(
            state
                .prepare_subagent_delivery(
                    "agent-failpoints",
                    &receipt.message_id,
                    &claim.lease_id,
                    anchor.clone(),
                )
                .unwrap()
        );
        {
            let _failpoint = install_atomic_replace_failpoint(sidecar.clone());
            let error = state
                .ack_subagent_delivery("agent-failpoints", &receipt.message_id, &claim.lease_id)
                .unwrap_err();
            assert!(error.to_string().contains("failed to persist reliable"));
        }
        let task = state.task("agent-failpoints").unwrap();
        assert_eq!(task.message_queue.len(), 1);
        assert_eq!(task.message_queue[0].status, AgentMessageStatus::Leased);
        assert_eq!(task.message_queue[0].transcript_anchor, Some(anchor));
        let persisted = load_session_state(&sidecar).unwrap();
        assert_eq!(persisted.tasks["agent-failpoints"].message_queue.len(), 1);
    }

    #[test]
    fn artifact_baseline_claim_publish_and_run_cas() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path());
        state.with_history_path(tmp.path().join("baseline.jsonl"));
        state.upsert_task(subagent_task("baseline"));
        let requirements = vec![
            serde_json::from_value(serde_json::json!({"path":"x","require_changed":true})).unwrap(),
        ];
        state
            .bind_subagent_artifact_requirements("baseline", &requirements)
            .unwrap();
        let (run, created) = state
            .begin_artifact_validation_with_origin(
                "baseline",
                &requirements,
                Some("delivery".into()),
            )
            .unwrap();
        assert!(created);
        let sidecar = state.session_state_path().unwrap();
        {
            let _failpoint = install_atomic_replace_failpoint(sidecar.clone());
            assert!(state.prepare_artifact_baseline("baseline", &run).is_err());
        }
        assert!(state.task("baseline").unwrap().artifact_baseline.is_none());
        assert!(state.prepare_artifact_baseline("baseline", &run).unwrap());
        assert!(!state.prepare_artifact_baseline("baseline", &run).unwrap());
        let baseline = crate::ArtifactBaseline {
            run: run.clone(),
            state: crate::ArtifactBaselineState::Ready,
            entries: vec![crate::ArtifactValidationEntry {
                index: 0,
                path: "x".into(),
                status: crate::ArtifactValidationStatus::Passed,
                size_bytes: Some(3),
                sha256: Some("hash".into()),
            }],
        };
        let mut invalid = baseline.clone();
        invalid.entries[0].path = "wrong".into();
        assert!(
            state
                .publish_artifact_baseline("baseline", invalid)
                .is_err()
        );
        {
            let _failpoint = install_atomic_replace_failpoint(sidecar.clone());
            assert!(
                state
                    .publish_artifact_baseline("baseline", baseline.clone())
                    .is_err()
            );
        }
        assert_eq!(
            state
                .task("baseline")
                .unwrap()
                .artifact_baseline
                .unwrap()
                .state,
            crate::ArtifactBaselineState::Preparing
        );
        assert_eq!(
            state
                .publish_artifact_baseline("baseline", baseline.clone())
                .unwrap(),
            baseline
        );
        let mut changed = baseline.clone();
        changed.entries[0].sha256 = Some("new".into());
        assert_eq!(
            state
                .publish_artifact_baseline("baseline", changed)
                .unwrap(),
            baseline
        );
        assert_eq!(
            state
                .begin_artifact_validation_with_origin(
                    "baseline",
                    &requirements,
                    Some("delivery".into())
                )
                .unwrap(),
            (run.clone(), false)
        );
        assert_eq!(
            load_session_state(&sidecar).unwrap().tasks["baseline"].artifact_baseline,
            Some(baseline.clone())
        );
        let next = state
            .begin_artifact_validation("baseline", &requirements, None)
            .unwrap();
        assert!(state.task("baseline").unwrap().artifact_baseline.is_none());
        assert!(state.prepare_artifact_baseline("baseline", &run).is_err());
        assert!(
            state
                .publish_artifact_baseline("baseline", baseline.clone())
                .is_err()
        );
        let mut unclaimed = baseline;
        unclaimed.run = next;
        assert!(
            state
                .publish_artifact_baseline("baseline", unclaimed)
                .is_err()
        );
        let ephemeral = AppState::new(tmp.path());
        ephemeral.upsert_task(subagent_task("ephemeral-baseline"));
        ephemeral
            .bind_subagent_artifact_requirements("ephemeral-baseline", &requirements)
            .unwrap();
        let run = ephemeral
            .begin_artifact_validation("ephemeral-baseline", &requirements, None)
            .unwrap();
        assert!(
            ephemeral
                .prepare_artifact_baseline("ephemeral-baseline", &run)
                .unwrap()
        );
        let mut baseline = state.task("baseline").unwrap();
        baseline.artifact_requirements[0].path = "changed-declaration".into();
        state.upsert_task(baseline);
        let current_run = state
            .task("baseline")
            .unwrap()
            .artifact_validation_run
            .unwrap();
        assert!(
            state
                .prepare_artifact_baseline("baseline", &current_run)
                .is_err()
        );
    }

    #[test]
    fn artifact_validation_commit_is_durable_idempotent_and_run_bound() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path());
        state.with_history_path(tmp.path().join("artifacts.jsonl"));
        state.upsert_task(subagent_task("artifact"));
        let requirements =
            vec![serde_json::from_value(serde_json::json!({"path":"report.md"})).unwrap()];
        state
            .bind_subagent_artifact_requirements("artifact", &requirements)
            .unwrap();
        let run = state
            .begin_artifact_validation("artifact", &requirements, Some("delivery-1".into()))
            .unwrap();
        let report = crate::ArtifactValidationReport {
            run: run.clone(),
            observed_at_ms: 7,
            entries: vec![crate::ArtifactValidationEntry {
                index: 0,
                path: "report.md".into(),
                status: crate::ArtifactValidationStatus::Missing,
                size_bytes: None,
                sha256: None,
            }],
        };
        let sidecar = state.session_state_path().unwrap();
        {
            let _failpoint = install_atomic_replace_failpoint(sidecar.clone());
            assert!(
                state
                    .publish_artifact_validation("artifact", report.clone())
                    .is_err()
            );
        }
        assert!(
            state
                .task("artifact")
                .unwrap()
                .artifact_validation_report
                .is_none()
        );
        assert!(
            load_session_state(&sidecar).unwrap().tasks["artifact"]
                .artifact_validation_report
                .is_none()
        );
        assert_eq!(
            state
                .publish_artifact_validation("artifact", report.clone())
                .unwrap(),
            report
        );
        assert_eq!(
            state
                .begin_artifact_validation("artifact", &requirements, Some("delivery-1".into()))
                .unwrap(),
            run
        );
        let mut changed_observation = report.clone();
        changed_observation.observed_at_ms = 8;
        assert_eq!(
            state
                .publish_artifact_validation("artifact", changed_observation)
                .unwrap(),
            report
        );
        {
            let _failpoint = install_atomic_replace_failpoint(sidecar.clone());
            assert!(
                state
                    .begin_artifact_validation("artifact", &requirements, None)
                    .is_err()
            );
        }
        assert_eq!(
            state.task("artifact").unwrap().artifact_validation_report,
            Some(report.clone())
        );
        let next = state
            .begin_artifact_validation("artifact", &requirements, None)
            .unwrap();
        assert_ne!(next.run_id, run.run_id);
        assert!(
            state
                .task("artifact")
                .unwrap()
                .artifact_validation_report
                .is_none()
        );
        assert!(
            state
                .publish_artifact_validation("artifact", report)
                .is_err()
        );
        assert!(
            load_session_state(&sidecar).unwrap().tasks["artifact"]
                .artifact_validation_report
                .is_none()
        );
    }

    #[test]
    fn artifact_requirements_binding_rolls_back_atomic_replace_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path());
        state.with_history_path(tmp.path().join("artifact-bind.jsonl"));
        state.upsert_task(subagent_task("artifact-bind"));
        let sidecar = state.session_state_path().unwrap();
        let requirements =
            vec![serde_json::from_value(serde_json::json!({"path":"report.md"})).unwrap()];
        {
            let _failpoint = install_atomic_replace_failpoint(sidecar.clone());
            assert!(
                state
                    .bind_subagent_artifact_requirements("artifact-bind", &requirements)
                    .is_err()
            );
        }
        assert!(
            state
                .task("artifact-bind")
                .unwrap()
                .artifact_requirements
                .is_empty()
        );
        assert!(
            load_session_state(&sidecar).unwrap().tasks["artifact-bind"]
                .artifact_requirements
                .is_empty()
        );
        state
            .bind_subagent_artifact_requirements("artifact-bind", &requirements)
            .unwrap();
        assert_eq!(
            load_session_state(&sidecar).unwrap().tasks["artifact-bind"].artifact_requirements,
            requirements
        );
        {
            let _failpoint = install_atomic_replace_failpoint(sidecar.clone());
            assert!(
                state
                    .bind_subagent_artifact_requirements("artifact-bind", &requirements)
                    .is_err()
            );
        }
        assert_eq!(
            state.task("artifact-bind").unwrap().artifact_requirements,
            requirements
        );
        let changed = vec![serde_json::from_value(serde_json::json!({"path":"other.md"})).unwrap()];
        assert!(
            state
                .bind_subagent_artifact_requirements("artifact-bind", &changed)
                .is_err()
        );
        assert!(
            state
                .bind_subagent_artifact_requirements("missing", &requirements)
                .is_err()
        );
        state.upsert_task(Task::new("generic", "not a subagent"));
        assert!(
            state
                .bind_subagent_artifact_requirements("generic", &requirements)
                .is_err()
        );
        assert_eq!(
            load_session_state(&sidecar).unwrap().tasks["artifact-bind"].artifact_requirements,
            requirements
        );
        let ephemeral = AppState::new(tmp.path());
        ephemeral.upsert_task(subagent_task("ephemeral"));
        ephemeral
            .bind_subagent_artifact_requirements("ephemeral", &requirements)
            .unwrap();
        assert_eq!(
            ephemeral.task("ephemeral").unwrap().artifact_requirements,
            requirements
        );
        assert!(ephemeral.session_state_path().is_none());
    }

    #[test]
    fn control_pause_uses_revision_and_applies_only_at_safe_boundary() {
        let state = AppState::new("/tmp/kcoder-control-pause");
        let mut task = subagent_task("agent-pause");
        task.parent_session_id = Some(state.session_id());
        state.upsert_task(task);
        let receipt = state
            .request_agent_control(
                "agent-pause",
                &state.session_id(),
                AgentControlAction::Pause,
                0,
                "inspect before continuing",
                &[],
                None,
            )
            .unwrap();
        assert_eq!(receipt.run_mode, AgentRunMode::PauseRequested);
        assert_eq!(receipt.status, TaskStatus::Running);
        assert!(
            state
                .request_agent_control(
                    "agent-pause",
                    &state.session_id(),
                    AgentControlAction::Pause,
                    0,
                    "stale",
                    &[],
                    None,
                )
                .is_err()
        );
        assert_eq!(
            state
                .apply_pending_agent_control_at_safe_boundary("agent-pause")
                .unwrap(),
            AgentControlBoundaryOutcome::Paused
        );
        let paused = state.task("agent-pause").unwrap();
        assert_eq!(paused.status, TaskStatus::Paused);
        assert_eq!(paused.control.run_mode, AgentRunMode::Paused);
    }

    #[test]
    fn tool_gate_cannot_expand_spawn_capabilities() {
        let state = AppState::new("/tmp/kcoder-control-gate");
        let mut task = subagent_task("agent-gate");
        task.parent_session_id = Some(state.session_id());
        task.resolved_tool_allowlist = vec!["read".to_string(), "grep".to_string()];
        state.upsert_task(task);
        assert!(
            state
                .request_agent_control(
                    "agent-gate",
                    &state.session_id(),
                    AgentControlAction::GateTools,
                    0,
                    "read-only investigation",
                    &["bash".to_string()],
                    None,
                )
                .is_err()
        );
        let receipt = state
            .request_agent_control(
                "agent-gate",
                &state.session_id(),
                AgentControlAction::GateTools,
                0,
                "read-only investigation",
                &["read".to_string()],
                None,
            )
            .unwrap();
        assert_eq!(receipt.control_revision, 1);
        assert_eq!(
            state.task("agent-gate").unwrap().control.tool_gate,
            ["read"]
        );
    }

    #[test]
    fn discarded_delivery_is_retained_and_explicitly_recoverable() {
        let state = AppState::new("/tmp/kcoder-control-dead-letter");
        let mut task = subagent_task("agent-dead");
        task.parent_session_id = Some(state.session_id());
        state.upsert_task(task);
        let receipt = state
            .enqueue_subagent_delivery("agent-dead", "retain body")
            .unwrap()
            .unwrap();
        state
            .request_agent_control(
                "agent-dead",
                &state.session_id(),
                AgentControlAction::DiscardMessage,
                0,
                "operator discarded blocked work",
                &[],
                Some(&receipt.message_id),
            )
            .unwrap();
        let task = state.task("agent-dead").unwrap();
        assert!(task.message_queue.is_empty());
        assert_eq!(task.dead_letter_messages[0].body, "retain body");
        state
            .request_agent_control(
                "agent-dead",
                &state.session_id(),
                AgentControlAction::RetryMessage,
                1,
                "operator recovered message",
                &[],
                Some(&receipt.message_id),
            )
            .unwrap();
        let task = state.task("agent-dead").unwrap();
        assert!(task.dead_letter_messages.is_empty());
        assert_eq!(task.message_queue[0].status, AgentMessageStatus::Queued);
        assert_eq!(task.message_queue[0].body, "retain body");
    }

    #[test]
    fn permanent_close_retains_every_pending_delivery_in_dead_letter() {
        let state = AppState::new("/tmp/kcoder-delivery-permanent-close");
        let mut task = subagent_task("agent-permanent-close");
        for index in 0..70 {
            // An old sidecar may exceed the new queue limit; permanent closure must still retain every message.
            task.message_queue
                .push(QueuedAgentMessage::new(format!("message-{index}")));
        }
        state.upsert_task(task);

        let ids = state
            .dead_letter_subagent_deliveries_on_close(
                "agent-permanent-close",
                "operator cancelled agent",
            )
            .unwrap();

        assert_eq!(ids.len(), 70);
        let task = state.task("agent-permanent-close").unwrap();
        assert!(task.message_queue.is_empty());
        assert_eq!(task.dead_letter_messages.len(), 70);
        assert!(!task.accepting_subagent_messages);
        assert!(task.dead_letter_messages.iter().all(|message| {
            message.status == AgentMessageStatus::DeadLetter
                && message.last_error.as_deref() == Some("operator cancelled agent")
        }));
    }

    #[test]
    fn halting_an_already_paused_agent_dead_letters_its_queue_immediately() {
        let state = AppState::new("/tmp/kcoder-paused-halt");
        let mut task = subagent_task("agent-paused-halt");
        task.parent_session_id = Some(state.session_id());
        task.status = TaskStatus::Paused;
        task.control.run_mode = AgentRunMode::Paused;
        state.upsert_task(task);
        let receipt = state
            .enqueue_subagent_delivery("agent-paused-halt", "pending while paused")
            .unwrap()
            .unwrap();

        let control = state
            .request_agent_control(
                "agent-paused-halt",
                &state.session_id(),
                AgentControlAction::Halt,
                0,
                "no longer needed",
                &[],
                None,
            )
            .unwrap();

        assert_eq!(control.status, TaskStatus::Halted);
        let task = state.task("agent-paused-halt").unwrap();
        assert!(task.message_queue.is_empty());
        assert_eq!(task.dead_letter_messages.len(), 1);
        assert_eq!(task.dead_letter_messages[0].message_id, receipt.message_id);
    }
}

impl AppState {
    /// Bind or confirm explicit declarations using the reliable task transaction.
    /// Without a configured sidecar, ephemeral sessions retain memory-only semantics.
    pub fn bind_subagent_artifact_requirements(
        &self,
        id: &str,
        requirements: &[ArtifactRequirement],
    ) -> anyhow::Result<()> {
        validate_artifact_requirements(requirements).map_err(anyhow::Error::msg)?;
        self.transact_task(id, |task| {
            if task.kind != TaskKind::Subagent {
                anyhow::bail!("artifact declarations require a sub-agent task");
            }
            if !task.artifact_requirements.is_empty() && task.artifact_requirements != requirements
            {
                anyhow::bail!("artifact_requirements conflict with persisted task declarations");
            }
            task.artifact_requirements = requirements.to_vec();
            Ok(())
        })?
        .with_context(|| format!("agent {id} has no task for artifact declaration binding"))
    }

    /// Start a new observation, or resume the same reliably anchored delivery.
    pub fn begin_artifact_validation(
        &self,
        id: &str,
        requirements: &[ArtifactRequirement],
        delivery_key: Option<String>,
    ) -> anyhow::Result<crate::ArtifactValidationRun> {
        self.begin_artifact_validation_with_origin(id, requirements, delivery_key)
            .map(|(run, _)| run)
    }

    /// Return whether this call created a new execution window.
    pub fn begin_artifact_validation_with_origin(
        &self,
        id: &str,
        requirements: &[ArtifactRequirement],
        delivery_key: Option<String>,
    ) -> anyhow::Result<(crate::ArtifactValidationRun, bool)> {
        validate_artifact_requirements(requirements).map_err(anyhow::Error::msg)?;
        self.transact_task(id, |task| {
            if task.kind != TaskKind::Subagent || task.artifact_requirements != requirements {
                anyhow::bail!("artifact validation declarations changed");
            }
            let declarations_sha256 = crate::artifact_declarations_sha256(requirements);
            if let Some(run) = &task.artifact_validation_run
                && delivery_key.is_some()
                && run.delivery_key == delivery_key
                && run.declarations_sha256 == declarations_sha256
            {
                return Ok((run.clone(), false));
            }
            let run = crate::ArtifactValidationRun {
                run_id: uuid::Uuid::new_v4().to_string(),
                declarations_sha256,
                delivery_key,
            };
            task.artifact_validation_report = None;
            task.artifact_baseline = None;
            task.artifact_validation_run = Some(run.clone());
            Ok((run, true))
        })?
        .context("artifact validation task missing")
    }

    /// Claim a baseline before starting the run; a prior claim is never overwritten.
    pub fn prepare_artifact_baseline(
        &self,
        id: &str,
        run: &crate::ArtifactValidationRun,
    ) -> anyhow::Result<bool> {
        self.transact_task(id, |task| {
            if task.artifact_validation_run.as_ref() != Some(run)
                || crate::artifact_declarations_sha256(&task.artifact_requirements)
                    != run.declarations_sha256
            {
                anyhow::bail!("stale artifact baseline claim");
            }
            if let Some(existing) = &task.artifact_baseline {
                if &existing.run != run {
                    anyhow::bail!("artifact baseline identity mismatch");
                }
                return Ok(false);
            }
            task.artifact_baseline = Some(crate::ArtifactBaseline {
                run: run.clone(),
                state: crate::ArtifactBaselineState::Preparing,
                entries: Vec::new(),
            });
            Ok(true)
        })?
        .context("artifact baseline task missing")
    }

    /// Durably publish the original observation for a previously claimed run.
    pub fn publish_artifact_baseline(
        &self,
        id: &str,
        baseline: crate::ArtifactBaseline,
    ) -> anyhow::Result<crate::ArtifactBaseline> {
        self.transact_task(id, |task| {
            if task.artifact_validation_run.as_ref() != Some(&baseline.run)
                || crate::artifact_declarations_sha256(&task.artifact_requirements)
                    != baseline.run.declarations_sha256
            {
                anyhow::bail!("stale artifact baseline observation");
            }
            if baseline.state != crate::ArtifactBaselineState::Ready
                || baseline.entries.len() > 32
                || baseline.entries.len() != task.artifact_requirements.len()
                || baseline
                    .entries
                    .iter()
                    .zip(&task.artifact_requirements)
                    .enumerate()
                    .any(|(index, (entry, declaration))| {
                        entry.index != index || entry.path != declaration.path
                    })
            {
                anyhow::bail!("artifact baseline entries do not match declarations");
            }
            let existing = task
                .artifact_baseline
                .as_ref()
                .context("artifact baseline not prepared")?;
            if existing.run != baseline.run {
                anyhow::bail!("artifact baseline identity mismatch");
            }
            if existing.state == crate::ArtifactBaselineState::Ready {
                return Ok(existing.clone());
            }
            task.artifact_baseline = Some(baseline.clone());
            Ok(baseline)
        })?
        .context("artifact baseline task missing")
    }

    /// Commit observations before any caller may publish machine acceptance.
    pub fn publish_artifact_validation(
        &self,
        id: &str,
        report: crate::ArtifactValidationReport,
    ) -> anyhow::Result<crate::ArtifactValidationReport> {
        self.transact_task(id, |task| {
            if task.artifact_validation_run.as_ref() != Some(&report.run)
                || crate::artifact_declarations_sha256(&task.artifact_requirements)
                    != report.run.declarations_sha256
            {
                anyhow::bail!("stale artifact validation observation");
            }
            if report.entries.len() != task.artifact_requirements.len()
                || report
                    .entries
                    .iter()
                    .zip(&task.artifact_requirements)
                    .enumerate()
                    .any(|(index, (entry, declaration))| {
                        entry.index != index || entry.path != declaration.path
                    })
            {
                anyhow::bail!("artifact validation entries do not match declarations");
            }
            if let Some(existing) = &task.artifact_validation_report {
                if existing.run != report.run {
                    anyhow::bail!("artifact validation report identity mismatch");
                }
                return Ok(existing.clone());
            }
            task.artifact_validation_report = Some(report.clone());
            Ok(report)
        })?
        .context("artifact validation task missing")
    }

    pub(super) fn transact_task<R>(
        &self,
        id: &str,
        update: impl FnOnce(&mut Task) -> anyhow::Result<R>,
    ) -> anyhow::Result<Option<R>> {
        let _persist = self.lock_session_state_persistence();
        let (state_path, tasks, original, result) = {
            let mut inner = self.write_inner();
            check_direct_history_fault(&inner)?;
            let Some(task) = inner.tasks.get_mut(id) else {
                return Ok(None);
            };
            let original = task.clone();
            let result = match update(task) {
                Ok(result) => result,
                Err(error) => {
                    *task = original;
                    return Err(error);
                }
            };
            (
                SessionTaskPersistence::from_inner(&inner),
                persistable_delegated_tasks(&inner.tasks),
                original,
                result,
            )
        };
        if let Err(error) = persist_session_tasks_result(state_path, tasks) {
            let mut inner = self.write_inner();
            if crate::history_store::is_uncertain_mutation(&error) {
                // Authority may contain the new delivery; preserve it for explicit recovery.
                inner.history_write_fault = Some(format!("{error:#}"));
            } else {
                inner.tasks.insert(id.to_string(), original);
            }
            return Err(error).with_context(|| {
                format!("failed to persist reliable sub-agent delivery state for {id}")
            });
        }
        Ok(Some(result))
    }

    /// Get a clone of the current task map.
    pub fn tasks(&self) -> HashMap<String, Task> {
        self.read_inner().tasks.clone()
    }

    pub fn try_task_activity_counts(&self) -> Option<(usize, usize)> {
        let inner = self.inner.try_read().ok()?;
        let mut pending = 0;
        let mut running = 0;
        for task in inner.tasks.values() {
            match task.status {
                TaskStatus::Pending => pending += 1,
                TaskStatus::Running => running += 1,
                _ => {}
            }
        }
        Some((pending, running))
    }

    /// Read routing metadata without cloning task output or transcript payloads.
    pub fn task_kind(&self, id: &str) -> Option<crate::TaskKind> {
        self.read_inner().tasks.get(id).map(|task| task.kind)
    }

    /// Get a single task by ID, if it exists.
    pub fn task(&self, id: &str) -> Option<Task> {
        self.read_inner().tasks.get(id).cloned()
    }

    /// Insert or update a task.
    pub fn upsert_task(&self, task: Task) {
        let _persist = self.lock_session_state_persistence();
        let (state_path, tasks) = {
            let mut inner = self.write_inner();
            inner.tasks.insert(task.id.clone(), task);
            (
                SessionTaskPersistence::from_inner(&inner),
                persistable_delegated_tasks(&inner.tasks),
            )
        };
        persist_session_tasks(state_path, tasks);
    }

    /// Atomically update one existing task without replacing concurrent status
    /// or output changes made by the background runtime.
    pub fn update_task<R>(&self, id: &str, update: impl FnOnce(&mut Task) -> R) -> Option<R> {
        let _persist = self.lock_session_state_persistence();
        let (state_path, tasks, result) = {
            let mut inner = self.write_inner();
            let task = inner.tasks.get_mut(id)?;
            let result = update(task);
            (
                SessionTaskPersistence::from_inner(&inner),
                persistable_delegated_tasks(&inner.tasks),
                result,
            )
        };
        persist_session_tasks(state_path, tasks);
        Some(result)
    }

    /// Reliably enqueue a message in a sub-agent FIFO.
    ///
    /// Return a receipt only after atomic sidecar replacement succeeds. Return
    /// `Ok(None)` when the queue is closed or the task does not exist; callers must not claim enqueue success.
    pub fn enqueue_subagent_delivery(
        &self,
        id: &str,
        message: impl Into<String>,
    ) -> anyhow::Result<Option<AgentDeliveryEnqueueReceipt>> {
        let message = message.into();
        if message.trim().is_empty() {
            anyhow::bail!("sub-agent delivery message must not be empty");
        }
        if message.len() > MAX_SUBAGENT_DELIVERY_BYTES {
            anyhow::bail!(
                "sub-agent delivery exceeds the {} byte limit",
                MAX_SUBAGENT_DELIVERY_BYTES
            );
        }
        let receipt = self.transact_task(id, move |task| {
            task.migrate_legacy_pending_messages();
            if task.has_delivery_queue_migration_conflict() {
                anyhow::bail!(
                    "sub-agent {id} contains both legacy and reliable message queues; refusing to guess FIFO order"
                );
            }
            if !task.accepting_subagent_messages {
                return Ok(None);
            }
            if task.message_queue.len() >= MAX_SUBAGENT_DELIVERY_QUEUE_MESSAGES {
                anyhow::bail!(
                    "sub-agent delivery queue is full ({} messages)",
                    MAX_SUBAGENT_DELIVERY_QUEUE_MESSAGES
                );
            }
            let queued_bytes = task
                .message_queue
                .iter()
                .try_fold(0usize, |total, queued| total.checked_add(queued.body.len()))
                .ok_or_else(|| anyhow::anyhow!("sub-agent delivery queue byte count overflow"))?;
            if queued_bytes.saturating_add(message.len()) > MAX_SUBAGENT_DELIVERY_QUEUE_BYTES {
                anyhow::bail!(
                    "sub-agent delivery queue exceeds the {} byte limit",
                    MAX_SUBAGENT_DELIVERY_QUEUE_BYTES
                );
            }
            let queued = QueuedAgentMessage::new(message);
            let receipt = AgentDeliveryEnqueueReceipt {
                message_id: queued.message_id.clone(),
                queue_position: task.message_queue.len().saturating_add(1),
            };
            task.message_queue.push(queued);
            task.updated_at_ms = now_millis();
            Ok(Some(receipt))
        })?
        .flatten();
        if let Some(receipt) = receipt.as_ref() {
            let task = self.task(id);
            self.record_orchestrate_runtime_event_after_commit(
                "message_queued",
                task.as_ref()
                    .and_then(|task| task.orchestrate_work_id.as_deref()),
                None,
                Some(id),
                Some(&receipt.message_id),
                serde_json::json!({"queue_position": receipt.queue_position}),
            );
        }
        Ok(receipt)
    }

    /// Claim a persistent lease on the queue-head message, which remains queued until acknowledgement.
    pub fn claim_next_subagent_delivery(
        &self,
        id: &str,
        lease_timeout_seconds: u64,
        max_attempts: u32,
    ) -> anyhow::Result<AgentDeliveryClaimOutcome> {
        let outcome = self.transact_task(id, |task| {
            task.migrate_legacy_pending_messages();
            if task.has_delivery_queue_migration_conflict() {
                anyhow::bail!(
                    "sub-agent {id} contains both legacy and reliable message queues; refusing to claim"
                );
            }
            let now = now_millis();
            let mut recovered_expired_lease = false;
            let Some(message) = task.message_queue.first_mut() else {
                return Ok((AgentDeliveryClaimOutcome::Empty, recovered_expired_lease));
            };
            match message.status {
                AgentMessageStatus::Blocked => {
                    return Ok((
                        AgentDeliveryClaimOutcome::Blocked {
                            message_id: message.message_id.clone(),
                            attempts: message.attempts,
                            last_error: message.last_error.clone(),
                        },
                        recovered_expired_lease,
                    ));
                }
                AgentMessageStatus::Leased => {
                    let Some(lease) = message.lease.as_ref() else {
                        anyhow::bail!(
                            "sub-agent delivery {} is leased without lease metadata",
                            message.message_id
                        );
                    };
                    if lease.expires_at_ms > now {
                        return Ok((
                            AgentDeliveryClaimOutcome::Busy {
                                message_id: message.message_id.clone(),
                                expires_at_ms: lease.expires_at_ms,
                            },
                            recovered_expired_lease,
                        ));
                    }
                    message.status = AgentMessageStatus::Queued;
                    message.lease = None;
                    recovered_expired_lease = true;
                }
                AgentMessageStatus::Queued => {}
                AgentMessageStatus::Acknowledged | AgentMessageStatus::DeadLetter => {
                    anyhow::bail!(
                        "terminal delivery {} remained at the active queue head",
                        message.message_id
                    );
                }
            }
            let max_attempts = max_attempts.max(1);
            if message.attempts >= max_attempts {
                message.status = AgentMessageStatus::Blocked;
                message.updated_at_ms = now;
                return Ok((
                    AgentDeliveryClaimOutcome::Blocked {
                        message_id: message.message_id.clone(),
                        attempts: message.attempts,
                        last_error: message.last_error.clone(),
                    },
                    recovered_expired_lease,
                ));
            }
            let lease_id = format!("lease-{}", uuid::Uuid::new_v4());
            let expires_at_ms = now.saturating_add(lease_timeout_seconds.saturating_mul(1_000));
            message.status = AgentMessageStatus::Leased;
            message.attempts = message.attempts.saturating_add(1);
            message.updated_at_ms = now;
            message.lease = Some(AgentMessageLease {
                lease_id: lease_id.clone(),
                run_started_at_ms: now,
                expires_at_ms,
            });
            task.updated_at_ms = now;
            Ok((
                AgentDeliveryClaimOutcome::Claimed(AgentDeliveryClaim {
                    message_id: message.message_id.clone(),
                    lease_id,
                    body: message.body.clone(),
                    attempts: message.attempts,
                    transcript_anchor: message.transcript_anchor.clone(),
                }),
                recovered_expired_lease,
            ))
        })?;
        let (outcome, recovered_expired_lease) = outcome
            .ok_or_else(|| anyhow::anyhow!("sub-agent {id} disappeared before delivery claim"))?;
        if let AgentDeliveryClaimOutcome::Claimed(claim) = &outcome {
            let task = self.task(id);
            if recovered_expired_lease {
                self.record_orchestrate_runtime_event_after_commit(
                    "message_requeued",
                    task.as_ref()
                        .and_then(|task| task.orchestrate_work_id.as_deref()),
                    None,
                    Some(id),
                    Some(&claim.message_id),
                    serde_json::json!({"source": "lease_expired"}),
                );
            }
            self.record_orchestrate_runtime_event_after_commit(
                "message_leased",
                task.as_ref()
                    .and_then(|task| task.orchestrate_work_id.as_deref()),
                None,
                Some(id),
                Some(&claim.message_id),
                serde_json::json!({"attempts": claim.attempts}),
            );
        }
        Ok(outcome)
    }

    /// Record the transcript baseline before a provider request. Rewriting an identical anchor is idempotent.
    pub fn prepare_subagent_delivery(
        &self,
        id: &str,
        message_id: &str,
        lease_id: &str,
        anchor: TranscriptDeliveryAnchor,
    ) -> anyhow::Result<bool> {
        let result = self.transact_task(id, |task| {
            let Some(message) = task
                .message_queue
                .iter_mut()
                .find(|message| message.message_id == message_id)
            else {
                return Ok(false);
            };
            let lease_matches = message.status == AgentMessageStatus::Leased
                && message
                    .lease
                    .as_ref()
                    .is_some_and(|lease| lease.lease_id == lease_id);
            if !lease_matches {
                anyhow::bail!("delivery {message_id} no longer owns lease {lease_id}");
            }
            if let Some(existing) = message.transcript_anchor.as_ref() {
                if existing != &anchor {
                    anyhow::bail!("delivery {message_id} transcript anchor changed");
                }
                return Ok(true);
            }
            message.transcript_anchor = Some(anchor);
            message.updated_at_ms = now_millis();
            task.updated_at_ms = message.updated_at_ms;
            Ok(true)
        })?;
        let prepared = result.unwrap_or(false);
        if prepared {
            let task = self.task(id);
            self.record_orchestrate_runtime_event_after_commit(
                "message_prepared",
                task.as_ref()
                    .and_then(|task| task.orchestrate_work_id.as_deref()),
                None,
                Some(id),
                Some(message_id),
                serde_json::json!({"transcript_anchor_recorded": true}),
            );
        }
        Ok(prepared)
    }

    /// Acknowledge and compact the queue-head message after a complete child turn succeeds.
    pub fn ack_subagent_delivery(
        &self,
        id: &str,
        message_id: &str,
        lease_id: &str,
    ) -> anyhow::Result<bool> {
        let result = self.transact_task(id, |task| {
            let Some(message) = task.message_queue.first() else {
                return Ok(false);
            };
            if message.message_id != message_id {
                anyhow::bail!(
                    "delivery {message_id} cannot ack ahead of FIFO head {}",
                    message.message_id
                );
            }
            let lease_matches = message.status == AgentMessageStatus::Leased
                && message
                    .lease
                    .as_ref()
                    .is_some_and(|lease| lease.lease_id == lease_id);
            if !lease_matches {
                anyhow::bail!("delivery {message_id} no longer owns lease {lease_id}");
            }
            task.message_queue.remove(0);
            task.updated_at_ms = now_millis();
            Ok(true)
        })?;
        let acknowledged = result.unwrap_or(false);
        if acknowledged {
            let task = self.task(id);
            self.record_orchestrate_runtime_event_after_commit(
                "message_acknowledged",
                task.as_ref()
                    .and_then(|task| task.orchestrate_work_id.as_deref()),
                None,
                Some(id),
                Some(message_id),
                serde_json::json!({"status": "acknowledged"}),
            );
        }
        Ok(acknowledged)
    }

    /// Record a delivery failure. Requeue at the same FIFO head below the limit, and block after reaching it.
    pub fn fail_subagent_delivery(
        &self,
        id: &str,
        message_id: &str,
        lease_id: &str,
        max_attempts: u32,
        error: &str,
    ) -> anyhow::Result<AgentDeliveryFailureOutcome> {
        let result = self.transact_task(id, |task| {
            let Some(message) = task.message_queue.first_mut() else {
                anyhow::bail!("delivery {message_id} disappeared before failure was recorded");
            };
            if message.message_id != message_id {
                anyhow::bail!(
                    "delivery {message_id} cannot fail ahead of FIFO head {}",
                    message.message_id
                );
            }
            let lease_matches = message.status == AgentMessageStatus::Leased
                && message
                    .lease
                    .as_ref()
                    .is_some_and(|lease| lease.lease_id == lease_id);
            if !lease_matches {
                anyhow::bail!("delivery {message_id} no longer owns lease {lease_id}");
            }
            let diagnostic = error.chars().take(2_000).collect::<String>();
            message.last_error = Some(diagnostic);
            message.lease = None;
            message.updated_at_ms = now_millis();
            let outcome = if message.attempts >= max_attempts.max(1) {
                message.status = AgentMessageStatus::Blocked;
                AgentDeliveryFailureOutcome::Blocked
            } else {
                message.status = AgentMessageStatus::Queued;
                AgentDeliveryFailureOutcome::Requeued
            };
            task.updated_at_ms = message.updated_at_ms;
            Ok(outcome)
        })?;
        let outcome = result
            .ok_or_else(|| anyhow::anyhow!("sub-agent {id} disappeared before delivery failure"))?;
        let task = self.task(id);
        let kind = if outcome == AgentDeliveryFailureOutcome::Blocked {
            "message_blocked"
        } else {
            "message_requeued"
        };
        self.record_orchestrate_runtime_event_after_commit(
            kind,
            task.as_ref()
                .and_then(|task| task.orchestrate_work_id.as_deref()),
            None,
            Some(id),
            Some(message_id),
            serde_json::json!({
                "outcome": format!("{outcome:?}").to_ascii_lowercase(),
                "error_sha256": format!("{:x}", sha2::Sha256::digest(error.as_bytes())),
            }),
        );
        Ok(outcome)
    }

    /// After the owning process exits, old leases have no valid worker and recover to queued or blocked.
    pub fn recover_interrupted_subagent_deliveries(
        &self,
        id: &str,
        max_attempts: u32,
    ) -> anyhow::Result<usize> {
        let result = self.transact_task(id, |task| {
            if task.has_delivery_queue_migration_conflict() {
                anyhow::bail!("sub-agent {id} has conflicting delivery queues");
            }
            let interrupted_message_ids = task
                .message_queue
                .iter()
                .filter(|message| message.status == AgentMessageStatus::Leased)
                .map(|message| message.message_id.clone())
                .collect::<Vec<_>>();
            let recovered = task.recover_interrupted_deliveries(max_attempts);
            let outcomes = interrupted_message_ids
                .into_iter()
                .filter_map(|message_id| {
                    task.message_queue
                        .iter()
                        .find(|message| message.message_id == message_id)
                        .map(|message| (message_id, message.status))
                })
                .collect::<Vec<_>>();
            Ok((recovered, outcomes))
        })?;
        let Some((recovered, outcomes)) = result else {
            return Ok(0);
        };
        let task = self.task(id);
        for (message_id, status) in outcomes {
            self.record_orchestrate_runtime_event_after_commit(
                if status == AgentMessageStatus::Blocked {
                    "message_blocked"
                } else {
                    "message_requeued"
                },
                task.as_ref()
                    .and_then(|task| task.orchestrate_work_id.as_deref()),
                None,
                Some(id),
                Some(&message_id),
                serde_json::json!({"source": "process_restart_lease_recovery"}),
            );
        }
        Ok(recovered)
    }

    /// Preserve every unacknowledged delivery in dead-letter storage when permanently closing an agent.
    ///
    /// This operation does not truncate messages. Cancellation or halt cannot silently discard user instructions because of capacity limits.
    pub fn dead_letter_subagent_deliveries_on_close(
        &self,
        id: &str,
        reason: &str,
    ) -> anyhow::Result<Vec<String>> {
        let reason = reason.chars().take(2_000).collect::<String>();
        let result = self.transact_task(id, |task| {
            task.migrate_legacy_pending_messages();
            if task.has_delivery_queue_migration_conflict() {
                anyhow::bail!(
                    "sub-agent {id} has conflicting delivery queues; permanent close refuses to guess order"
                );
            }
            let now = now_millis();
            let mut message_ids = Vec::with_capacity(task.message_queue.len());
            for mut message in task.message_queue.drain(..) {
                message.status = AgentMessageStatus::DeadLetter;
                message.lease = None;
                message.last_error = Some(reason.clone());
                message.updated_at_ms = now;
                message_ids.push(message.message_id.clone());
                task.dead_letter_messages.push(message);
            }
            task.accepting_subagent_messages = false;
            task.updated_at_ms = now;
            Ok(message_ids)
        })?;
        let message_ids = result.unwrap_or_default();
        let task = self.task(id);
        for message_id in &message_ids {
            self.record_orchestrate_runtime_event_after_commit(
                "message_dead_lettered",
                task.as_ref()
                    .and_then(|task| task.orchestrate_work_id.as_deref()),
                None,
                Some(id),
                Some(message_id),
                serde_json::json!({
                    "source": "permanent_agent_close",
                    "reason_sha256": format!("{:x}", sha2::Sha256::digest(reason.as_bytes())),
                }),
            );
        }
        Ok(message_ids)
    }

    /// Close the queue only when it has no queued, leased, or blocked messages.
    pub fn close_subagent_delivery_queue_if_empty(&self, id: &str) -> anyhow::Result<bool> {
        let result = self.transact_task(id, |task| {
            task.migrate_legacy_pending_messages();
            if task.has_delivery_queue_migration_conflict() {
                anyhow::bail!("sub-agent {id} has conflicting delivery queues");
            }
            if !task.message_queue.is_empty() {
                return Ok(false);
            }
            task.accepting_subagent_messages = false;
            task.updated_at_ms = now_millis();
            Ok(true)
        })?;
        Ok(result.unwrap_or(false))
    }

    /// Reopen the reliable queue for a completed or failed agent that remains resumable.
    pub fn reopen_subagent_delivery_queue(&self, id: &str) -> anyhow::Result<bool> {
        let result = self.transact_task(id, |task| {
            if matches!(task.status, TaskStatus::Cancelled) {
                return Ok(false);
            }
            task.migrate_legacy_pending_messages();
            if task.has_delivery_queue_migration_conflict() {
                anyhow::bail!("sub-agent {id} has conflicting delivery queues");
            }
            task.accepting_subagent_messages = true;
            task.updated_at_ms = now_millis();
            Ok(true)
        })?;
        Ok(result.unwrap_or(false))
    }

    /// Record the child's actual tool set at spawn time; the control plane may only restrict it further.
    pub fn record_agent_resolved_tool_allowlist(
        &self,
        id: &str,
        tools: Vec<String>,
    ) -> anyhow::Result<bool> {
        let result = self.transact_task(id, |task| {
            if task.kind != TaskKind::Subagent {
                return Ok(false);
            }
            let mut tools = tools;
            tools.sort();
            tools.dedup();
            if task.resolved_tool_allowlist.is_empty() {
                task.resolved_tool_allowlist = tools;
            } else if task.resolved_tool_allowlist != tools {
                anyhow::bail!("sub-agent {id} resolved tool allowlist changed after spawn");
            }
            task.updated_at_ms = now_millis();
            Ok(true)
        })?;
        Ok(result.unwrap_or(false))
    }

    /// Submit a control request for one agent using revision CAS.
    #[allow(clippy::too_many_arguments)]
    pub fn request_agent_control(
        &self,
        id: &str,
        parent_session_id: &str,
        action: AgentControlAction,
        expected_control_revision: u64,
        reason: &str,
        tools: &[String],
        message_id: Option<&str>,
    ) -> anyhow::Result<AgentControlReceipt> {
        let parent_session_id = parent_session_id.to_string();
        let reason = bounded_control_reason(reason);
        let tools = tools.to_vec();
        let message_id = message_id.map(ToOwned::to_owned);
        let receipt = self.transact_task(id, |task| {
            if task.kind != TaskKind::Subagent
                || task.parent_session_id.as_deref() != Some(parent_session_id.as_str())
            {
                anyhow::bail!("sub-agent {id} is not owned by session {parent_session_id}");
            }
            if task.control.revision != expected_control_revision {
                anyhow::bail!(
                    "stale control revision for {id}: expected {expected_control_revision}, current {}",
                    task.control.revision
                );
            }
            match action {
                AgentControlAction::Pause => {
                    if !matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
                        || task.control.run_mode != AgentRunMode::Running
                    {
                        anyhow::bail!("sub-agent {id} is not actively running");
                    }
                    task.control.run_mode = AgentRunMode::PauseRequested;
                }
                AgentControlAction::Resume => {
                    if task.status != TaskStatus::Paused
                        || task.control.run_mode != AgentRunMode::Paused
                    {
                        anyhow::bail!("sub-agent {id} is not paused");
                    }
                    task.control.run_mode = AgentRunMode::Running;
                // Only an operator can explicitly resume a breaker pause. Resuming
                // opens a new observation window while retaining the manual tool gate,
                // so automatic state cleanup cannot expand privileges.
                    if task.breaker.stage == BreakerStage::Paused {
                        task.breaker.stage = BreakerStage::Healthy;
                        task.breaker.repeated_action_count = 0;
                        task.breaker.consecutive_runtime_errors = 0;
                        task.breaker.no_progress_rounds = 0;
                        task.breaker.reason_codes.clear();
                        task.breaker.tool_gate.clear();
                        task.breaker.last_action_fingerprint = None;
                        task.breaker.last_tool_result_fingerprint = None;
                        task.breaker.last_progress_fingerprint = None;
                        task.breaker.last_evaluated_signal_sequence =
                            task.breaker.signal_sequence;
                        task.control.pending_steer = None;
                    }
                }
                AgentControlAction::Halt => {
                    if task.status == TaskStatus::Paused
                        && task.control.run_mode == AgentRunMode::Paused
                    {
                        task.status = TaskStatus::Halted;
                        task.control.run_mode = AgentRunMode::Halted;
                        task.accepting_subagent_messages = false;
                    } else if matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
                        && matches!(
                            task.control.run_mode,
                            AgentRunMode::Running | AgentRunMode::PauseRequested
                        )
                    {
                        task.control.run_mode = AgentRunMode::HaltRequested;
                    } else {
                        anyhow::bail!("sub-agent {id} cannot be halted from its current state");
                    }
                }
                AgentControlAction::GateTools => {
                    if tools.is_empty() {
                        anyhow::bail!("gate_tools requires a non-empty tools list");
                    }
                    if task.resolved_tool_allowlist.is_empty() {
                        anyhow::bail!("sub-agent {id} has no persisted resolved tool allowlist");
                    }
                    let mut requested = tools.clone();
                    requested.sort();
                    requested.dedup();
                    if let Some(tool) = requested.iter().find(|tool| {
                        !task.resolved_tool_allowlist.iter().any(|owned| owned == *tool)
                    }) {
                        anyhow::bail!("tool {tool:?} was not granted to sub-agent {id} at spawn");
                    }
                    task.control.tool_gate = requested;
                }
                AgentControlAction::ClearToolGate => {
                    task.control.tool_gate.clear();
                }
                AgentControlAction::RetryMessage => {
                    if matches!(task.status, TaskStatus::Halted | TaskStatus::Cancelled) {
                        anyhow::bail!(
                            "sub-agent {id} is permanently stopped; retry requires a new agent"
                        );
                    }
                    let message_id = message_id
                        .as_deref()
                        .context("retry_message requires message_id")?;
                    if let Some(message) = task
                        .message_queue
                        .iter_mut()
                        .find(|message| message.message_id == message_id)
                    {
                        if message.status != AgentMessageStatus::Blocked {
                            anyhow::bail!("delivery {message_id} is not blocked");
                        }
                        message.status = AgentMessageStatus::Queued;
                        message.attempts = 0;
                        message.lease = None;
                        message.updated_at_ms = now_millis();
                    } else if let Some(index) = task
                        .dead_letter_messages
                        .iter()
                        .position(|message| message.message_id == message_id)
                    {
                        let mut message = task.dead_letter_messages.remove(index);
                        message.status = AgentMessageStatus::Queued;
                        message.attempts = 0;
                        message.lease = None;
                        message.updated_at_ms = now_millis();
                        task.message_queue.push(message);
                    } else {
                        anyhow::bail!("delivery {message_id} was not found");
                    }
                    task.accepting_subagent_messages = true;
                }
                AgentControlAction::DiscardMessage => {
                    let message_id = message_id
                        .as_deref()
                        .context("discard_message requires message_id")?;
                    let Some(index) = task
                        .message_queue
                        .iter()
                        .position(|message| message.message_id == message_id)
                    else {
                        anyhow::bail!("active delivery {message_id} was not found");
                    };
                    let mut message = task.message_queue.remove(index);
                    message.status = AgentMessageStatus::DeadLetter;
                    message.lease = None;
                    message.updated_at_ms = now_millis();
                    task.dead_letter_messages.push(message);
                }
            }
            let now = now_millis();
            task.control.revision = task.control.revision.saturating_add(1);
            task.control.requested_by_session_id = parent_session_id.clone();
            task.control.updated_at_ms = now;
            task.control.reason = Some(reason.clone());
            task.updated_at_ms = now;
            Ok(AgentControlReceipt {
                agent_id: id.to_string(),
                action,
                control_revision: task.control.revision,
                run_mode: task.control.run_mode,
                status: task.status,
                message_id: message_id.clone(),
            })
        })?;
        let receipt = receipt
            .ok_or_else(|| anyhow::anyhow!("sub-agent {id} disappeared during control request"))?;
        if action == AgentControlAction::Halt && receipt.status == TaskStatus::Halted {
            self.dead_letter_subagent_deliveries_on_close(id, "agent was gracefully halted")?;
        }
        let task = self.task(id);
        let kind = match action {
            AgentControlAction::RetryMessage => "message_requeued",
            AgentControlAction::DiscardMessage => "message_dead_lettered",
            _ => "control_requested",
        };
        self.record_orchestrate_runtime_event_after_commit(
            kind,
            task.as_ref()
                .and_then(|task| task.orchestrate_work_id.as_deref()),
            None,
            Some(id),
            message_id.as_deref(),
            serde_json::json!({
                "action": format!("{action:?}").to_ascii_lowercase(),
                "source": match action {
                    AgentControlAction::RetryMessage => "explicit_retry",
                    AgentControlAction::DiscardMessage => "explicit_discard",
                    _ => "parent_control",
                },
                "control_revision": receipt.control_revision,
                "reason_sha256": format!("{:x}", sha2::Sha256::digest(reason.message.as_bytes())),
            }),
        );
        Ok(receipt)
    }

    /// Let a child claim pause/halt requests at complete provider/tool boundaries.
    pub fn apply_pending_agent_control_at_safe_boundary(
        &self,
        id: &str,
    ) -> anyhow::Result<AgentControlBoundaryOutcome> {
        if !self.task(id).is_some_and(|task| {
            matches!(
                task.control.run_mode,
                AgentRunMode::PauseRequested | AgentRunMode::HaltRequested
            )
        }) {
            return Ok(AgentControlBoundaryOutcome::Continue);
        }
        let result = self.transact_task(id, |task| {
            let now = now_millis();
            let outcome = match task.control.run_mode {
                AgentRunMode::PauseRequested => {
                    task.control.run_mode = AgentRunMode::Paused;
                    task.status = TaskStatus::Paused;
                    AgentControlBoundaryOutcome::Paused
                }
                AgentRunMode::HaltRequested => {
                    task.control.run_mode = AgentRunMode::Halted;
                    task.status = TaskStatus::Halted;
                    task.accepting_subagent_messages = false;
                    AgentControlBoundaryOutcome::Halted
                }
                _ => AgentControlBoundaryOutcome::Continue,
            };
            if outcome != AgentControlBoundaryOutcome::Continue {
                task.control.revision = task.control.revision.saturating_add(1);
                task.control.updated_at_ms = now;
                task.updated_at_ms = now;
            }
            Ok(outcome)
        })?;
        let outcome = result.unwrap_or(AgentControlBoundaryOutcome::Continue);
        if outcome != AgentControlBoundaryOutcome::Continue {
            let task = self.task(id);
            self.record_orchestrate_runtime_event_after_commit(
                "control_applied",
                task.as_ref()
                    .and_then(|task| task.orchestrate_work_id.as_deref()),
                None,
                Some(id),
                None,
                serde_json::json!({
                    "outcome": format!("{outcome:?}").to_ascii_lowercase(),
                    "control_revision": task.as_ref().map(|task| task.control.revision),
                }),
            );
        }
        Ok(outcome)
    }

    /// Restore Paused after a resume respawn failure, rolling back only this control revision.
    pub fn rollback_agent_resume(
        &self,
        id: &str,
        parent_session_id: &str,
        expected_control_revision: u64,
        error: &str,
    ) -> anyhow::Result<bool> {
        let result = self.transact_task(id, |task| {
            if task.parent_session_id.as_deref() != Some(parent_session_id)
                || task.status != TaskStatus::Paused
                || task.control.run_mode != AgentRunMode::Running
                || task.control.revision != expected_control_revision
            {
                return Ok(false);
            }
            task.control.run_mode = AgentRunMode::Paused;
            task.control.revision = task.control.revision.saturating_add(1);
            task.control.reason = Some(bounded_control_reason(error));
            task.control.updated_at_ms = now_millis();
            task.updated_at_ms = task.control.updated_at_ms;
            Ok(true)
        })?;
        Ok(result.unwrap_or(false))
    }

    /// Compatibility wrapper for the old API; new runtimes must retain and use the message ID from the receipt.
    pub fn enqueue_subagent_message(&self, id: &str, message: impl Into<String>) -> Option<usize> {
        self.enqueue_subagent_delivery(id, message)
            .ok()
            .flatten()
            .map(|receipt| receipt.queue_position)
    }

    /// Compatibility-only entry point for old callers. It acknowledges immediately after claim and is unsuitable for real agent workers.
    pub fn pop_subagent_message(&self, id: &str) -> Option<String> {
        let AgentDeliveryClaimOutcome::Claimed(claim) =
            self.claim_next_subagent_delivery(id, 120, u32::MAX).ok()?
        else {
            return None;
        };
        self.ack_subagent_delivery(id, &claim.message_id, &claim.lease_id)
            .ok()?;
        Some(claim.body)
    }

    /// Compatibility wrapper for the old API. Real workers should claim, acknowledge, and close separately.
    pub fn pop_or_close_subagent_message(&self, id: &str) -> Option<String> {
        match self.claim_next_subagent_delivery(id, 120, u32::MAX).ok()? {
            AgentDeliveryClaimOutcome::Claimed(claim) => {
                self.ack_subagent_delivery(id, &claim.message_id, &claim.lease_id)
                    .ok()?;
                Some(claim.body)
            }
            AgentDeliveryClaimOutcome::Empty => {
                let _ = self.close_subagent_delivery_queue_if_empty(id);
                None
            }
            AgentDeliveryClaimOutcome::Busy { .. } | AgentDeliveryClaimOutcome::Blocked { .. } => {
                None
            }
        }
    }

    /// Mark that a final-status notification for a background task has been
    /// injected into the conversation. Returns false if the task does not
    /// exist.
    pub fn mark_task_notification_injected(&self, id: &str) -> bool {
        let _persist = self.lock_session_state_persistence();
        let (state_path, tasks) = {
            let mut inner = self.write_inner();
            let Some(task) = inner.tasks.get_mut(id) else {
                return false;
            };
            task.notification_injected_at_ms = Some(now_millis());
            task.updated_at_ms = now_millis();
            (
                SessionTaskPersistence::from_inner(&inner),
                persistable_delegated_tasks(&inner.tasks),
            )
        };
        persist_session_tasks(state_path, tasks);
        true
    }

    /// Atomically claim the current run's completion notification.
    pub fn claim_task_notification_injected(&self, id: &str) -> bool {
        let _persist = self.lock_session_state_persistence();
        let (state_path, tasks) = {
            let mut inner = self.write_inner();
            let Some(task) = inner.tasks.get_mut(id) else {
                return false;
            };
            let run_started_at = task.run_started_at_ms.unwrap_or(task.created_at_ms);
            if task
                .notification_injected_at_ms
                .is_some_and(|injected_at| injected_at >= run_started_at)
            {
                return false;
            }
            let now = now_millis();
            task.notification_injected_at_ms = Some(now);
            task.updated_at_ms = now;
            (
                SessionTaskPersistence::from_inner(&inner),
                persistable_delegated_tasks(&inner.tasks),
            )
        };
        persist_session_tasks(state_path, tasks);
        true
    }

    /// Shared claim-and-fetch used by read paths that deliver a terminal result
    /// to the parent (`TaskOutput`, `wait`). Claiming here closes the
    /// read-then-inject race between the reading tool and the engine event loop.
    /// The claim is run-scoped, mirroring `claim_task_notification_injected`: a
    /// terminal status is only stamped when no marker exists at or after this
    /// run's start, so repeated reads of an already-delivered result stay
    /// side-effect free (no re-stamp, no persistence write) and a respawned run
    /// can claim its own notification again.
    fn task_with_delivery_claim(
        &self,
        id: &str,
        claims: impl FnOnce(TaskStatus) -> bool,
    ) -> Option<Task> {
        let _persist = self.lock_session_state_persistence();
        let (state_path, tasks, task, claimed) = {
            let mut inner = self.write_inner();
            let task = inner.tasks.get_mut(id)?;
            let run_started_at = task.run_started_at_ms.unwrap_or(task.created_at_ms);
            // `!is_some_and(>=)` is `is_none_or(<)`: the run stays claimable
            // when no marker exists at or after this run's start.
            let claimed = claims(task.status)
                && task
                    .notification_injected_at_ms
                    .is_none_or(|injected_at| injected_at < run_started_at);
            if claimed {
                let now = now_millis();
                task.notification_injected_at_ms = Some(now);
                task.updated_at_ms = now;
            }
            let task = task.clone();
            (
                SessionTaskPersistence::from_inner(&inner),
                persistable_delegated_tasks(&inner.tasks),
                task,
                claimed,
            )
        };
        if claimed {
            persist_session_tasks(state_path, tasks);
        }
        Some(task)
    }

    /// Return a task for TaskOutput and atomically claim asynchronous
    /// notification delivery when that task is already terminal. This closes
    /// the read-then-claim race between TaskOutput and the engine event loop.
    pub fn task_for_output_delivery(&self, id: &str) -> Option<Task> {
        self.task_with_delivery_claim(id, Self::terminal_delivery_status)
    }

    /// Return a task for the `wait` tool. Reading a terminal state here counts as
    /// delivery: the parent learned the run outcome, so the engine must not inject
    /// a duplicate `<subagent_notification .../>` for the same run.
    pub fn task_for_wait_report(&self, id: &str) -> Option<Task> {
        self.task_with_delivery_claim(id, Self::terminal_delivery_status)
    }

    /// Terminal statuses that inject a completion notification into the parent
    /// conversation. `Paused` is deliberately absent: a paused agent can resume
    /// and must stay claimable after it later finishes.
    fn terminal_delivery_status(status: TaskStatus) -> bool {
        matches!(
            status,
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled | TaskStatus::Halted
        )
    }

    /// Remove a task by ID. Returns true if it existed.
    pub fn remove_task(&self, id: &str) -> bool {
        let _persist = self.lock_session_state_persistence();
        let (state_path, tasks, removed) = {
            let mut inner = self.write_inner();
            let removed = inner.tasks.remove(id).is_some();
            (
                SessionTaskPersistence::from_inner(&inner),
                persistable_delegated_tasks(&inner.tasks),
                removed,
            )
        };
        if removed {
            persist_session_tasks(state_path, tasks);
        }
        removed
    }
}

fn bounded_control_reason(reason: &str) -> BoundedDiagnostic {
    let message = reason.trim();
    let message = if message.is_empty() {
        "no reason provided".to_string()
    } else {
        message.chars().take(512).collect()
    };
    BoundedDiagnostic {
        message,
        detail: None,
        current: None,
        total: None,
        updated_at_ms: now_millis(),
    }
}
