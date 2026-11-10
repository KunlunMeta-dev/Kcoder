//! Defaults selected by the receiving Native startup, never ACP source metadata.
use super::*;
use kcoder_app_protocol::ThreadStartParams;
use kcoder_config::{PrivateDirectory, integrations::remotes::RemoteIntegrationSettings};
use kcoder_engine::QueryEngine;
use kcoder_types::StudioWorkMode;

/// The real OS-held independent receiver startup remains attached to these
/// defaults. Neither this type nor the startup authority can be deserialized.
pub(crate) struct NativeReceiverThreadDefaults {
    startup: Arc<super::receiver_office_parent::ReceiverOfficeDefaultsStartup>,
    model: String,
}
impl NativeReceiverThreadDefaults {
    pub(crate) fn apply_to_unset(&self, params: &mut ThreadStartParams) -> Result<()> {
        self.startup.verify()?;
        if params.studio_work_mode.is_none() {
            params.studio_work_mode = Some(StudioWorkMode::Kworker);
        }
        if params.model.is_none() {
            params.model = Some(self.model.clone());
        }
        Ok(())
    }
}

pub(crate) fn observe_current_receiver_defaults(
    engine: &QueryEngine,
) -> Result<Option<NativeReceiverThreadDefaults>> {
    let Some(locator) = std::env::var_os(super::launch::NATIVE_REMOTE_LAUNCH_ENV) else {
        return Ok(None);
    };
    let profile_path = engine
        .settings_persistence_path()
        .context("REMOTE_OFFICE_PROFILE_REQUIRED")?;
    let directory = profile_path
        .parent()
        .context("REMOTE_OFFICE_PROFILE_REQUIRED")?;
    ensure!(
        profile_path.file_name() == Some(OsStr::new("settings.json")),
        "REMOTE_OFFICE_PROFILE_REQUIRED"
    );
    let profile = PrivateDirectory::open_existing(directory)?;
    profile.verify_private_directory()?;
    let snapshot = profile.read_source_document_snapshot(
        OsStr::new("settings.json"),
        8 * 1024 * 1024,
        || profile.verify_private_directory().is_ok(),
    )?;
    let policy = RemoteIntegrationSettings::from_native_profile_snapshot(snapshot.bytes())?;
    if !policy.receiver.office.enabled {
        return Ok(None);
    }
    RemoteIntegrationSettings::validate_native_receiver(snapshot.bytes())?;
    let native = NativeIntegrationContext::capture_existing(
        directory,
        &engine.state.cwd(),
        "actual-native-receiver-office-startup",
        &snapshot.sha256,
    )?;
    let incoming = super::launch::NativeRemoteSessionStartup::observe(
        locator
            .to_str()
            .context("REMOTE_NATIVE_LAUNCH_LOCATOR_INVALID")?,
        &native,
    )?;
    let startup = Arc::new(
        super::receiver_office_parent::ReceiverOfficeDefaultsStartup::capture(
            incoming, &native, engine,
        )?,
    );
    let model = RemoteIntegrationSettings::explicit_receiver_model_selection(snapshot.bytes())?;
    startup.verify()?;
    Ok(Some(NativeReceiverThreadDefaults { startup, model }))
}
