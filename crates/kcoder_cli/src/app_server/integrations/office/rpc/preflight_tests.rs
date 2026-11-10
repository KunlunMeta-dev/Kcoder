//! Actual native scope/metadata checks; no model or business provider is invoked.
use super::*;
use crate::app_server::integrations::core::{NativeDomain, NativeDomainGuard};
use kcoder_config::PrivateDirectory;
use std::ffi::OsStr;
use std::sync::atomic::{AtomicUsize, Ordering};

#[tokio::test]
async fn denied_native_read_never_constructs_or_polls_a_component_probe() {
    let constructed = AtomicUsize::new(0);
    let polled = AtomicUsize::new(0);
    let denied = observe_after_authorization(
        || anyhow::bail!("OFFICE_ORGANIZATION_READ_DENIED"),
        || {
            constructed.fetch_add(1, Ordering::SeqCst);
            async {
                polled.fetch_add(1, Ordering::SeqCst);
                true
            }
        },
    )
    .await;
    assert!(denied.is_err());
    assert_eq!(constructed.load(Ordering::SeqCst), 0);
    assert_eq!(polled.load(Ordering::SeqCst), 0);
    assert!(
        observe_after_authorization(|| Ok(()), || async { true })
            .await
            .unwrap()
    );
}

fn fixture() -> (
    tempfile::TempDir,
    NativeIntegrationContext,
    QueryEngine,
    IntegrationRequest,
) {
    let root = tempfile::tempdir().unwrap();
    let directory = PrivateDirectory::open_existing(root.path()).unwrap();
    directory
        .create_private_child(OsStr::new("profile"))
        .unwrap();
    directory
        .create_private_child(OsStr::new("workspace"))
        .unwrap();
    let profile = root.path().join("profile");
    let workspace = root.path().join("workspace");
    let engine = crate::app_server::tests::catalog_list_test_engine(&workspace)
        .with_settings_persistence_path(profile.join("settings.json"));
    engine.settings.write().unwrap().integrations.office.enabled = true;
    let native =
        NativeIntegrationContext::capture(&profile, &workspace, "owned-static-check", "config-1")
            .unwrap();
    let definition = kcoder_config::integrations::office::builtin_office_assistant(
        "builtin.meeting-minutes",
        "en",
    )
    .unwrap();
    let request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "owned-first-read".into(),
        scope: native.scope().clone(),
        operation_id: None,
        expected_revision: None,
        timeout_ms: 1000,
        cancellation_ref: None,
        payload: json!({"definition":definition})
            .as_object()
            .unwrap()
            .clone(),
    };
    (root, native, engine, request)
}

#[tokio::test]
async fn first_static_check_does_not_create_office_storage_or_invent_observed_capabilities() {
    let (_root, native, engine, request) = fixture();
    assert!(
        NativeDomainGuard::observe(
            native.profile().unwrap(),
            native.scope(),
            NativeDomain::Office
        )
        .unwrap()
        .is_none()
    );
    let report = uninitialized(
        &native,
        &engine,
        &request,
        json!({"status":"unknown","supportedFormats":[]}),
        None,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(report["definitionValid"], true);
    assert_eq!(report["staticOnly"], true);
    assert_eq!(report["storageState"], "not_initialized");
    assert_eq!(report["readiness"]["state"], "unknown");
    assert_eq!(report["readiness"]["capabilities"], json!([]));
    assert_eq!(report["adoptable"], false);
    assert!(
        NativeDomainGuard::observe(
            native.profile().unwrap(),
            native.scope(),
            NativeDomain::Office
        )
        .unwrap()
        .is_none()
    );
}

#[tokio::test]
async fn first_static_check_rejects_a_changed_target_identity_without_initializing_a_store() {
    let (_root, native, engine, mut request) = fixture();
    request.scope.target_revision = "foreign-revision".into();
    assert!(
        uninitialized(
            &native,
            &engine,
            &request,
            Value::Null,
            None,
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert!(
        NativeDomainGuard::observe(
            native.profile().unwrap(),
            native.scope(),
            NativeDomain::Office
        )
        .unwrap()
        .is_none()
    );
}
