use super::*;
use crate::app_server::integrations::core::runtime_driver::test_support::Fixture;
use anyhow::{Context, Result};
use kcoder_native_journal::service_leases::NativeServiceLeases;
use kcoder_types::integrations::core::{
    AppServerHostIdentity, AppServerHostLaunchSpec, NativeScopeHostLaunchSpec,
    NativeScopeHostResources,
};

#[test]
fn a_selected_task_host_never_reactivates_a_legacy_task_core() -> Result<()> {
    let mut fixture = Fixture::new();
    fixture.context.pin_lifecycle_revision()?;
    let storage = NativeServiceLeases::initialize(&fixture.context, "legacy-superseded-fixture")?;
    let spec = AppServerHostLaunchSpec {
        schema_version: 1,
        identity: AppServerHostIdentity::from(fixture.context.scope()),
        profile_path: fixture.profile.clone(),
        workspace_path: fixture.workspace.clone(),
        settings_file: fixture.profile.join("settings.json"),
        native_image_sha256: "a".repeat(64),
        office: None,
    };
    let legacy = NativeScopeHostLaunchSpec {
        schema_version: 1,
        scope: fixture.context.scope().clone(),
        profile_path: spec.profile_path.clone(),
        workspace_path: spec.workspace_path.clone(),
        settings_file: spec.settings_file.clone(),
        native_image_sha256: "a".repeat(64),
        configuration_sha256: "b".repeat(64),
        office: None,
        resources: NativeScopeHostResources {
            component_root: fixture.profile.join("component-data-only"),
            component_manifest_sha256: "c".repeat(64),
            node_program: fixture.profile.join("node-data-only"),
            node_image_sha256: "d".repeat(64),
            runtime_mode: "standalone_node".into(),
            node_version: None,
            electron_version: None,
        },
    };
    let original = storage
        .store(&fixture.context)?
        .prepare_scope_host(&legacy, "legacy-data")?;
    storage.store(&fixture.context)?.select_app_server_host(
        &spec,
        true,
        None,
        "selected-task-host",
    )?;
    assert_eq!(
        OriginalScopeHostLaunch::read(&mut fixture.context, &storage, &original)
            .err()
            .context("superseded legacy launch must fail")?
            .to_string(),
        "APP_SERVER_HOST_LEGACY_SUPERSEDED"
    );
    Ok(())
}

#[test]
fn task_host_uses_original_roots_and_fence_without_any_channel_or_model_grant() -> Result<()> {
    let mut fixture = Fixture::new();
    fixture.context.pin_lifecycle_revision()?;
    let storage = NativeServiceLeases::initialize(&fixture.context, "original-first-party-launch")?;
    let spec = AppServerHostLaunchSpec {
        schema_version: 1,
        identity: AppServerHostIdentity::from(fixture.context.scope()),
        profile_path: fixture.profile.clone(),
        workspace_path: fixture.workspace.clone(),
        settings_file: fixture.profile.join("settings.json"),
        native_image_sha256: "a".repeat(64),
        office: None,
    };
    let selected = storage.store(&fixture.context)?.select_app_server_host(
        &spec,
        true,
        None,
        "initial-host",
    )?;
    let reference = task_reference(&selected);
    let launch = OriginalScopeHostLaunch::read(&mut fixture.context, &storage, &reference)?;
    assert!(launch.persistent_task_host());
    assert!(launch.resources.is_none() && launch.office.is_none());
    let held = launch
        .claim(&fixture.context, &storage, &reference)?
        .context("original fence")?;
    launch.verify_descriptor(&fixture.context, &storage, &reference, held.file())?;
    assert!(
        launch
            .claim(&fixture.context, &storage, &reference)?
            .is_none()
    );
    std::fs::write(
        &spec.settings_file,
        br#"{"model":"changed","knowledge":{"enabled":true}}"#,
    )?;
    launch.verify(&fixture.context, &storage, &reference)?;
    assert!(
        OriginalScopeHostLaunch::read(
            &mut fixture.context,
            &storage,
            &format!("task:2:{}", selected.launch_ref)
        )
        .is_err()
    );
    storage.store(&fixture.context)?.select_app_server_host(
        &spec,
        false,
        Some(1),
        "explicit-stop",
    )?;
    assert!(
        launch
            .verify(&fixture.context, &storage, &reference)
            .is_err()
    );
    Ok(())
}
