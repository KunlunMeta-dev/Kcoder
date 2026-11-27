//! Receiver-local Office installation over its actual ACP parent and Accepted task.
use super::super::receiver_office_parent::{ReceiverOfficeRoots, SameNativeParent};
use super::*;
use crate::app_server::{
    integrations::office::{
        native_assets::NativeOfficeFileAssets,
        native_host::{
            NativeOfficeAcceptedTurnAuthority, NativeOfficeProviders, NativeOfficeTaskAuthority,
        },
        startup_binding::NativeOfficeStartupBinding,
    },
    native_component_parent::NativeComponentParentAuthority,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use kcoder_state::{
    AppStateLifecycleIdentity,
    turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore},
};
use kcoder_types::TurnAttemptStatus;
use tokio_util::sync::CancellationToken;

pub(super) struct Parent {
    binding: Arc<NativeAcpReceiverBinding>,
    roots: ReceiverOfficeRoots,
    engine: QueryEngine,
    state: AppStateLifecycleIdentity,
    accepted: TurnAttemptRecord,
}
impl Parent {
    fn verify(&self) -> Result<()> {
        self.binding.verify()?;
        self.roots.verify()?;
        ensure!(
            self.state.matches(&self.engine.state)
                && self
                    .engine
                    .state
                    .current_history_attempt_identity()
                    .as_ref()
                    == Some(&self.accepted.identity),
            "REMOTE_OFFICE_ORIGINAL_RECEIVER_CHANGED"
        );
        let store = TurnAttemptStore::open_existing(
            &self
                .engine
                .session_storage_dir_for(&self.accepted.identity.thread_id),
            &self.accepted.identity.thread_id,
        )?
        .context("REMOTE_OFFICE_ORIGINAL_RECEIVER_REQUIRED")?;
        ensure!(
            store.load(&self.accepted.identity)?.as_ref() == Some(&self.accepted),
            "REMOTE_OFFICE_ORIGINAL_RECEIVER_CHANGED"
        );
        Ok(())
    }
}
impl NativeComponentParentAuthority for Parent {
    fn administrative_workspace_binding(
        &self,
    ) -> Result<(&str, kcoder_app_protocol::RetentionPrincipalV1)> {
        self.verify()?;
        Ok((
            self.roots.digest(),
            kcoder_app_protocol::RetentionPrincipalV1::LocalOs,
        ))
    }
    fn verify_native_component_roots(
        &self,
        profile: &PrivateDirectory,
        workspace: &PrivateDirectory,
    ) -> Result<()> {
        self.verify()?;
        ensure!(
            self.roots.matches(profile, workspace)?,
            "REMOTE_OFFICE_COMPONENT_ROOT_CHANGED"
        );
        Ok(())
    }
}
struct Tasks(Arc<Parent>);
impl NativeOfficeTaskAuthority for Tasks {
    fn validate(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        task: &kcoder_types::integrations::office::OfficeTaskRef,
    ) -> Result<()> {
        self.0.verify()?;
        NativeOfficeAcceptedTurnAuthority.validate(context, engine, task)
    }
}

pub(super) async fn install(
    binding: Arc<NativeAcpReceiverBinding>,
    engine: QueryEngine,
    accepted: &TurnAttemptRecord,
    cancel: &CancellationToken,
) -> Result<(QueryEngine, Option<Arc<Parent>>)> {
    let policy = binding.policy()?;
    if !policy.office.enabled {
        return Ok((engine, None));
    }
    ensure!(
        accepted.status == TurnAttemptStatus::Accepted && accepted.completion.is_none(),
        "REMOTE_OFFICE_ORIGINAL_RECEIVER_REQUIRED"
    );
    ensure!(
        engine.effective_studio_work_mode() == kcoder_types::StudioWorkMode::Kworker,
        "REMOTE_OFFICE_RECEIVER_WORKMODE_REQUIRED"
    );
    let process = SameNativeParent::capture_current_installation()?;
    let roots = ReceiverOfficeRoots::capture(&binding.receiver, &engine, process)?;
    let parent = Arc::new(Parent {
        binding: binding.clone(),
        roots,
        state: engine.state.inspection_lifecycle_identity(),
        engine: engine.clone(),
        accepted: accepted.clone(),
    });
    parent.verify()?;
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(
        policy
            .office
            .startup_configuration
            .as_ref()
            .context("REMOTE_OFFICE_EXPLICIT_CONFIGURATION_REQUIRED")?,
    )?);
    let startup = NativeOfficeStartupBinding::capture_after_verified_parent(
        Some(parent.as_ref()),
        &engine,
        Some(&encoded),
    )?
    .context("REMOTE_OFFICE_NATIVE_PARENT_REQUIRED")?;
    let assets = Arc::new(NativeOfficeFileAssets::capture(
        &binding.receiver,
        &engine,
        Arc::new(Default::default()),
        None,
    )?);
    let providers = NativeOfficeProviders {
        tasks: Some(Arc::new(Tasks(parent.clone()))),
        ports: None,
        assets: Some(assets),
    };
    let installed = startup
        .install_accepted_turn(
            &binding.receiver,
            &accepted.identity,
            engine,
            providers,
            cancel,
        )
        .await?;
    parent.verify()?;
    ensure!(
        installed.tools.get("OfficeDocument").is_some(),
        "REMOTE_OFFICE_NATIVE_TOOLS_UNAVAILABLE"
    );
    Ok((installed, Some(parent)))
}
