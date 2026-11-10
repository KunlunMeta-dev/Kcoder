//! Real FD-backed profile transactions and the original native operation ledger.
use super::super::tests::{Fixture, read_request, setup};
use super::*;
fn session(
    fixture: &Fixture,
    engine: &QueryEngine,
    request: IntegrationRequest,
) -> (Arc<()>, NativeModelPolicySettings) {
    let owner = Arc::new(());
    let session = NativeModelPolicySettings::capture(
        &fixture.context,
        engine,
        request,
        Arc::downgrade(&owner),
        CancellationToken::new(),
    )
    .unwrap();
    (owner, session)
}
fn read(fixture: &Fixture, engine: &QueryEngine) -> IntegrationModelPolicySettingsSnapshot {
    let (_owner, session) = session(fixture, engine, read_request(fixture));
    session.read().unwrap()
}
fn mutation(
    fixture: &Fixture,
    old: &IntegrationModelPolicySettingsSnapshot,
    operation: &str,
    title: &str,
) -> IntegrationRequest {
    let mut request = read_request(fixture);
    request.operation_id = Some(operation.into());
    request.expected_revision = Some(old.revision.clone());
    let mut policies = old.policies.clone();
    policies[0].title = title.into();
    request.payload = serde_json::to_value(IntegrationModelPolicySettingsSaveParams { policies })
        .unwrap()
        .as_object()
        .unwrap()
        .clone();
    request
}
fn operation(
    fixture: &Fixture,
    engine: &QueryEngine,
    id: &str,
) -> Option<IntegrationOperationReceipt> {
    let mut request = read_request(fixture);
    request.payload = serde_json::json!({"operationId":id})
        .as_object()
        .unwrap()
        .clone();
    let (_owner, session) = session(fixture, engine, request);
    session.read_operation().unwrap()
}
#[tokio::test]
async fn actual_field_cas_preserves_other_settings_and_original_receipt_is_not_replaced_by_current_content()
 {
    let (fixture, engine) = setup();
    let path = fixture.profile.join("settings.json");
    let original: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(
        super::super::super::NativeOperations::load(&fixture.context)
            .unwrap()
            .is_none()
    );
    let old = read(&fixture, &engine);
    assert_eq!(old.policies.len(), 1);
    assert!(
        super::super::super::NativeOperations::load(&fixture.context)
            .unwrap()
            .is_none()
    );
    let request = mutation(
        &fixture,
        &old,
        "settings-first-original",
        "First exact title",
    );
    let (_owner, writer) = session(&fixture, &engine, request.clone());
    let saved = writer.save().unwrap();
    assert_eq!(saved.operation.phase, IntegrationOperationPhase::Completed);
    assert_ne!(saved.current.revision, old.revision);
    assert_eq!(
        saved.operation.entity_ref.as_ref().unwrap().kind,
        IntegrationEntityKind::ModelPolicyConfiguration
    );
    assert_eq!(
        saved
            .operation
            .entity_ref
            .as_ref()
            .unwrap()
            .revision
            .as_deref(),
        Some(saved.current.revision.as_str())
    );
    let document: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(document["providers"], original["providers"]);
    assert_eq!(document["model"], original["model"]);
    let second = mutation(
        &fixture,
        &saved.current,
        "settings-peer-second",
        "Peer's subsequent title",
    );
    let (_peer_owner, peer) = session(&fixture, &engine, second);
    let peer = peer.save().unwrap();
    let identity = fixture
        .context
        .profile()
        .unwrap()
        .portable_regular_identity(OsStr::new("settings.json"))
        .unwrap();
    let (_retry_owner, retry) = session(&fixture, &engine, request);
    let repeated = retry.save().unwrap();
    assert_eq!(repeated.operation, saved.operation);
    assert_eq!(repeated.current, peer.current);
    assert_eq!(
        fixture
            .context
            .profile()
            .unwrap()
            .portable_regular_identity(OsStr::new("settings.json"))
            .unwrap(),
        identity
    );
    assert_eq!(
        operation(&fixture, &engine, "settings-first-original").unwrap(),
        saved.operation
    );
}
#[tokio::test]
async fn stale_field_revision_and_original_operation_intent_conflicts_do_not_write() {
    let (fixture, engine) = setup();
    let old = read(&fixture, &engine);
    let request = mutation(&fixture, &old, "settings-original", "Saved title");
    let (_owner, first) = session(&fixture, &engine, request);
    let saved = first.save().unwrap();
    let stale = mutation(&fixture, &old, "settings-stale", "Must not overwrite");
    let (_owner, stale) = session(&fixture, &engine, stale);
    let rejected = stale.save().unwrap();
    assert_eq!(
        rejected.operation.phase,
        IntegrationOperationPhase::Rejected
    );
    assert_eq!(rejected.current, saved.current);
    let changed = mutation(
        &fixture,
        &old,
        "settings-original",
        "Different intent same op",
    );
    let (_owner, changed) = session(&fixture, &engine, changed);
    assert!(changed.save().is_err());
    assert_eq!(read(&fixture, &engine), saved.current);
}
#[tokio::test]
async fn an_unconfirmed_original_operation_never_becomes_completed_from_a_same_value_peer_write() {
    let (fixture, engine) = setup();
    let old = read(&fixture, &engine);
    let request = mutation(
        &fixture,
        &old,
        "settings-prepared-original",
        "Same value does not prove authorship",
    );
    let operations = super::super::super::NativeOperations::initialize(
        &fixture.context,
        "settings-ledger-authorized",
    )
    .unwrap();
    let (receipt, fresh) = operations
        .begin(&fixture.context, &request, PORT, METHOD)
        .unwrap();
    assert!(fresh);
    assert_eq!(receipt.phase, IntegrationOperationPhase::Executing);
    // A separate native profile transaction can legitimately write identical
    // content; it has no authority to settle the original operation's receipt.
    let file =
        ProfileSettingsFile::from_directory_handle(fixture.context.profile().unwrap()).unwrap();
    file.update(|document| {
        kcoder_config::set_dotted_value(document, FIELD, request.payload["policies"].clone())
    })
    .unwrap();
    let identity = fixture
        .context
        .profile()
        .unwrap()
        .portable_regular_identity(OsStr::new("settings.json"))
        .unwrap();
    let (_owner, retry) = session(&fixture, &engine, request);
    let observed = retry.save().unwrap();
    assert_eq!(
        observed.operation.phase,
        IntegrationOperationPhase::Executing
    );
    assert!(observed.operation.entity_ref.is_none());
    assert_eq!(
        observed.current.policies[0].title,
        "Same value does not prove authorship"
    );
    assert_eq!(
        fixture
            .context
            .profile()
            .unwrap()
            .portable_regular_identity(OsStr::new("settings.json"))
            .unwrap(),
        identity
    );
    assert_eq!(
        operation(&fixture, &engine, "settings-prepared-original")
            .unwrap()
            .phase,
        IntegrationOperationPhase::Executing
    );
}
#[tokio::test]
async fn cancelled_or_foreign_scope_never_initializes_a_write_and_missing_config_is_not_empty() {
    let (fixture, engine) = setup();
    let old = read(&fixture, &engine);
    let request = mutation(&fixture, &old, "cancelled-settings-save", "No effect");
    let owner = Arc::new(());
    let cancel = CancellationToken::new();
    let writer = NativeModelPolicySettings::capture(
        &fixture.context,
        &engine,
        request,
        Arc::downgrade(&owner),
        cancel.clone(),
    )
    .unwrap();
    cancel.cancel();
    assert!(writer.save().is_err());
    assert!(
        super::super::super::NativeOperations::load(&fixture.context)
            .unwrap()
            .is_none()
    );
    let mut request = read_request(&fixture);
    request.scope.account_id = "foreign-native-owner".into();
    assert!(
        NativeModelPolicySettings::capture(
            &fixture.context,
            &engine,
            request,
            Arc::downgrade(&owner),
            CancellationToken::new()
        )
        .is_err()
    );
    std::fs::remove_file(fixture.profile.join("settings.json")).unwrap();
    let (_owner, session) = session(&fixture, &engine, read_request(&fixture));
    assert!(session.read().is_err());
}
#[tokio::test]
async fn unsafe_existing_configuration_link_is_rejected_without_adopting_or_overwriting_it() {
    let (fixture, engine) = setup();
    let path = fixture.profile.join("settings.json");
    let original = std::fs::read(&path).unwrap();
    std::fs::hard_link(&path, fixture.profile.join("peer-hard-link")).unwrap();
    let (_owner, session) = session(&fixture, &engine, read_request(&fixture));
    assert!(session.read().is_err());
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert!(
        super::super::super::NativeOperations::load(&fixture.context)
            .unwrap()
            .is_none()
    );
}
