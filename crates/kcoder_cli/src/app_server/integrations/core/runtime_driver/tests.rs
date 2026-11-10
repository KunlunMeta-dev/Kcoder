//! Contract transport fixtures do not prove real provider or platform behavior.
//! Private stores, resident engines and deterministic workflows are real here.
use super::*;
use crate::app_server::thread_runtime::ThreadManager;
use kcoder_app_protocol::{EventContext, Turn, TurnCompletedParams, TurnStatus, UserInput};
use kcoder_engine::QueryEngine;
use kcoder_types::StudioWorkMode;
use serde_json::{Value, json};
use std::path::PathBuf;

use super::test_support::*;

fn ticket(command: &NativeRuntimeCommand) -> NativeRuntimeTicket {
    command.ticket().clone()
}
fn rpc(command: &NativeRuntimeCommand) -> (&'static str, &Value) {
    match command {
        NativeRuntimeCommand::Rpc { method, params, .. } => (method, params),
        _ => panic!("RPC expected"),
    }
}
fn thread_reply(id: &str) -> Value {
    json!({"result":{"thread":{"id":id,"status":"idle","createdAt":"fixture","updatedAt":"fixture"}}})
}
fn complete(thread: &str, turn: &str, status: TurnStatus) -> TurnCompletedParams {
    TurnCompletedParams {
        file_changes_capture: None,
        review_evidence: None,
        context: EventContext {
            server_id: "native-server-fixture".into(),
            thread_id: thread.into(),
            turn_id: Some(turn.into()),
            sequence: 1,
        },
        turn: Turn {
            id: turn.into(),
            attempt_id: None,
            memory_snapshot_id: None,
            thread_id: thread.into(),
            status,
        },
        error: None,
    }
}
fn queued_turn(
    fixture: &Fixture,
    driver: &mut NativeRuntimeDriver,
    operation: &str,
) -> NativeRuntimeTicket {
    let request = fixture.request(operation);
    let spec = fixture.spec();
    driver
        .accept_task(&fixture.context, &request, spec)
        .unwrap();
    let create = driver.next_command(&fixture.context).unwrap().unwrap();
    driver
        .observe_response(
            &fixture.context,
            &ticket(&create),
            &thread_reply("thread-fixture"),
        )
        .unwrap();
    let configure = driver.next_command(&fixture.context).unwrap().unwrap();
    let mut binding = driver.take_pending(&ticket(&configure)).unwrap();
    binding.phase = RuntimePhase::TurnQueued;
    driver.save_and_enqueue(binding).unwrap();
    ticket(&driver.next_command(&fixture.context).unwrap().unwrap())
}
#[test]
fn unknown_restore_proves_only_that_original_bound_input_was_not_dispatched() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    let mut request = fixture.request("unknown-bound-restore");
    request.payload.insert("source".into(), json!({"kind":"channel","platform":"feishu","channelId":"original-connection","ingressId":"original-inbox"}));
    request.payload.insert(
        "taskBindingRef".into(),
        json!({"id":"original-binding","revision":"4"}),
    );
    let mut spec = fixture.spec();
    spec.existing_thread_id = Some("original-task".into());
    driver
        .accept_task(&fixture.context, &request, spec)
        .unwrap();
    let command = driver.next_command(&fixture.context).unwrap().unwrap();
    let ticket = ticket(&command);
    assert!(
        driver
            .unsubmitted_input(&fixture.context, "unknown-bound-restore")
            .unwrap()
            .is_none()
    );
    driver
        .observe_response(
            &fixture.context,
            &ticket,
            &json!({"error":{"code":-32000,"message":"restore failed"}}),
        )
        .unwrap();
    let before = driver
        .read_operation(&fixture.context, "unknown-bound-restore")
        .unwrap()
        .unwrap();
    let proof = driver
        .unsubmitted_input(&fixture.context, "unknown-bound-restore")
        .unwrap()
        .unwrap();
    assert_eq!(proof.thread_id, "original-task");
    assert_eq!(proof.operation_revision, before.revision);
    assert_eq!(before.phase, IntegrationOperationPhase::Unknown);
    assert!(before.runtime_acceptance.is_none());
    assert!(!driver.has_commands());
    assert_eq!(
        driver
            .read_operation(&fixture.context, "unknown-bound-restore")
            .unwrap()
            .unwrap(),
        before
    );
    // A possibly dispatched turn, active ticket, or recovery queue cannot use
    // this evidence even if the operation receipt still says unknown.
    driver
        .test_pending()
        .insert(ticket.id().to_owned(), ticket.clone());
    assert!(
        driver
            .unsubmitted_input(&fixture.context, "unknown-bound-restore")
            .unwrap()
            .is_none()
    );
    driver.test_pending().clear();
    driver
        .test_queue()
        .push_back("unknown-bound-restore".into());
    assert!(
        driver
            .unsubmitted_input(&fixture.context, "unknown-bound-restore")
            .unwrap()
            .is_none()
    );
    driver.test_queue().clear();
    let mut binding = driver
        .storage()
        .bindings()
        .get("unknown-bound-restore")
        .unwrap()
        .unwrap();
    binding.recovery_from = Some(RuntimePhase::TurnDispatched);
    let revision = binding.revision;
    driver
        .storage()
        .bindings()
        .save(binding, Some(revision))
        .unwrap();
    assert!(
        driver
            .unsubmitted_input(&fixture.context, "unknown-bound-restore")
            .unwrap()
            .is_none()
    );
    drop(driver);
    let restored = NativeRuntimeDriver::load(&fixture.context)
        .unwrap()
        .unwrap();
    assert!(
        restored
            .unsubmitted_input(&fixture.context, "unknown-bound-restore")
            .unwrap()
            .is_none()
    );
    assert!(!restored.has_commands());
}

