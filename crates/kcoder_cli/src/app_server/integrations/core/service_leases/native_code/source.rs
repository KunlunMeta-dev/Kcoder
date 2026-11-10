//! Source authority comes from actual saved files, native context and resolved configuration.
use super::*;
use crate::app_server::integrations::core::service_leases::{code_task, image::NativeServiceImage};
use anyhow::{Context, ensure};
use kcoder_config::Settings;
use kcoder_engine::QueryEngine;
use kcoder_permissions::integrations::core::AuthenticatedNativeCodeServiceSource;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub(super) struct NativeSavedCodeSource {
    pub(super) native: NativeIntegrationContext,
    pub(super) settings_file: PathBuf,
    pub(super) workspace_path: PathBuf,
    pub(super) task: NativeCodeServiceTask,
    pub(super) configuration_sha256: String,
    pub(super) image: NativeServiceImage,
}
impl NativeSavedCodeSource {
    pub(super) fn from_launch(
        native: &NativeIntegrationContext,
        launch: &NativeCodeServiceLaunchSpec,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<Self> {
        launch.validate()?;
        code_task::verify(native, &launch.task)?;
        ensure!(
            kcoder_config::PrivateDirectory::open_existing(&launch.profile_path)?
                .directory_identity()?
                == native.profile()?.directory_identity()?
                && kcoder_config::PrivateDirectory::open_existing(&launch.workspace_path)?
                    .directory_identity()?
                    == native.workspace_directory_identity()?,
            "NATIVE_CODE_TARGET_LOCATOR_INVALID"
        );
        let settings = load_settings(
            &launch.profile_path,
            &launch.workspace_path,
            &launch.settings_file,
        )?;
        let configuration_sha256 = configuration(&settings, &launch.task)?;
        let image = NativeServiceImage::capture(cancel)?;
        Ok(Self {
            native: native.recapture_for_owned_service()?,
            settings_file: launch.settings_file.clone(),
            workspace_path: launch.workspace_path.clone(),
            task: launch.task.clone(),
            configuration_sha256,
            image,
        })
    }
    pub(super) fn capture(
        native: &NativeIntegrationContext,
        origin: &QueryEngine,
        task: NativeCodeServiceTask,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<Self> {
        code_task::verify(native, &task)?;
        let settings_file = origin
            .settings_persistence_path()
            .context("NATIVE_CODE_SETTINGS_PATH_REQUIRED")?;
        let workspace_path = origin.state.cwd().canonicalize()?;
        ensure!(
            kcoder_config::PrivateDirectory::open_existing(&workspace_path)?
                .directory_identity()?
                == native.workspace_directory_identity()?,
            "NATIVE_CODE_TARGET_LOCATOR_INVALID"
        );
        let resolved = load_settings(native.profile_path()?, &origin.state.cwd(), &settings_file)?;
        let actual = origin
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("NATIVE_CODE_CONFIGURATION_UNAVAILABLE"))?;
        ensure!(
            configuration(&resolved, &task)? == configuration(&actual, &task)?,
            "NATIVE_CODE_PERSISTENT_CONFIGURATION_REQUIRED"
        );
        let configuration_sha256 = configuration(&resolved, &task)?;
        drop(actual);
        let image = NativeServiceImage::capture(cancel)?;
        Ok(Self {
            native: native.recapture_for_owned_service()?,
            settings_file,
            workspace_path,
            task,
            configuration_sha256,
            image,
        })
    }
    pub(super) fn verify(&self) -> Result<()> {
        self.native.verify()?;
        self.image.verify()?;
        code_task::verify(&self.native, &self.task)?;
        let settings = load_settings(
            self.native.profile_path()?,
            &self.native_workspace()?,
            &self.settings_file,
        )?;
        ensure!(
            configuration(&settings, &self.task)? == self.configuration_sha256,
            "NATIVE_CODE_CONFIGURATION_CHANGED"
        );
        Ok(())
    }
    pub(super) fn snapshot(&self) -> Result<AuthenticatedNativeCodeServiceSource> {
        self.verify()?;
        AuthenticatedNativeCodeServiceSource::from_native_source(
            self.native.scope(),
            &self.task.definition_id,
            self.task.version,
            &self.task.definition_sha256,
            &code_task::sha256(&self.task)?,
            &self.configuration_sha256,
            self.image.sha256(),
        )
    }
    fn native_workspace(&self) -> Result<PathBuf> {
        // The native context validates this original locator's held directory identity.
        ensure!(
            kcoder_config::PrivateDirectory::open_existing(&self.workspace_path)?
                .directory_identity()?
                == self.native.workspace_directory_identity()?,
            "NATIVE_CODE_TARGET_LOCATOR_INVALID"
        );
        Ok(self.workspace_path.clone())
    }
}
pub(super) fn load_settings(profile: &Path, workspace: &Path, settings: &Path) -> Result<Settings> {
    super::super::configuration::load_settings(profile, workspace, settings)
}
pub(super) fn configuration(settings: &Settings, task: &NativeCodeServiceTask) -> Result<String> {
    ensure!(
        settings.integrations.services.enabled,
        "SERVICE_FEATURE_DISABLED"
    );
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            "native-code-service-configuration-v1",
            kcoder_engine::model_configuration_summary(
                settings,
                kcoder_types::ModelConfigurationBoundary::SessionSnapshot
            )?,
            code_task::sha256(task)?,
            "no-model-no-tools-no-agent-no-hooks-v1"
        ))?)
    ))
}
