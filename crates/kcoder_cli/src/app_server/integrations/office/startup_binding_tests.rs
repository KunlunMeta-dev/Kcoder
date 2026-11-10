//! Real existing parent/root capture; encoded data alone never authorizes Office.
use super::*;
use crate::app_server::{
    integrations::core::NativeIntegrationContext, retention_context::RetentionLaunchConfiguration,
};
use kcoder_app_protocol::RetentionParentLaunchV1;
use serde_json::json;
use std::ffi::OsStr;
fn fixture() -> (tempfile::TempDir, QueryEngine, NativeIntegrationContext) {
    let temp = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_existing(temp.path()).unwrap();
    parent.create_private_child(OsStr::new("profile")).unwrap();
    parent
        .create_private_child(OsStr::new("workspace"))
        .unwrap();
    let profile = temp.path().join("profile");
    let workspace = temp.path().join("workspace");
    let settings = kcoder_config::Settings {
        training_mode: true,
        history_enabled: true,
        ..Default::default()
    };
    let engine = QueryEngine::try_new_for_client_with_services_and_plugin_snapshot(
        std::sync::Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
            crate::tui_dev_mock::TuiDevScenario::FullTurn,
        )),
        kcoder_state::AppState::new(&workspace),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        std::sync::Arc::new(kcoder_tools::DenyAllUserQuestioner),
        workspace.clone(),
        Some(true),
        kcoder_engine::WorkspaceRuntimeServices::new(&workspace, "owned-startup-parent-capture"),
        kcoder_plugins::EffectivePluginSnapshot::default(),
    )
    .unwrap()
    .with_settings_persistence_path(profile.join("settings.json"));
    assert!(engine.durable_client_storage_root().is_some());
    let context =
        NativeIntegrationContext::capture(&profile, &workspace, "startup-bind-test", "config-r1")
            .unwrap();
    (temp, engine, context)
}
#[cfg(target_os = "linux")]
fn verified(engine: &QueryEngine) -> Arc<dyn NativeComponentParentAuthority> {
    let launch = RetentionLaunchConfiguration {
        parent: RetentionParentLaunchV1::LocalOs,
        account_root: engine
            .settings_persistence_path()
            .unwrap()
            .parent()
            .unwrap()
            .into(),
        optional: false,
        revocation_verifier: None,
    };
    crate::retention_parent_environment::validate_identity(&launch.parent).unwrap();
    let retention =
        Arc::new(crate::app_server::retention_context::capture(launch, engine).unwrap());
    crate::app_server::native_component_parent::from_retention(&retention)
}
fn encoded() -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"schemaVersion":1,"componentRoot":"/explicit/native/office","manifestSha256":"a".repeat(64),"runtime":{"program":std::env::current_exe().unwrap(),"sha256":"b".repeat(64),"mode":"standalone_node","nodeVersion":"22.22.2","electronVersion":null}})).unwrap())
}
#[test]
fn no_verified_parent_means_no_binding_even_for_malformed_or_complete_json() {
    let (_temp, engine, _context) = fixture();
    let complete = encoded();
    for raw in ["not-base64", complete.as_str()] {
        assert!(
            NativeOfficeStartupBinding::capture_after_verified_parent(None, &engine, Some(raw))
                .unwrap()
                .is_none()
        );
    }
}
#[cfg(target_os = "linux")]
#[test]
fn verified_parent_binding_rechecks_actual_native_profile_and_workspace_roots() {
    let (_temp, engine, context) = fixture();
    let parent = verified(&engine);
    let raw = encoded();
    let binding = NativeOfficeStartupBinding::capture_after_verified_parent(
        Some(parent.as_ref()),
        &engine,
        Some(&raw),
    )
    .unwrap()
    .unwrap();
    binding.verify_context(&context, &engine).unwrap();
    let (_other_temp, other_engine, other_context) = fixture();
    assert!(
        binding
            .verify_context(&other_context, &other_engine)
            .is_err()
    );
    assert!(
        NativeOfficeStartupBinding::capture_after_verified_parent(
            Some(parent.as_ref()),
            &other_engine,
            Some(&raw)
        )
        .is_err()
    );
    assert!(
        NativeOfficeStartupBinding::capture_after_verified_parent(
            Some(parent.as_ref()),
            &engine,
            None
        )
        .unwrap()
        .is_none()
    );
}
#[cfg(target_os = "linux")]
#[test]
fn unsupported_modes_unknown_fields_bad_hashes_and_oversized_config_are_not_downgraded() {
    let (_temp, engine, _context) = fixture();
    let parent = verified(&engine);
    let original: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded()).unwrap()).unwrap();
    for mutation in ["mode", "scope", "hash"] {
        let mut input = original.clone();
        match mutation {
            "mode" => input["runtime"]["mode"] = json!("guess_from_extension"),
            "scope" => input["scope"] = json!({"accountId":"forged"}),
            "hash" => input["manifestSha256"] = json!("not-a-sha"),
            _ => unreachable!(),
        };
        let raw = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&input).unwrap());
        assert!(
            NativeOfficeStartupBinding::capture_after_verified_parent(
                Some(parent.as_ref()),
                &engine,
                Some(&raw)
            )
            .is_err()
        );
    }
    assert!(
        NativeOfficeStartupBinding::capture_after_verified_parent(
            Some(parent.as_ref()),
            &engine,
            Some(&"x".repeat(65537))
        )
        .is_err()
    );
}