fn accepted_turn(fixture: &Fixture, driver: &mut NativeRuntimeDriver, operation: &str) {
    let turn = queued_turn(fixture, driver, operation);
    driver.observe_response(&fixture.context, &turn, &json!({"result":{"turn":{"id":"turn-fixture","threadId":"thread-fixture","status":"running"}}})).unwrap();
}

#[test]
fn read_never_initializes_and_missing_initialization_or_lock_is_not_repaired() {
    let fixture = Fixture::new();
    let names = || {
        std::fs::read_dir(&fixture.profile)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>()
    };
    let identity_metadata = names();
    assert!(
        NativeRuntimeDriver::load(&fixture.context)
            .unwrap()
            .is_none()
    );
    assert_eq!(names(), identity_metadata);
    let mut driver = fixture.driver();
    driver
        .accept_task(
            &fixture.context,
            &fixture.request("original"),
            fixture.spec(),
        )
        .unwrap();
    let directory = driver.storage().test_domain_directory().unwrap();
    let bindings = directory
        .open_entry_handle(OsStr::new("runtime-bindings"))
        .unwrap()
        .open_child_directory()
        .unwrap();
    bindings
        .remove_regular_file(OsStr::new("bindings.lock"))
        .unwrap();
    assert!(driver.read_operation(&fixture.context, "original").is_err());
    drop(driver);
    assert!(NativeRuntimeDriver::initialize(&fixture.context, "do-not-repair").is_err());
    assert!(
        bindings
            .entry_metadata(OsStr::new("bindings.lock"))
            .is_err()
    );
}

#[test]
fn duplicate_admission_is_no_second_command_and_changed_prepared_input_conflicts() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    let request = fixture.request("original");
    let spec = fixture.spec();
    assert!(matches!(
        driver
            .accept_task(&fixture.context, &request, spec.clone())
            .unwrap(),
        RuntimeSubmission::Queued
    ));
    assert!(matches!(
        driver
            .accept_task(&fixture.context, &request, spec.clone())
            .unwrap(),
        RuntimeSubmission::Unconfirmed
    ));
    assert_eq!(driver.test_queue().len(), 1);
    let mut retried = request.clone();
    retried.request_id = "a-new-transport-request".into();
    retried.timeout_ms = 1;
    assert!(matches!(
        driver
            .accept_task(&fixture.context, &retried, spec.clone())
            .unwrap(),
        RuntimeSubmission::Unconfirmed
    ));
    assert_eq!(driver.test_queue().len(), 1);
    let mut changed = spec;
    changed.input = vec![UserInput::Text {
        text: "different bytes".into(),
    }];
    assert!(
        driver
            .accept_task(&fixture.context, &request, changed)
            .is_err()
    );
    assert_eq!(driver.test_queue().len(), 1);
}

#[test]
fn queue_capacity_is_checked_before_creating_an_unlaunchable_operation() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    *driver.test_queue() = (0..MAX_QUEUED).map(|n| format!("queued-{n}")).collect();
    assert!(
        driver
            .accept_task(
                &fixture.context,
                &fixture.request("overflow"),
                fixture.spec()
            )
            .is_err()
    );
    assert!(
        driver
            .read_operation(&fixture.context, "overflow")
            .unwrap()
            .is_none()
    );
}

#[test]
fn thread_start_uses_native_creation_identity_and_never_uses_workflow_draft_as_execution() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    let mut spec = fixture.spec();
    spec.configuration.workflow = Some(RuntimeWorkflowSpec::from_native_source(
        &fixture.context, "builtin-office-weekly-report", 1,
        json!({"period":"2026-W43","asOfDate":"2026-10-24","sourceRefs":[{"kind":"publication","id":"explicit-fixture-source","revision":"1"}]}),
    ).unwrap());
    driver
        .accept_task(&fixture.context, &fixture.request("workflow"), spec)
        .unwrap();
    let command = driver.next_command(&fixture.context).unwrap().unwrap();
    let (method, params) = rpc(&command);
    assert_eq!(method, "thread/start");
    assert!(
        params["clientRequestId"]
            .as_str()
            .unwrap()
            .starts_with("integration-thread-")
    );
    assert!(params.get("workflowDefinitionId").is_none());
    assert!(params.get("sessionMode").is_none());
    assert!(
        driver
            .read_operation(&fixture.context, "workflow")
            .unwrap()
            .unwrap()
            .runtime_acceptance
            .is_none()
    );
}

