//! Actual native caller, workspace FD and existing permission engine; no model.
use super::*;
use kcoder_config::PermissionMode;
use serde_json::json;
struct Fixture {
    _root: tempfile::TempDir,
    workspace: PathBuf,
    profile: PathBuf,
    engine: QueryEngine,
    connection: ConnectionState,
}
impl Fixture {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let profile = parent.create_private_child(OsStr::new("profile"))?;
        profile.atomic_replace(OsStr::new("settings.json"), b"{}")?;
        parent.create_private_child(OsStr::new("workspace"))?;
        let workspace = root.path().join("workspace");
        let profile = root.path().join("profile");
        std::fs::write(
            workspace.join("selected.txt"),
            "UNTRUSTED_BODY_NOT_IN_SELECTION_RECEIPT",
        )?;
        let engine = crate::app_server::tests::catalog_list_test_engine(&workspace)
            .with_settings_persistence_path(profile.join("settings.json"));
        engine
            .settings
            .write()
            .unwrap()
            .integrations
            .knowledge
            .business_automation_enabled = true;
        engine.permissions.write().unwrap().mode = PermissionMode::Ask;
        let native = NativeIntegrationContext::capture(
            &profile,
            &workspace,
            "actual-public-user-selection",
            &engine.active_model_configuration_summary()?.revision,
        )?;
        let connection = ConnectionState {
            initialized: true,
            integration_automation_v1: true,
            integration_context: Some(native),
            ..Default::default()
        };
        Ok(Self {
            _root: root,
            workspace,
            profile,
            engine,
            connection,
        })
    }
    fn request(&self, payload: serde_json::Value) -> IntegrationRequest {
        IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: "native-user-file-selection".into(),
            scope: self
                .connection
                .integration_context
                .as_ref()
                .unwrap()
                .scope()
                .clone(),
            operation_id: Some("explicit-user-selection".into()),
            expected_revision: None,
            timeout_ms: 5000,
            cancellation_ref: None,
            payload: payload.as_object().unwrap().clone(),
        }
    }
}

#[test]
fn actual_read_ask_needs_original_authorization_and_selection_creates_no_store_or_task()
-> Result<()> {
    let f = Fixture::new()?;
    let request = f.request(json!({"relativeDirectory":".","fileNames":["selected.txt"]}));
    let before = std::fs::read_dir(&f.profile)?.count();
    let state = f.engine.state.inspection_lifecycle_identity();
    let permit =
        NativeFileEventSelectionPermit::from_public_control(&f.connection, &f.engine, &request)?;
    let error = permit
        .prepare()
        .err()
        .context("Ask was silently approved")?;
    assert_eq!(error.to_string(), "NATIVE_FILE_READ_AUTHORIZATION_REQUIRED");
    assert_eq!(std::fs::read_dir(&f.profile)?.count(), before);
    assert!(state.matches(&f.engine.state));
    f.engine
        .permissions
        .write()
        .unwrap()
        .allow_for_session("read");
    let selected =
        NativeFileEventSelectionPermit::from_public_control(&f.connection, &f.engine, &request)?
            .prepare()?;
    selected
        .binding
        .verify(f.connection.integration_context.as_ref().unwrap())?;
    let receipt = serde_json::to_string(&selected.receipt)?;
    assert!(!receipt.contains("UNTRUSTED_BODY_NOT_IN_SELECTION_RECEIPT"));
    assert!(!receipt.contains(f.profile.to_string_lossy().as_ref()));
    assert_eq!(selected.receipt.items.len(), 1);
    assert_eq!(std::fs::read_dir(&f.profile)?.count(), before);
    f.engine
        .permissions
        .write()
        .unwrap()
        .deny_for_session("read");
    assert!(
        selected
            .binding
            .verify(f.connection.integration_context.as_ref().unwrap())
            .is_err()
    );
    Ok(())
}

#[test]
fn actual_selection_owner_ends_and_replaced_file_identity_cannot_reuse_read_grant() -> Result<()> {
    let f = Fixture::new()?;
    f.engine
        .permissions
        .write()
        .unwrap()
        .allow_for_session("read");
    let request = f.request(json!({"relativeDirectory":".","fileNames":["selected.txt"]}));
    let selected =
        NativeFileEventSelectionPermit::from_public_control(&f.connection, &f.engine, &request)?
            .prepare()?;
    std::fs::rename(
        f.workspace.join("selected.txt"),
        f.workspace.join("original.txt"),
    )?;
    std::fs::write(f.workspace.join("selected.txt"), "replacement")?;
    assert!(
        selected
            .binding
            .verify(f.connection.integration_context.as_ref().unwrap())
            .is_err()
    );
    let permit =
        NativeFileEventSelectionPermit::from_public_control(&f.connection, &f.engine, &request)?;
    f.connection.input_ended.cancel();
    assert!(permit.prepare().is_err());
    assert!(
        selected
            .binding
            .verify(f.connection.integration_context.as_ref().unwrap())
            .is_err()
    );
    Ok(())
}

