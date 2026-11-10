//! Actual receiver-owned Office installation after its original durable Accepted.
#![cfg(target_os = "linux")]
use super::receiver_office_parent::{ReceiverOfficeParent, ReceiverOfficeStartup};
use super::*;
use crate::app_server::integrations::office::{
    native_assets::NativeOfficeFileAssets,
    native_host::{
        NativeOfficeAcceptedTurnAuthority, NativeOfficeProviders, NativeOfficeTaskAuthority,
    },
    startup_binding::NativeOfficeStartupBinding,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use kcoder_config::integrations::remotes::RemoteIntegrationSettings;
use kcoder_engine::QueryEngine;
use kcoder_state::turn_attempt_store::TurnAttemptRecord;
use tokio_util::sync::CancellationToken;

pub(super) async fn install(
    incoming: Arc<super::launch::NativeRemoteIncomingLaunch>,
    receiver: &NativeIntegrationContext,
    engine: QueryEngine,
    accepted: &TurnAttemptRecord,
    cancel: &CancellationToken,
) -> Result<(QueryEngine, Option<Arc<ReceiverOfficeParent>>)> {
    if !incoming.receiver_policy().office.enabled {
        return Ok((engine, None));
    }
    ensure!(
        engine.effective_studio_work_mode() == kcoder_types::StudioWorkMode::Kworker,
        "REMOTE_OFFICE_RECEIVER_WORKMODE_REQUIRED"
    );
    let actual_settings = serde_json::to_vec(
        &*engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("REMOTE_OFFICE_SETTINGS_UNAVAILABLE"))?,
    )?;
    RemoteIntegrationSettings::validate_native_receiver(&actual_settings)?;
    let configuration = incoming
        .receiver_policy()
        .office
        .startup_configuration
        .as_ref()
        .context("REMOTE_OFFICE_EXPLICIT_CONFIGURATION_REQUIRED")?
        .clone();
    let startup = Arc::new(ReceiverOfficeStartup::capture(incoming, receiver, &engine)?);
    let parent = Arc::new(ReceiverOfficeParent::bind_accepted(
        startup, &engine, accepted,
    )?);
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&configuration)?);
    let binding = NativeOfficeStartupBinding::capture_after_verified_parent(
        Some(parent.as_ref()),
        &engine,
        Some(&encoded),
    )?
    .context("REMOTE_OFFICE_NATIVE_PARENT_REQUIRED")?;
    let assets = Arc::new(NativeOfficeFileAssets::capture(
        receiver,
        &engine,
        Arc::new(Default::default()),
        None,
    )?);
    let providers = NativeOfficeProviders {
        tasks: Some(Arc::new(ReceiverOfficeTaskAuthority {
            parent: parent.clone(),
        })),
        ports: None,
        assets: Some(assets),
    };
    let installed = binding
        .install_accepted_turn(receiver, &accepted.identity, engine, providers, cancel)
        .await?;
    parent.verify()?;
    ensure!(
        installed.tools.get("OfficeDocument").is_some(),
        "REMOTE_OFFICE_NATIVE_TOOLS_UNAVAILABLE"
    );
    Ok((installed, Some(parent)))
}

struct ReceiverOfficeTaskAuthority {
    parent: Arc<ReceiverOfficeParent>,
}
impl NativeOfficeTaskAuthority for ReceiverOfficeTaskAuthority {
    fn validate(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        task: &kcoder_types::integrations::office::OfficeTaskRef,
    ) -> Result<()> {
        self.parent.verify()?;
        NativeOfficeAcceptedTurnAuthority.validate(context, engine, task)
    }
}