#[test]
fn lost_creation_response_restarts_with_receipt_reads_only() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    driver
        .accept_task(&fixture.context, &fixture.request("lost"), fixture.spec())
        .unwrap();
    let original = driver.next_command(&fixture.context).unwrap().unwrap();
    let creation = rpc(&original).1["clientRequestId"].clone();
    drop(driver);
    let mut driver = NativeRuntimeDriver::load(&fixture.context)
        .unwrap()
        .unwrap();
    driver
        .reconcile_operation(&fixture.context, "lost")
        .unwrap();
    let read = driver.next_command(&fixture.context).unwrap().unwrap();
    assert_eq!(rpc(&read).0, "thread/creation/read");
    assert_eq!(rpc(&read).1["clientRequestId"], creation);
    driver
        .observe_response(
            &fixture.context,
            &ticket(&read),
            &json!({"result":{"receipt":null}}),
        )
        .unwrap();
    assert!(!driver.has_commands());
    assert_eq!(
        driver
            .read_operation(&fixture.context, "lost")
            .unwrap()
            .unwrap()
            .phase,
        IntegrationOperationPhase::Unknown
    );
}

#[test]
fn ready_creation_without_turn_receipt_never_replays_startup_or_prompt() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    driver
        .accept_task(&fixture.context, &fixture.request("lost"), fixture.spec())
        .unwrap();
    let start = driver.next_command(&fixture.context).unwrap().unwrap();
    driver
        .abandon_command(&fixture.context, &ticket(&start))
        .unwrap();
    driver
        .reconcile_operation(&fixture.context, "lost")
        .unwrap();
    let read = driver.next_command(&fixture.context).unwrap().unwrap();
    driver.observe_response(&fixture.context, &ticket(&read), &json!({"result":{"receipt":{"threadId":"original-thread","status":"ready","thread":null}}})).unwrap();
    let turn_read = driver.next_command(&fixture.context).unwrap().unwrap();
    assert_eq!(rpc(&turn_read).0, "turn/receipt/read");
    assert_eq!(rpc(&turn_read).1["threadId"], "original-thread");
    driver
        .observe_response(
            &fixture.context,
            &ticket(&turn_read),
            &json!({"result":{"receipt":null}}),
        )
        .unwrap();
    assert!(!driver.has_commands());
    assert!(driver.read_task(&fixture.context, "lost").is_err());
}

#[test]
fn exact_turn_receipt_recovers_acceptance_without_fabricating_output() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    let sent = queued_turn(&fixture, &mut driver, "lost-turn");
    driver.abandon_command(&fixture.context, &sent).unwrap();
    driver
        .reconcile_operation(&fixture.context, "lost-turn")
        .unwrap();
    let read = driver.next_command(&fixture.context).unwrap().unwrap();
    assert_eq!(rpc(&read).0, "turn/receipt/read");
    assert!(
        rpc(&read).1["clientMessageId"]
            .as_str()
            .unwrap()
            .starts_with("integration-message-")
    );
    driver.observe_response(&fixture.context, &ticket(&read), &json!({"result":{"receipt":{"threadId":"thread-fixture","turnId":"original-turn","status":"completed"}}})).unwrap();
    let task = driver.read_task(&fixture.context, "lost-turn").unwrap();
    assert_eq!(task.turn_id.as_deref(), Some("original-turn"));
    assert_eq!(task.state, IntegrationTaskState::Completed);
    assert_eq!(task.output, None);
    let receipt = driver
        .read_operation(&fixture.context, "lost-turn")
        .unwrap()
        .unwrap();
    assert_eq!(
        receipt.runtime_acceptance.unwrap().state,
        IntegrationTaskState::Running
    );
    assert!(!driver.has_commands());
}

#[test]
fn other_native_turn_events_do_not_complete_original_and_terminal_outcome_is_immutable() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    accepted_turn(&fixture, &mut driver, "events");
    let original = complete("thread-fixture", "turn-fixture", TurnStatus::Completed);
    assert_eq!(
        driver.tracked_turn_operation(&original).unwrap(),
        Some("events")
    );
    assert_eq!(
        driver
            .tracked_turn_operation(&complete(
                "different-thread",
                "turn-fixture",
                TurnStatus::Completed
            ))
            .unwrap(),
        None
    );
    let mut mismatched = original.clone();
    mismatched.context.turn_id = Some("another-turn".into());
    assert!(driver.tracked_turn_operation(&mismatched).is_err());
    assert!(
        !driver
            .observe_turn_completed(
                &fixture.context,
                &complete("thread-fixture", "another-turn", TurnStatus::Completed)
            )
            .unwrap()
    );
    assert_eq!(
        driver.read_task(&fixture.context, "events").unwrap().state,
        IntegrationTaskState::Running
    );
    assert!(
        driver
            .observe_turn_completed(
                &fixture.context,
                &complete("thread-fixture", "turn-fixture", TurnStatus::Completed)
            )
            .unwrap()
    );
    assert!(
        driver
            .observe_turn_completed(
                &fixture.context,
                &complete("thread-fixture", "turn-fixture", TurnStatus::Failed)
            )
            .is_err()
    );
    assert_eq!(
        driver.read_task(&fixture.context, "events").unwrap().state,
        IntegrationTaskState::Completed
    );
}