#[test]
fn selector_json_cannot_claim_directory_permission_or_escape_actual_workspace() -> Result<()> {
    let f = Fixture::new()?;
    f.engine
        .permissions
        .write()
        .unwrap()
        .allow_for_session("read");
    for payload in [
        json!({"relativeDirectory":"..","fileNames":["selected.txt"]}),
        json!({"relativeDirectory":".","fileNames":["selected.txt"],"authorized":true}),
        json!({"relativeDirectory":"/","fileNames":["selected.txt"]}),
    ] {
        assert!(
            NativeFileEventSelectionPermit::from_public_control(
                &f.connection,
                &f.engine,
                &f.request(payload)
            )
            .is_err()
        );
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            f.workspace.join("selected.txt"),
            f.workspace.join("linked.txt"),
        )?;
        let request = f.request(json!({"relativeDirectory":".","fileNames":["linked.txt"]}));
        assert!(
            NativeFileEventSelectionPermit::from_public_control(
                &f.connection,
                &f.engine,
                &request
            )?
            .prepare()
            .is_err()
        );
        std::fs::hard_link(
            f.workspace.join("selected.txt"),
            f.workspace.join("hard.txt"),
        )?;
        let request = f.request(json!({"relativeDirectory":".","fileNames":["hard.txt"]}));
        assert!(
            NativeFileEventSelectionPermit::from_public_control(
                &f.connection,
                &f.engine,
                &request
            )?
            .prepare()
            .is_err()
        );
    }
    Ok(())
}

#[test]
fn reordered_same_real_selection_keeps_opaque_reference_without_new_authority() -> Result<()> {
    let f = Fixture::new()?;
    f.engine
        .permissions
        .write()
        .unwrap()
        .allow_for_session("read");
    std::fs::write(f.workspace.join("second.txt"), "second selected data")?;
    let one = f.request(json!({"relativeDirectory":".","fileNames":["selected.txt","second.txt"]}));
    let two = f.request(json!({"relativeDirectory":".","fileNames":["second.txt","selected.txt"]}));
    let first =
        NativeFileEventSelectionPermit::from_public_control(&f.connection, &f.engine, &one)?
            .prepare()?;
    let second =
        NativeFileEventSelectionPermit::from_public_control(&f.connection, &f.engine, &two)?
            .prepare()?;
    assert_eq!(first.receipt, second.receipt);
    f.connection.input_ended.cancel();
    assert!(
        first
            .binding
            .verify(f.connection.integration_context.as_ref().unwrap())
            .is_err()
    );
    assert!(
        second
            .binding
            .verify(f.connection.integration_context.as_ref().unwrap())
            .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn actual_public_selection_control_reconciles_original_operation_without_replacing_live_grant()
-> Result<()> {
    let f = Fixture::new()?;
    f.engine
        .permissions
        .write()
        .unwrap()
        .allow_for_session("read");
    let request = f.request(json!({"relativeDirectory":".","fileNames":["selected.txt"]}));
    let first = NativeFileEventSelectionControl::from_public_control(
        &f.connection,
        &f.engine,
        request.clone(),
    )?
    .run()
    .await;
    assert_eq!(
        first.status,
        IntegrationStatus::Completed,
        "{:?}",
        first.error
    );
    let receipt: AutomationFileSelectionReceipt = serde_json::from_value(
        serde_json::Value::Object(first.result.as_ref().unwrap().clone()),
    )?;
    let old = f
        .connection
        .integration_knowledge
        .lock()
        .await
        .file_event_source(&receipt.source_ref)
        .unwrap();
    let second = NativeFileEventSelectionControl::from_public_control(
        &f.connection,
        &f.engine,
        request.clone(),
    )?
    .run()
    .await;
    assert_eq!(
        second.status,
        IntegrationStatus::Completed,
        "{:?}",
        second.error
    );
    assert_eq!(second.result, first.result);
    let same = f
        .connection
        .integration_knowledge
        .lock()
        .await
        .file_event_source(&receipt.source_ref)
        .unwrap();
    assert!(Arc::ptr_eq(&old, &same));
    let native = f.connection.integration_context.as_ref().unwrap();
    let operations =
        crate::app_server::integrations::core::NativeOperations::load(native)?.unwrap();
    let persisted = operations.read(native, "explicit-user-selection")?.unwrap();
    assert_eq!(persisted.phase, IntegrationOperationPhase::Completed);
    assert_eq!(
        persisted.entity_ref.as_ref().unwrap().id,
        receipt.source_ref
    );
    std::fs::rename(
        f.workspace.join("selected.txt"),
        f.workspace.join("original.txt"),
    )?;
    std::fs::write(
        f.workspace.join("selected.txt"),
        "replacement after lost receipt",
    )?;
    let conflict =
        NativeFileEventSelectionControl::from_public_control(&f.connection, &f.engine, request)?
            .run()
            .await;
    assert_eq!(conflict.status, IntegrationStatus::Rejected);
    assert_eq!(
        conflict.error.as_ref().unwrap().code,
        "AUTOMATION_FILE_SELECTION_CONFLICT"
    );
    assert!(Arc::ptr_eq(
        &old,
        &f.connection
            .integration_knowledge
            .lock()
            .await
            .file_event_source(&receipt.source_ref)
            .unwrap()
    ));
    Ok(())
}

#[test]
fn actual_internal_runtime_dispatch_marker_cannot_capture_a_public_user_file_selection()
-> Result<()> {
    let mut f = Fixture::new()?;
    f.engine
        .permissions
        .write()
        .unwrap()
        .allow_for_session("read");
    let request = f.request(json!({"relativeDirectory":".","fileNames":["selected.txt"]}));
    f.connection.native_source_dispatch = true;
    assert!(
        NativeFileEventSelectionPermit::from_public_control(&f.connection, &f.engine, &request)
            .is_err()
    );
    f.connection.native_source_dispatch = false;
    NativeFileEventSelectionPermit::from_public_control(&f.connection, &f.engine, &request)?
        .prepare()?;
    Ok(())
}
