//! Platform bundles attach to a task host; their metadata grants no connection.
use super::super::{NativeServiceLeases, configuration};
use super::NativeScopeHostBootstrap;
use anyhow::{Context, Result, ensure};
use kcoder_types::integrations::core::NativeScopeHostLaunchSpec;

fn matches_original(
    specification: &NativeScopeHostLaunchSpec,
    scope: &kcoder_types::integrations::core::IntegrationScope,
    launch: &super::launch::OriginalScopeHostLaunch,
    settings: &kcoder_config::Settings,
) -> Result<bool> {
    specification.validate()?;
    Ok(specification.scope == *scope
        && specification.profile_path == launch.profile_path
        && specification.workspace_path == launch.workspace_path
        && specification.settings_file == launch.settings_file
        && specification.native_image_sha256 == launch.native_image_sha256
        && super::bootstrap::configuration_sha_with_office(
            settings,
            &specification.resources,
            specification.office.as_ref(),
        )? == specification.configuration_sha256)
}

fn original_bundle(
    native: &super::super::NativeIntegrationContext,
    launch: &super::launch::OriginalScopeHostLaunch,
    storage: &NativeServiceLeases,
    settings: &kcoder_config::Settings,
    reference: Option<&str>,
) -> Result<NativeScopeHostLaunchSpec> {
    if let Some(reference) = reference {
        let specification = storage
            .store(native)?
            .read_scope_host(reference)?
            .context("APP_SERVER_ADAPTER_ORIGINAL_BUNDLE_REQUIRED")?;
        ensure!(
            matches_original(&specification, native.scope(), launch, settings)?,
            "APP_SERVER_ADAPTER_ORIGINAL_BUNDLE_REQUIRED"
        );
        return Ok(specification);
    }
    let mut candidates = Vec::new();
    for (_, specification) in storage.store(native)?.list_scope_hosts()? {
        if matches_original(&specification, native.scope(), launch, settings)? {
            candidates.push(specification);
        }
    }
    ensure!(
        candidates.len() == 1,
        "APP_SERVER_ADAPTER_ORIGINAL_BUNDLE_REQUIRED"
    );
    Ok(candidates.remove(0))
}