#[test]
fn accepted_task_failure_preserves_original_admission_and_separate_failed_task_fact() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    accepted_turn(&fixture, &mut driver, "failed-task");
    let original = driver
        .read_operation(&fixture.context, "failed-task")
        .unwrap()
        .unwrap()
        .runtime_acceptance;
    driver
        .observe_turn_completed(
            &fixture.context,
            &complete("thread-fixture", "turn-fixture", TurnStatus::Failed),
        )
        .unwrap();
    let receipt = driver
        .read_operation(&fixture.context, "failed-task")
        .unwrap()
        .unwrap();
    assert_eq!(receipt.phase, IntegrationOperationPhase::Completed);
    assert_eq!(receipt.runtime_acceptance, original);
    assert_eq!(
        driver
            .read_task(&fixture.context, "failed-task")
            .unwrap()
            .state,
        IntegrationTaskState::Failed
    );
    assert!(!driver.has_commands());
}

#[test]
fn accepted_operation_point_read_skips_unrelated_bindings_but_checks_its_own() {
    let fixture = Fixture::new();
    assert!(
        NativeRuntimeDriver::read_original_acceptance(&fixture.context, "target")
            .unwrap()
            .is_none()
    );
    let mut driver = fixture.driver();
    accepted_turn(&fixture, &mut driver, "target");
    let expected = driver
        .read_operation(&fixture.context, "target")
        .unwrap()
        .unwrap()
        .runtime_acceptance
        .unwrap();
    let held = NativeRuntimeAcceptanceReader::open(&fixture.context, "target").unwrap();
    assert_eq!(held.read(&fixture.context).unwrap(), Some(expected.clone()));
    let bindings = driver
        .storage()
        .test_domain_directory()
        .unwrap()
        .open_entry_handle(OsStr::new("runtime-bindings"))
        .unwrap()
        .open_child_directory()
        .unwrap();
    let corrupt = |operation: &str| {
        let name = format!("binding-{:x}.json", Sha256::digest(operation.as_bytes()));
        bindings
            .atomic_replace(OsStr::new(&name), b"{ invalid binding")
            .unwrap();
    };
    corrupt("unrelated");
    assert!(NativeRuntimeDriver::load(&fixture.context).is_err());
    assert!(
        NativeRuntimeDriver::observe_source_intent(&fixture.context, "fresh")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        NativeRuntimeDriver::read_original_acceptance(&fixture.context, "target").unwrap(),
        Some(expected.clone())
    );
    assert_eq!(held.read(&fixture.context).unwrap(), Some(expected.clone()));
    let foreign = NativeIntegrationContext::capture(
        &fixture.profile,
        &fixture.workspace,
        "other-connection",
        "other-configuration",
    )
    .unwrap();
    assert!(held.read(&foreign).is_err());
    let evidence = NativeRuntimeDriver::read_original_task_evidence(&fixture.context, "target")
        .unwrap()
        .unwrap();
    assert_eq!(evidence.original.operation_id.as_deref(), Some("target"));
    assert_eq!(evidence.acceptance, expected);
    assert_eq!(evidence.task.turn_id, expected.turn_id);
    assert!(!evidence.has_settled_result());
    #[cfg(unix)]
    {
        let root = fixture.profile.join(driver.storage().namespace_id());
        let original = root.join("runtime-bindings");
        let moved = root.join("renamed-bindings");
        std::fs::rename(&original, &moved).unwrap();
        assert!(held.read(&fixture.context).is_err());
        std::fs::rename(&moved, &original).unwrap();
        assert_eq!(held.read(&fixture.context).unwrap(), Some(expected));
    }
    corrupt("target");
    assert!(held.read(&fixture.context).is_err());
    assert!(NativeRuntimeDriver::read_original_acceptance(&fixture.context, "target").is_err());
    assert!(NativeRuntimeDriver::read_original_task_evidence(&fixture.context, "target").is_err());
    assert!(NativeRuntimeDriver::observe_source_intent(&fixture.context, "target").is_err());
}

#[test]
fn stable_owner_can_read_after_reconnect_but_old_generation_cannot_dispatch() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    let request = fixture.request("reconnect");
    driver
        .accept_task(&fixture.context, &request, fixture.spec())
        .unwrap();
    let current = NativeIntegrationContext::capture(
        &fixture.profile,
        &fixture.workspace,
        "connection-2",
        "config-2",
    )
    .unwrap();
    assert!(
        driver
            .read_operation(&current, "reconnect")
            .unwrap()
            .is_some()
    );
    assert!(
        driver
            .accept_task(&current, &request, fixture.spec())
            .is_err()
    );
    assert!(driver.next_command(&current).unwrap().is_none());
    assert_eq!(
        driver
            .read_operation(&current, "reconnect")
            .unwrap()
            .unwrap()
            .phase,
        IntegrationOperationPhase::Rejected
    );
}

