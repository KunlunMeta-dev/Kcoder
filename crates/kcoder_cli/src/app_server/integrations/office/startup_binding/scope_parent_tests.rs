//! Real parent/root capture tests; metadata does not prove a retained Core or tool grant.
use super::*;
use crate::app_server::retention_context::RetentionLaunchConfiguration;
use kcoder_config::Settings;
use kcoder_tools::ToolRegistry;
struct NeverModel;
impl kcoder_api::Provider for NeverModel {
    fn name(&self) -> &'static str {
        "office-scope-parent-boundary"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        panic!("Scope/root observation must not invoke a model");
    }
}
fn fixture() -> (
    tempfile::TempDir,
    NativeIntegrationContext,
    QueryEngine,
    String,
) {
    let directory = tempfile::tempdir().unwrap();
    let root = PrivateDirectory::open_existing(directory.path()).unwrap();
    root.create_private_child(std::ffi::OsStr::new("profile"))
        .unwrap();
    root.create_private_child(std::ffi::OsStr::new("workspace"))
        .unwrap();
    let profile = directory.path().join("profile");
    let workspace = directory.path().join("workspace");
    let native = NativeIntegrationContext::capture(
        &profile,
        &workspace,
        "owned-office-parent",
        "configuration",
    )
    .unwrap();
    let settings = Settings {
        history_enabled: false,
        ..Default::default()
    };
    let engine = QueryEngine::try_new_for_client_with_services(
        Arc::new(NeverModel),
        kcoder_state::AppState::new(&workspace),
        ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        workspace.clone(),
        Some(true),
        kcoder_engine::WorkspaceRuntimeServices::new(&workspace, "owned-office-parent"),
    )
    .unwrap()
    .with_settings_persistence_path(profile.join("settings.json"));
    let raw=URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({
        "schemaVersion":1,"componentRoot":directory.path().join("missing-components"),
        "manifestSha256":"a".repeat(64),"runtime":{"program":directory.path().join("missing-node"),
        "sha256":"b".repeat(64),"mode":"standalone_node","nodeVersion":"22.0.0","electronVersion":null}
    })).unwrap());
    (directory, native, engine, raw)
}
fn parent(
    native: &NativeIntegrationContext,
    engine: &QueryEngine,
) -> Arc<dyn NativeComponentParentAuthority> {
    let retention = Arc::new(
        crate::app_server::retention_context::capture(
            RetentionLaunchConfiguration {
                parent: kcoder_app_protocol::RetentionParentLaunchV1::LocalOs,
                account_root: native.profile_path().unwrap().into(),
                optional: false,
                revocation_verifier: None,
            },
            engine,
        )
        .unwrap(),
    );
    crate::app_server::native_component_parent::from_retention(&retention)
}
#[test]
fn borrowed_capture_cannot_become_a_scope_producer() {
    let (_directory, native, engine, raw) = fixture();
    let original = parent(&native, &engine);
    let borrowed = NativeOfficeStartupBinding::capture_after_verified_parent(
        Some(original.as_ref()),
        &engine,
        Some(&raw),
    )
    .unwrap()
    .unwrap();
    assert!(
        borrowed
            .describe_original_scope_launch(&native, &engine)
            .is_err()
    );
    assert!(
        NativeOfficeStartupBinding::capture_with_verified_parent_owner(None, &engine, Some(&raw))
            .unwrap()
            .is_none()
    );
}
#[tokio::test]
async fn actual_owned_parent_metadata_cannot_retain_missing_components_or_another_workspace() {
    let (directory, native, engine, raw) = fixture();
    let original = parent(&native, &engine);
    let captured = NativeOfficeStartupBinding::capture_with_verified_parent_owner(
        Some(original),
        &engine,
        Some(&raw),
    )
    .unwrap()
    .unwrap();
    captured
        .describe_original_scope_launch(&native, &engine)
        .unwrap()
        .validate()
        .unwrap();
    let target = PrivateDirectory::open_existing(directory.path()).unwrap();
    assert!(
        captured
            .retain_original_scope_launch(
                &target,
                directory.path(),
                &native,
                &engine,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert!(!directory.path().join("office").exists());
    let (_other, other_native, other_engine, _) = fixture();
    assert!(
        captured
            .describe_original_scope_launch(&other_native, &other_engine)
            .is_err()
    );
}