pub(crate) fn original_connectivity_binding_for_launch(
        host: &NativeScopeHostBootstrap,origin:&kcoder_engine::QueryEngine,reference:Option<&str>,
)->Result<std::sync::Arc<crate::app_server::integrations::connectivity::installed_resources::NativeConnectivityStartupBinding>>{
    host.verify()?;
    let raw = if let Some(raw) = host.connectivity_launch()?.filter(|_| reference.is_none()) {
        raw
    } else {
        let native = host.native();
        let launch = host.launch();
        let settings = configuration::load_settings(
            &launch.profile_path,
            &launch.workspace_path,
            &launch.settings_file,
        )?;
        let storage =
            NativeServiceLeases::load(native)?.context("APP_SERVER_ADAPTER_STORE_REQUIRED")?;
        let original = original_bundle(native, launch, &storage, &settings, reference)?;
        let resource = &original.resources;
        // These paths came from the original immutable target-side record.
        // Actual bundle verification still runs before a new Main/SDK starts.
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
        std::ffi::OsString::from(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({
                "schemaVersion":1,"componentRoot":resource.component_root,
                "manifestSha256":resource.component_manifest_sha256,"nodeProgram":resource.node_program,
                "nodeSha256":resource.node_image_sha256,"nodeMode":resource.runtime_mode,
                "nodeVersion":resource.node_version,"electronVersion":resource.electron_version,
            }))?))
    };
    let binding=crate::app_server::integrations::connectivity::installed_resources::NativeConnectivityStartupBinding::capture_after_verified_parent(
            Some(host),origin,raw.to_str(),
        )?.context("APP_SERVER_ADAPTER_ORIGINAL_BINDING_REQUIRED")?;
    host.verify()?;
    Ok(std::sync::Arc::new(binding))
}
#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::app_server::integrations::core::runtime_driver::test_support::Fixture;
    use kcoder_types::integrations::core::{
        AppServerHostIdentity, AppServerHostLaunchSpec, NativeScopeHostResources,
    };

    #[test]
    fn sdk_descriptor_does_not_claim_another_core_or_depend_on_task_settings() -> Result<()> {
        let mut fixture = Fixture::new();
        fixture.context.pin_lifecycle_revision()?;
        let storage =
            NativeServiceLeases::initialize(&fixture.context, "first-party-task-infrastructure")?;
        let spec = AppServerHostLaunchSpec {
            schema_version: 1,
            identity: AppServerHostIdentity::from(fixture.context.scope()),
            profile_path: fixture.profile.clone(),
            workspace_path: fixture.workspace.clone(),
            settings_file: fixture.profile.join("settings.json"),
            native_image_sha256: "a".repeat(64),
            office: None,
        };
        let selection = storage.store(&fixture.context)?.select_app_server_host(
            &spec,
            true,
            None,
            "select-original-task-host",
        )?;
        let reference = super::super::launch::task_reference(&selection);
        let launch = super::super::launch::OriginalScopeHostLaunch::read(
            &mut fixture.context,
            &storage,
            &reference,
        )?;
        let held = launch
            .claim(&fixture.context, &storage, &reference)?
            .context("ORIGINAL_CORE_FENCE_REQUIRED")?;
        let mut settings = kcoder_config::Settings::default();
        settings.integrations.connectivity.enabled = true;
        let resources = NativeScopeHostResources {
            component_root: fixture.profile.join("sdk"),
            component_manifest_sha256: "b".repeat(64),
            node_program: fixture.profile.join("node"),
            node_image_sha256: "c".repeat(64),
            runtime_mode: "standalone_node".into(),
            node_version: Some("22.17.0".into()),
            electron_version: None,
        };
        let sdk = NativeScopeHostLaunchSpec {
            schema_version: 1,
            scope: fixture.context.scope().clone(),
            profile_path: spec.profile_path.clone(),
            workspace_path: spec.workspace_path.clone(),
            settings_file: spec.settings_file.clone(),
            native_image_sha256: spec.native_image_sha256.clone(),
            configuration_sha256: super::super::bootstrap::configuration_sha(
                &settings, &resources,
            )?,
            resources,
            office: None,
        };
        let sdk_reference = storage
            .store(&fixture.context)?
            .prepare_scope_host(&sdk, "retain-original-sdk-descriptor")?;
        assert!(
            storage
                .store(&fixture.context)?
                .try_claim_scope_host(&sdk_reference)?
                .is_none()
        );
        assert_eq!(
            original_bundle(&fixture.context, &launch, &storage, &settings, None)?,
            sdk
        );
        settings.model = "different-task-model".into();
        settings.integrations.knowledge.business_automation_enabled =
            !settings.integrations.knowledge.business_automation_enabled;
        assert_eq!(
            original_bundle(&fixture.context, &launch, &storage, &settings, None)?,
            sdk
        );
        let mut different = sdk.clone();
        different.native_image_sha256 = "d".repeat(64);
        assert!(!matches_original(
            &different,
            fixture.context.scope(),
            &launch,
            &settings
        )?);
        let mut ambiguous = sdk.clone();
        ambiguous.resources.component_root = fixture.profile.join("another-sdk-copy");
        storage
            .store(&fixture.context)?
            .prepare_scope_host(&ambiguous, "another-descriptor")?;
        assert!(original_bundle(&fixture.context, &launch, &storage, &settings, None).is_err());
        assert_eq!(
            original_bundle(
                &fixture.context,
                &launch,
                &storage,
                &settings,
                Some(&sdk_reference)
            )?,
            sdk,
            "A verified original request selects its exact deployment without deleting other records"
        );
        let wrong_reference = storage
            .store(&fixture.context)?
            .prepare_scope_host(&different, "foreign-image-reference")?;
        assert!(
            original_bundle(
                &fixture.context,
                &launch,
                &storage,
                &settings,
                Some(&wrong_reference)
            )
            .is_err()
        );
        assert!(
            original_bundle(
                &fixture.context,
                &launch,
                &storage,
                &settings,
                Some(&"0".repeat(64))
            )
            .is_err()
        );
        launch.verify_descriptor(&fixture.context, &storage, &reference, held.file())?;
        Ok(())
    }
}