#[test]
fn cancellation_requires_exact_original_ids_and_completion_wins_the_race() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    accepted_turn(&fixture, &mut driver, "task");
    let mut cancel = fixture.request("cancel-task");
    cancel.payload = json!({"threadId":"thread-fixture","turnId":"another-turn"})
        .as_object()
        .unwrap()
        .clone();
    assert!(
        driver
            .cancel_task(&fixture.context, "task", &cancel)
            .is_err()
    );
    assert!(
        driver
            .read_operation(&fixture.context, "cancel-task")
            .unwrap()
            .is_none()
    );
    cancel.payload = json!({"threadId":"thread-fixture","turnId":"turn-fixture"})
        .as_object()
        .unwrap()
        .clone();
    driver
        .cancel_task(&fixture.context, "task", &cancel)
        .unwrap();
    let stop = driver.next_command(&fixture.context).unwrap().unwrap();
    assert_eq!(rpc(&stop).0, "turn/interrupt");
    assert_eq!(rpc(&stop).1["turnId"], "turn-fixture");
    assert_eq!(
        driver.read_task(&fixture.context, "task").unwrap().state,
        IntegrationTaskState::Running
    );
    driver
        .observe_turn_completed(
            &fixture.context,
            &complete("thread-fixture", "turn-fixture", TurnStatus::Completed),
        )
        .unwrap();
    driver
        .observe_response(
            &fixture.context,
            &ticket(&stop),
            &json!({"result":{"interrupted":true}}),
        )
        .unwrap();
    assert_eq!(
        driver.read_task(&fixture.context, "task").unwrap().state,
        IntegrationTaskState::Completed
    );
    assert!(!driver.has_commands());
    assert_eq!(
        driver
            .read_operation(&fixture.context, "cancel-task")
            .unwrap()
            .unwrap()
            .phase,
        IntegrationOperationPhase::Completed
    );
}

#[tokio::test]
async fn actual_resident_configuration_requires_installer_and_exact_model_revision() {
    for missing_installer in [false, true] {
        let fixture = Fixture::new();
        let (mut manager, engine) = resident(&fixture).await;
        let mut driver = fixture.driver();
        let mut spec = fixture.spec();
        spec.existing_thread_id = Some(engine.session_id());
        spec.configuration.model.model = engine.active_model_configuration_summary().unwrap();
        if !missing_installer {
            spec.configuration.model.model.revision = "different-private-configuration".into()
        }
        driver
            .accept_task(&fixture.context, &fixture.request("configure"), spec)
            .unwrap();
        let configure = driver.next_command(&fixture.context).unwrap().unwrap();
        let installer: Option<&dyn NativeRuntimePolicyInstaller> = if missing_installer {
            None
        } else {
            Some(&FixtureInstaller)
        };
        assert!(
            driver
                .configure_command(
                    &fixture.context,
                    &ticket(&configure),
                    &mut manager,
                    installer
                )
                .is_err()
        );
        assert!(!driver.has_commands());
        assert!(
            driver
                .read_operation(&fixture.context, "configure")
                .unwrap()
                .unwrap()
                .runtime_acceptance
                .is_none()
        );
        shutdown(manager).await;
    }
}

#[tokio::test]
async fn actual_resident_configuration_keeps_empty_tool_intersection_and_original_model() {
    let fixture = Fixture::new();
    let (mut manager, engine) = resident(&fixture).await;
    let mut driver = fixture.driver();
    let mut spec = fixture.spec();
    spec.existing_thread_id = Some(engine.session_id());
    spec.configuration.model.model = engine.active_model_configuration_summary().unwrap();
    let expected = spec.configuration.model.model.clone();
    driver
        .accept_task(&fixture.context, &fixture.request("configure"), spec)
        .unwrap();
    let configure = driver.next_command(&fixture.context).unwrap().unwrap();
    driver
        .configure_command(
            &fixture.context,
            &ticket(&configure),
            &mut manager,
            Some(&FixtureInstaller),
        )
        .unwrap();
    let turn = driver.next_command(&fixture.context).unwrap().unwrap();
    assert_eq!(rpc(&turn).0, "turn/start");
    assert!(rpc(&turn).1.get("model").is_none());
    let admitted = driver
        .prepare_turn_dispatch(
            &fixture.context,
            &ticket(&turn),
            &mut manager,
            Some(&FixtureInstaller),
        )
        .unwrap();
    assert_eq!(admitted["threadId"], engine.session_id());
    let actual = manager.engine(&engine.session_id()).unwrap();
    assert!(actual.active_tool_registry().names().is_empty());
    assert_eq!(
        actual
            .active_model_configuration_summary()
            .unwrap()
            .revision,
        expected.revision
    );
    shutdown(manager).await;
}

