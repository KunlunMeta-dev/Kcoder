use super::*;
use crate::{
    PreparedRuntimeTask, RuntimeExecutionConfiguration, RuntimeExternalSend, RuntimeSubmission,
};
use kcoder_app_protocol::UserInput;
use kcoder_types::{StudioWorkMode, integrations::core::*};
use serde_json::json;

struct Fixture {
    _temp: tempfile::TempDir,
    context: NativeIntegrationContext,
    driver: NativeRuntimeDriver,
}

fn fixture() -> Result<Fixture> {
    let temp = tempfile::tempdir()?;
    let root = PrivateDirectory::open_existing(temp.path())?;
    root.create_private_child(OsStr::new("profile"))?;
    root.create_private_child(OsStr::new("workspace"))?;
    let context = NativeIntegrationContext::capture(
        &temp.path().join("profile"),
        &temp.path().join("workspace"),
        "test-connection",
        "test-configuration",
    )?;
    let driver = NativeRuntimeDriver::initialize(&context, "retention-initialization")?;
    Ok(Fixture {
        _temp: temp,
        context,
        driver,
    })
}

fn request(context: &NativeIntegrationContext, operation: &str, text: &str) -> IntegrationRequest {
    IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: format!("request-{operation}"),
        scope: context.scope().clone(),
        operation_id: Some(operation.into()),
        expected_revision: None,
        timeout_ms: INTEGRATION_MAX_WAIT_MS,
        cancellation_ref: None,
        payload: json!({
            "source": {"kind":"office_assistant","assistantId":"fixed-template","version":1},
            "message": {"text": text}
        })
        .as_object()
        .unwrap()
        .clone(),
    }
}

fn spec(text: &str) -> Result<PreparedRuntimeTask> {
    let model = serde_json::from_value(json!({
        "modelId":"fixture","chatProtocol":"auto","requestOutputLimits":{},
        "text":true,"tools":false,"vision":false,"reasoning":false,"structuredOutput":false,
        "extraBodyConfigured":false,"requestOverrideFields":[],
        "revision":"fixture-model-revision","boundary":"session_snapshot","sources":{}
    }))?;
    Ok(PreparedRuntimeTask {
        input: vec![UserInput::Text { text: text.into() }],
        studio_work_mode: StudioWorkMode::Kcoder,
        configuration: RuntimeExecutionConfiguration {
            model: IntegrationModelResolutionResult {
                selection_kind: IntegrationModelSelectionKind::InheritCurrent,
                model,
                policy_ref: IntegrationNullable::Null,
                budget: IntegrationModelBudget {
                    reservation_state: IntegrationBudgetReservationState::NotReserved,
                    cost_known: false,
                },
            },
            allowed_tools: Some(Vec::new()),
            external_send: RuntimeExternalSend::Deny,
            workflow: None,
        },
        existing_thread_id: Some("original-task".into()),
        client_presentation: None,
    })
}

impl Fixture {
    fn accept(&mut self, operation: &str) -> Result<RuntimeSubmission> {
        let request = request(&self.context, operation, "original input");
        self.driver
            .accept_task(&self.context, &request, spec("original input")?)
    }

    /// Accept and settle with an authoritative pre-dispatch rejection receipt.
    fn accept_and_reject(&mut self, operation: &str) -> Result<()> {
        assert!(matches!(self.accept(operation)?, RuntimeSubmission::Queued));
        self.driver
            .reject_queued_with_reason(&self.context, operation, "SESSION_PAUSED_NO_CLIENT")
    }

    fn storage(&self) -> &Arc<RuntimeStorage> {
        self.driver.storage()
    }
}

fn after_window() -> Result<u64> {
    Ok(crate::now()? + RUNTIME_BINDING_RETIREMENT_WINDOW_MS + 1)
}

