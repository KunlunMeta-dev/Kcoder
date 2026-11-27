//! Shared bootstrap for the original app-server dispatcher. Legacy channel
//! preparations remain readable as stored metadata; neither form is a grant.
use crate::service_leases::NativeServiceLeases;
use anyhow::{Context, Result, ensure};
use kcoder_config::VerifiedPrivateLease;
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_types::integrations::core::{
    AppServerHostIdentity, AppServerHostLaunchSpec, AppServerHostSelection, IntegrationScope,
    NativeOfficeScopeLaunch, NativeScopeHostResources,
};
use std::{fs::File, path::PathBuf};

#[derive(Clone, PartialEq, Eq)]
enum Record {
    Gateway,
    Task {
        selection: AppServerHostSelection,
        specification: Box<AppServerHostLaunchSpec>,
    },
}

pub struct OriginalScopeHostLaunch {
    record: Record,
    pub scope: IntegrationScope,
    pub profile_path: PathBuf,
    pub workspace_path: PathBuf,
    pub settings_file: PathBuf,
    pub native_image_sha256: String,
    pub configuration_sha256: Option<String>,
    pub resources: Option<NativeScopeHostResources>,
    pub office: Option<NativeOfficeScopeLaunch>,
}

pub fn task_reference(selection: &AppServerHostSelection) -> String {
    format!("task:{}:{}", selection.revision, selection.launch_ref)
}

impl OriginalScopeHostLaunch {
    pub fn read(
        native: &mut NativeIntegrationContext,
        storage: &NativeServiceLeases,
        reference: &str,
    ) -> Result<Self> {
        let store = storage.store(native)?;
        if reference.starts_with("task:") {
            let (selection, specification) = store
                .current_app_server_host()?
                .context("APP_SERVER_HOST_ORIGINAL_LAUNCH_REQUIRED")?;
            ensure!(
                selection.enabled && task_reference(&selection) == reference,
                "APP_SERVER_HOST_SELECTION_CHANGED"
            );
            ensure!(
                specification.identity == AppServerHostIdentity::from(native.scope()),
                "APP_SERVER_HOST_IDENTITY_CHANGED"
            );
            Ok(Self {
                scope: native.scope().clone(),
                profile_path: specification.profile_path.clone(),
                workspace_path: specification.workspace_path.clone(),
                settings_file: specification.settings_file.clone(),
                native_image_sha256: specification.native_image_sha256.clone(),
                configuration_sha256: None,
                resources: None,
                office: specification
                    .office
                    .as_ref()
                    .map(|office| office.launch.clone()),
                record: Record::Task {
                    selection,
                    specification: Box::new(specification),
                },
            })
        } else {
            anyhow::bail!("APP_SERVER_HOST_LEGACY_SUPERSEDED")
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    pub fn gateway(native: &NativeIntegrationContext, image: String) -> Result<Self> {
        let profile_path = native.profile_path()?.to_path_buf();
        Ok(Self {
            record: Record::Gateway,
            scope: native.scope().clone(),
            settings_file: profile_path.join("settings.json"),
            profile_path,
            workspace_path: native.workspace_path()?.to_path_buf(),
            native_image_sha256: image,
            configuration_sha256: None,
            resources: None,
            office: None,
        })
    }

    pub fn gateway_owned(&self) -> bool {
        self.record == Record::Gateway
    }

    pub fn persistent_task_host(&self) -> bool {
        // Both launchers keep the task dispatcher alive across adapter restarts.
        true
    }

    pub fn task_office_resource_copy(&self) -> Option<&str> {
        match &self.record {
            Record::Gateway => None,
            Record::Task { specification, .. } => specification
                .office
                .as_ref()
                .map(|office| office.resource_copy_ref.as_str()),
        }
    }

    pub fn verify(
        &self,
        native: &NativeIntegrationContext,
        storage: &NativeServiceLeases,
        reference: &str,
    ) -> Result<()> {
        native.validate_scope(&self.scope)?;
        if let Record::Task {
            selection,
            specification,
        } = &self.record
        {
            ensure!(
                storage.store(native)?.current_app_server_host()?.as_ref()
                    == Some(&(selection.clone(), *specification.clone()))
                    && selection.enabled
                    && task_reference(selection) == reference
                    && specification.identity == AppServerHostIdentity::from(native.scope()),
                "APP_SERVER_HOST_SELECTION_CHANGED"
            );
        }
        Ok(())
    }

    pub fn claim(
        &self,
        native: &NativeIntegrationContext,
        storage: &NativeServiceLeases,
        reference: &str,
    ) -> Result<Option<VerifiedPrivateLease>> {
        self.verify(native, storage, reference)?;
        match &self.record {
            Record::Gateway => storage.store(native)?.try_claim_gateway_app_server(),
            Record::Task { selection, .. } => {
                storage.store(native)?.try_claim_app_server_host(selection)
            }
        }
    }

    pub fn verify_descriptor(
        &self,
        native: &NativeIntegrationContext,
        storage: &NativeServiceLeases,
        reference: &str,
        descriptor: &File,
    ) -> Result<()> {
        self.verify(native, storage, reference)?;
        match &self.record {
            Record::Gateway => storage
                .store(native)?
                .verify_gateway_app_server_descriptor(descriptor),
            Record::Task { selection, .. } => storage
                .store(native)?
                .verify_app_server_host_descriptor(selection, descriptor),
        }
    }
}