#[tokio::test]
async fn generated_turn_rechecks_model_if_normal_client_changed_it_after_configure() {
    let fixture = Fixture::new();
    let (mut manager, engine) = resident(&fixture).await;
    let mut driver = fixture.driver();
    let mut spec = fixture.spec();
    spec.existing_thread_id = Some(engine.session_id());
    spec.configuration.model.model = engine.active_model_configuration_summary().unwrap();
    driver
        .accept_task(&fixture.context, &fixture.request("model-gap"), spec)
        .unwrap();
    let configure = driver.next_command(&fixture.context).unwrap().unwrap();
    driver
        .configure_command(
            &fixture.context,
            &ticket(&configure),
            &mut manager,
            Some(&FixtureInstaller),
        )
        .unwrap();
    let turn = driver.next_command(&fixture.context).unwrap().unwrap();
    manager
        .engine(&engine.session_id())
        .unwrap()
        .settings
        .write()
        .unwrap()
        .model = "another-client-selection".into();
    assert!(
        driver
            .prepare_turn_dispatch(
                &fixture.context,
                &ticket(&turn),
                &mut manager,
                Some(&FixtureInstaller)
            )
            .is_err()
    );
    assert!(
        driver
            .read_operation(&fixture.context, "model-gap")
            .unwrap()
            .unwrap()
            .runtime_acceptance
            .is_none()
    );
    shutdown(manager).await;
}

#[tokio::test]
async fn deferred_resident_configuration_only_installs_when_dispatching_the_original_turn() {
    struct DeferredInstaller(std::cell::Cell<u32>);
    impl NativeRuntimePolicyInstaller for DeferredInstaller {
        fn configures_bound_resident_at_turn_dispatch(&self) -> bool {
            true
        }

        fn install(
            &self,
            context: &NativeIntegrationContext,
            original: &IntegrationRequest,
            prepared: &PreparedRuntimeTask,
            engine: QueryEngine,
        ) -> Result<QueryEngine> {
            self.0.set(self.0.get() + 1);
            FixtureInstaller.install(context, original, prepared, engine)
        }
    }

    let fixture = Fixture::new();
    let (mut manager, engine) = resident(&fixture).await;
    let mut driver = fixture.driver();
    let mut spec = fixture.spec();
    let thread = engine.session_id();
    spec.existing_thread_id = Some(thread.clone());
    spec.configuration.model.model = engine.active_model_configuration_summary().unwrap();
    let installer = DeferredInstaller(std::cell::Cell::new(0));
    driver
        .accept_task(
            &fixture.context,
            &fixture.request("deferred-configure"),
            spec,
        )
        .unwrap();
    let configure = driver.next_command(&fixture.context).unwrap().unwrap();
    driver
        .configure_command(
            &fixture.context,
            &ticket(&configure),
            &mut manager,
            Some(&installer),
        )
        .unwrap();
    assert_eq!(installer.0.get(), 0);
    assert!(
        !manager
            .engine(&thread)
            .unwrap()
            .native_input_requires_source_admission()
    );

    let turn = driver.next_command(&fixture.context).unwrap().unwrap();
    let dispatched = driver
        .prepare_turn_dispatch(
            &fixture.context,
            &ticket(&turn),
            &mut manager,
            Some(&installer),
        )
        .unwrap();
    assert_eq!(dispatched["threadId"], thread);
    assert_eq!(installer.0.get(), 1);
    assert!(
        manager
            .engine(&thread)
            .unwrap()
            .native_input_requires_source_admission()
    );
    assert!(
        driver
            .read_operation(&fixture.context, "deferred-configure")
            .unwrap()
            .unwrap()
            .runtime_acceptance
            .is_none()
    );
    shutdown(manager).await;
}

#[test]
fn reconnect_restores_exact_event_tracking_without_replaying_commands() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    accepted_turn(&fixture, &mut driver, "restored");
    drop(driver);
    let current = NativeIntegrationContext::capture(
        &fixture.profile,
        &fixture.workspace,
        "connection-2",
        "config-2",
    )
    .unwrap();
    let mut driver = NativeRuntimeDriver::load(&current).unwrap().unwrap();
    assert!(!driver.has_commands());
    assert!(
        driver
            .observe_turn_completed(
                &current,
                &complete("thread-fixture", "turn-fixture", TurnStatus::Completed)
            )
            .unwrap()
    );
    assert_eq!(
        driver.read_task(&current, "restored").unwrap().state,
        IntegrationTaskState::Completed
    );
}