#[test]
fn capacity_is_recovered_after_settled_bindings_are_retired() -> Result<()> {
    let mut fixture = fixture()?;
    for index in 0..MAX_BINDINGS {
        fixture.accept_and_reject(&format!("settled-{index}"))?;
    }
    let storage = fixture.storage().clone();
    assert_eq!(storage.bindings().live_count()?, MAX_BINDINGS);
    // Inside the reconciliation window nothing is retired and admission stays
    // refused before any receipt is begun.
    let early = storage.retire_settled_bindings(crate::now()?)?;
    assert_eq!(early.retired, 0);
    assert_eq!(early.eligible_pending_window, MAX_BINDINGS);
    let refused = fixture.accept("blocked-by-capacity").unwrap_err();
    assert_eq!(refused.to_string(), "RUNTIME_BINDING_CAPACITY");
    assert!(
        storage.read_receipt("blocked-by-capacity")?.is_none(),
        "a refused admission must not strand a begun receipt"
    );

    let swept = storage.retire_settled_bindings(after_window()?)?;
    assert_eq!(swept.retired, MAX_BINDINGS);
    assert_eq!(storage.bindings().live_count()?, 0);
    assert!(matches!(
        fixture.accept("after-retirement")?,
        RuntimeSubmission::Queued
    ));
    // Retirement is idempotent and leaves receipts and records readable.
    assert_eq!(storage.retire_settled_bindings(after_window()?)?.retired, 0);
    let retired = storage
        .bindings()
        .get("settled-0")?
        .expect("retired record");
    assert_eq!(retired.phase, RuntimePhase::Rejected);
    assert_eq!(
        storage.read_receipt("settled-0")?.unwrap().phase,
        IntegrationOperationPhase::Rejected
    );
    assert_eq!(
        storage.bindings().retire("settled-0", |_| Ok(true))?,
        RetireOne::AlreadyRetired
    );
    // A fresh load scans only live bindings and tolerates retired records.
    drop(fixture.driver);
    let restored = NativeRuntimeDriver::load(&fixture.context)?.expect("driver");
    assert_eq!(restored.storage().bindings().live_count()?, 1);
    Ok(())
}

#[test]
fn unknown_and_unsettled_bindings_are_never_retired() -> Result<()> {
    let mut fixture = fixture()?;
    assert!(matches!(
        fixture.accept("queued")?,
        RuntimeSubmission::Queued
    ));
    assert!(matches!(
        fixture.accept("unknown-outcome")?,
        RuntimeSubmission::Queued
    ));
    let storage = fixture.storage().clone();
    let binding = storage.bindings().get("unknown-outcome")?.unwrap();
    storage.unknown(binding, "RUNTIME_TURN_RECEIPT_NOT_OBSERVED")?;
    assert_eq!(
        storage.read_receipt("unknown-outcome")?.unwrap().phase,
        IntegrationOperationPhase::Unknown
    );
    // A terminal-looking binding whose receipt is not terminal stays live too.
    let mut forged = storage.bindings().get("queued")?.unwrap();
    forged.phase = RuntimePhase::Rejected;
    forged.task_state = IntegrationTaskState::Failed;
    let revision = forged.revision;
    storage.bindings().save(forged, Some(revision))?;

    let far_future = u64::MAX / 2;
    let swept = storage.retire_settled_bindings(far_future)?;
    assert_eq!(swept.retired, 0);
    assert_eq!(swept.eligible_pending_window, 0);
    assert_eq!(storage.bindings().live_count()?, 2);
    for operation in ["queued", "unknown-outcome"] {
        assert_eq!(
            storage.bindings().retire(operation, |binding| {
                Ok(storage.settlement(binding, far_future)? == Settlement::Settled)
            })?,
            RetireOne::NotEligible
        );
    }
    Ok(())
}

#[test]
fn retired_operation_keeps_its_original_intent_and_cannot_be_rewritten() -> Result<()> {
    let mut fixture = fixture()?;
    fixture.accept_and_reject("original")?;
    let storage = fixture.storage().clone();
    let live = storage.bindings().get("original")?.unwrap();
    assert_eq!(storage.retire_settled_bindings(after_window()?)?.retired, 1);

    // A lost acceptTask response is replayed from the original receipt; the
    // retired record still rejects a different intent for the same operation.
    let replay = request(&fixture.context, "original", "original input");
    assert!(matches!(
        fixture
            .driver
            .accept_task(&fixture.context, &replay, spec("original input")?)?,
        RuntimeSubmission::Unconfirmed
    ));
    // Same receipt intent, different prepared task: only the retired binding
    // still knows the original prepared intent.
    assert_eq!(
        fixture
            .driver
            .accept_task(&fixture.context, &replay, spec("different input")?)
            .unwrap_err()
            .to_string(),
        "RUNTIME_INTENT_CONFLICT"
    );
    let revision = live.revision;
    for expected in [Some(revision), None] {
        assert_eq!(
            storage
                .bindings()
                .save(live.clone(), expected)
                .unwrap_err()
                .to_string(),
            "RUNTIME_BINDING_RETIRED"
        );
    }
    Ok(())
}