#[test]
fn transcript_projection_uses_exact_completed_turn_and_keeps_missing_output_unknown() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    accepted_turn(&fixture, &mut driver, "output");
    let message = |turn: &str, text: &str| {
        serde_json::from_value(
            json!({"id":"message","turnId":turn,"role":"assistant","content":text,"timestampMs":1}),
        )
        .unwrap()
    };
    driver
        .observe_transcript(
            &fixture.context,
            "output",
            "thread-fixture",
            &[message("turn-fixture", "partial reasoning")],
        )
        .unwrap();
    assert!(
        driver
            .read_task(&fixture.context, "output")
            .unwrap()
            .output
            .is_none()
    );
    driver
        .observe_turn_completed(
            &fixture.context,
            &complete("thread-fixture", "turn-fixture", TurnStatus::Completed),
        )
        .unwrap();
    driver
        .observe_transcript(
            &fixture.context,
            "output",
            "thread-fixture",
            &[message("another-turn", "wrong result")],
        )
        .unwrap();
    assert!(
        driver
            .read_task(&fixture.context, "output")
            .unwrap()
            .output
            .is_none()
    );
    driver
        .observe_transcript(
            &fixture.context,
            "output",
            "thread-fixture",
            &[
                message("turn-fixture", "original final result"),
                message("another-turn", "latest wrong result"),
            ],
        )
        .unwrap();
    assert_eq!(
        driver
            .read_task(&fixture.context, "output")
            .unwrap()
            .output
            .as_deref(),
        Some("original final result")
    );
}

#[test]
fn canonical_transcript_and_artifact_refs_commit_together_and_cannot_be_replaced() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    accepted_turn(&fixture, &mut driver, "atomic-output");
    driver
        .observe_turn_completed(
            &fixture.context,
            &complete("thread-fixture", "turn-fixture", TurnStatus::Completed),
        )
        .unwrap();
    let message = |turn: &str| {
        serde_json::from_value(json!({
            "id":"original-final", "turnId":turn, "role":"assistant",
            "content":"Original completed output", "timestampMs":1
        }))
        .unwrap()
    };
    let reference = IntegrationEntityRef {
        kind: IntegrationEntityKind::Artifact,
        id: "native-produced-artifact".into(),
        revision: Some("1".into()),
    };
    driver
        .observe_transcript_with_artifacts(
            &fixture.context,
            "atomic-output",
            "thread-fixture",
            &[message("foreign-turn")],
            Some(vec![reference.clone()]),
        )
        .unwrap();
    let missing = driver.read_task(&fixture.context, "atomic-output").unwrap();
    assert!(missing.output.is_none() && missing.artifact_refs.is_empty());
    driver
        .observe_transcript_with_artifacts(
            &fixture.context,
            "atomic-output",
            "thread-fixture",
            &[message("turn-fixture")],
            Some(vec![reference.clone()]),
        )
        .unwrap();
    let original = driver.read_task(&fixture.context, "atomic-output").unwrap();
    assert_eq!(
        original.output.as_deref(),
        Some("Original completed output")
    );
    assert_eq!(original.artifact_refs, vec![reference.clone()]);
    driver
        .observe_transcript_with_artifacts(
            &fixture.context,
            "atomic-output",
            "thread-fixture",
            &[message("turn-fixture")],
            Some(vec![reference]),
        )
        .unwrap();
    assert!(
        driver
            .observe_transcript_with_artifacts(
                &fixture.context,
                "atomic-output",
                "thread-fixture",
                &[message("turn-fixture")],
                Some(vec![])
            )
            .is_err()
    );
    let retained = driver.read_task(&fixture.context, "atomic-output").unwrap();
    assert_eq!(retained.output, original.output);
    assert_eq!(retained.artifact_refs, original.artifact_refs);
}

#[test]
fn missing_binding_directory_keeps_committed_initialization_and_is_not_recreated() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let domain = driver.storage().namespace_id().to_owned();
    drop(driver);
    std::fs::rename(
        fixture.profile.join(&domain).join("runtime-bindings"),
        fixture
            .profile
            .join(&domain)
            .join("retained-original-bindings"),
    )
    .unwrap();
    assert!(NativeRuntimeDriver::load(&fixture.context).is_err());
    assert!(NativeRuntimeDriver::initialize(&fixture.context, "do-not-recreate").is_err());
    assert!(
        !fixture
            .profile
            .join(domain)
            .join("runtime-bindings")
            .exists()
    );
}

#[cfg(unix)]
#[test]
fn hardlink_replacement_of_binding_lock_is_not_accepted() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    let operation = "original-binding-lock";
    accepted_turn(&fixture, &mut driver, operation);
    assert!(driver.read_task(&fixture.context, operation).is_ok());
    assert!(!driver.queued_cleanup(&fixture.context, operation).unwrap());
    assert!(
        driver
            .read_execution_configuration(&fixture.context, operation)
            .is_ok()
    );
    let domain = driver.storage().namespace_id().to_owned();
    let original = fixture
        .profile
        .join(domain)
        .join("runtime-bindings/bindings.lock");
    std::fs::hard_link(&original, fixture.profile.join("hardlink-to-original-lock")).unwrap();
    assert!(driver.read_operation(&fixture.context, operation).is_err());
    assert!(driver.read_task(&fixture.context, operation).is_err());
    assert!(driver.queued_cleanup(&fixture.context, operation).is_err());
    assert!(
        driver
            .read_execution_configuration(&fixture.context, operation)
            .is_err()
    );
    drop(driver);
    assert!(NativeRuntimeDriver::load(&fixture.context).is_err());
}

#[test]
fn actual_observation_projection_keeps_artifact_revisions_and_pending_interactions_distinct() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    accepted_turn(&fixture, &mut driver, "observations");
    driver
        .observe_artifact_refs(
            &fixture.context,
            "observations",
            vec![IntegrationEntityRef {
                kind: IntegrationEntityKind::Artifact,
                id: "artifact-owned-by-B".into(),
                revision: Some("7".into()),
            }],
        )
        .unwrap();
    driver
        .observe_interactions(
            &fixture.context,
            "observations",
            vec![IntegrationPendingInteraction {
                interaction_id: "native-question-receipt".into(),
                revision: "3".into(),
                kind: IntegrationInteractionKind::Question,
                prompt: "Choose a destination".into(),
            }],
        )
        .unwrap();
    let task = driver.read_task(&fixture.context, "observations").unwrap();
    assert_eq!(task.state, IntegrationTaskState::WaitingForUser);
    assert_eq!(task.artifact_refs[0].revision.as_deref(), Some("7"));
    assert_eq!(task.pending_interactions.len(), 1);
    driver
        .observe_turn_completed(
            &fixture.context,
            &complete("thread-fixture", "turn-fixture", TurnStatus::Completed),
        )
        .unwrap();
    let task = driver.read_task(&fixture.context, "observations").unwrap();
    assert_eq!(task.state, IntegrationTaskState::Completed);
    assert!(task.pending_interactions.is_empty());
    assert_eq!(task.artifact_refs.len(), 1);
    assert!(
        driver
            .observe_artifact_refs(
                &fixture.context,
                "observations",
                vec![IntegrationEntityRef {
                    kind: IntegrationEntityKind::Input,
                    id: "not-an-output".into(),
                    revision: Some("1".into())
                }]
            )
            .is_err()
    );
    assert_eq!(
        driver
            .read_task(&fixture.context, "observations")
            .unwrap()
            .artifact_refs[0]
            .id,
        "artifact-owned-by-B"
    );
}

#[test]
fn public_errors_accept_only_exact_known_codes_and_never_reflect_private_diagnostics() {
    for secret in [
        "SECRET_UPPERCASE_TOKEN",
        "C:\\Private\\account.json",
        "/private/profile/token",
    ] {
        let result = public_error(&anyhow::anyhow!(secret.to_owned()));
        assert_eq!(result.code, "RUNTIME_RESULT_UNCONFIRMED");
        assert!(!serde_json::to_string(&result).unwrap().contains(secret));
    }
    assert_eq!(
        public_error(&anyhow::anyhow!("RUNTIME_MODEL_REVISION_MISMATCH")).code,
        "RUNTIME_CONFIGURATION_REJECTED"
    );
}

#[test]
fn frozen_native_reference_resolves_only_original_task_and_has_no_latest_fallback() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    accepted_turn(&fixture, &mut driver, "original-reference");
    let reference = IntegrationRuntimeReadTaskParams {
        thread_id: Some("thread-fixture".into()),
        turn_id: Some("turn-fixture".into()),
        task_id: None,
    };
    assert_eq!(
        driver
            .operation_for_reference(&fixture.context, &reference)
            .unwrap(),
        "original-reference"
    );
    assert_eq!(
        driver
            .read_task_reference(&fixture.context, &reference)
            .unwrap()
            .turn_id
            .as_deref(),
        Some("turn-fixture")
    );
    let wrong = IntegrationRuntimeReadTaskParams {
        turn_id: Some("another-turn".into()),
        ..reference
    };
    assert!(
        driver
            .read_task_reference(&fixture.context, &wrong)
            .is_err()
    );
    assert_eq!(
        driver
            .read_task(&fixture.context, "original-reference")
            .unwrap()
            .turn_id
            .as_deref(),
        Some("turn-fixture")
    );
}

#[path = "workflow_tests.rs"]
mod workflow_tests;

mod task_state;
#[test]
fn retired_channel_configuration_cannot_reenter_an_ordinary_runtime() {
    let fixture = test_support::Fixture::new();
    let spec = fixture.spec();
    let ordinary = serde_json::to_value(&spec).unwrap();
    assert!(ordinary["configuration"].get("channelPolicy").is_none());
    let restored: PreparedRuntimeTask = serde_json::from_value(ordinary.clone()).unwrap();
    assert_eq!(serde_json::to_value(restored).unwrap(), ordinary);
    for policy in [
        serde_json::Value::Null,
        serde_json::json!({"tools":[],"sources":{"mode":"none","sources":[]}}),
    ] {
        let mut retired = ordinary.clone();
        retired["configuration"]["channelPolicy"] = policy;
        assert!(serde_json::from_value::<PreparedRuntimeTask>(retired).is_err());
    }
}