#[test]
fn scan_tolerates_a_concurrent_retirement_but_not_a_vanished_record() -> Result<()> {
    let mut fixture = fixture()?;
    fixture.accept_and_reject("retired-during-scan")?;
    assert!(matches!(
        fixture.accept("deleted")?,
        RuntimeSubmission::Queued
    ));
    let storage = fixture.storage().clone();
    let names = storage.bindings().live_names()?;
    assert_eq!(names.len(), 2);
    assert_eq!(
        storage
            .bindings()
            .retire("retired-during-scan", |_| Ok(true))?,
        RetireOne::Retired
    );
    let retired_name = leaf("retired-during-scan")?;
    assert!(storage.bindings().vanished_was_retired(&retired_name)?);
    let deleted_name = leaf("deleted")?;
    storage
        .bindings()
        .directory
        .remove_regular_file(OsStr::new(&deleted_name))?;
    assert!(!storage.bindings().vanished_was_retired(&deleted_name)?);
    assert!(storage.bindings().get("deleted")?.is_none());
    Ok(())
}

#[test]
fn known_operation_policy_is_read_without_a_full_scan() -> Result<()> {
    let mut fixture = fixture()?;
    fixture.accept_and_reject("not-accepted")?;
    assert_eq!(
        NativeRuntimeDriver::read_original_execution_configuration(
            &fixture.context,
            "not-accepted"
        )
        .unwrap_err()
        .to_string(),
        "RUNTIME_ACCEPTANCE_UNCONFIRMED"
    );
    assert!(
        NativeRuntimeDriver::read_original_execution_configuration(&fixture.context, "absent")?
            .is_none()
    );
    // A corrupt unrelated record is not read by the direct lookup, while the
    // full scan still fails closed on it.
    let storage = fixture.storage().clone();
    storage
        .bindings()
        .directory
        .atomic_replace(OsStr::new(&leaf("unrelated")?), b"{not json")?;
    assert!(storage.bindings().visit(|_| Ok(())).is_err());
    assert!(
        NativeRuntimeDriver::read_original_execution_configuration(&fixture.context, "absent")?
            .is_none()
    );
    Ok(())
}

#[test]
fn receipts_stay_live_while_a_live_binding_references_them() -> Result<()> {
    let mut fixture = fixture()?;
    fixture.accept_and_reject("referenced")?;
    let storage = fixture.storage().clone();
    let later = after_window()?;
    assert!(active_operation_references(&fixture.context)?.contains("referenced"));
    let kept = retire_settled_operation_receipts(&fixture.context, &storage.ledger, later)?;
    assert_eq!((kept.retired, kept.kept), (0, 1));

    // Once the binding itself is retired, the settled receipt follows it.
    assert_eq!(storage.retire_settled_bindings(later)?.retired, 1);
    assert!(!active_operation_references(&fixture.context)?.contains("referenced"));
    let swept = retire_settled_operation_receipts(&fixture.context, &storage.ledger, later)?;
    assert_eq!(swept.retired, 1);
    assert_eq!(storage.ledger.live_count()?, 0);

    // Replay still resolves the original receipt and retired binding; a
    // different prepared task for the same id is still refused.
    let replay = request(&fixture.context, "referenced", "original input");
    assert!(matches!(
        fixture
            .driver
            .accept_task(&fixture.context, &replay, spec("original input")?)?,
        RuntimeSubmission::Unconfirmed
    ));
    assert_eq!(
        fixture
            .driver
            .accept_task(&fixture.context, &replay, spec("different input")?)
            .unwrap_err()
            .to_string(),
        "RUNTIME_INTENT_CONFLICT"
    );
    assert_eq!(
        storage.read_receipt("referenced")?.unwrap().phase,
        IntegrationOperationPhase::Rejected
    );
    Ok(())
}
