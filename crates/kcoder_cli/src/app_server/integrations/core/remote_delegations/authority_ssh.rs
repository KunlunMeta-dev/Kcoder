//! Actual accepted Source plus its captured host lane. No JSON authority constructor.
use super::{
    authority::validate_caller,
    registry::NativeRemoteRegistry,
    source_budget::{NativeRemoteSourceBudget, NativeRemoteSourceTaskOwner},
    transport::{
        NativeRemoteSourceControl, NativeRemoteSourceFrames, host_client::NativeRemoteHostClient,
    },
    *,
};
use anyhow::{Context, Result, ensure};
use kcoder_acp::outbound::{InstalledOutboundRunner, OutboundEffect, OwnedNativeFrameTransport};
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_config::integrations::remotes::ConfiguredNativeSshPeer;
use kcoder_engine::QueryEngine;
use kcoder_tools::{ToolContext, integrations::remotes::RemoteDelegateInput};
use kcoder_types::{TurnAttemptIdentity, integrations::core::*};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use tokio_util::sync::CancellationToken;

pub struct AcceptedSshRemoteAuthority {
    native: NativeIntegrationContext,
    engine: QueryEngine,
    caller: ToolContext,
    attempt: TurnAttemptIdentity,
    registry: NativeRemoteRegistry,
    selector: ConfiguredNativeSshPeer,
    budget: Arc<NativeRemoteSourceBudget>,
    frames: Arc<NativeRemoteSourceFrames>,
    control: NativeRemoteSourceControl,
    bind: NativeRemoteControlFrameV1,
    bound: AtomicBool,
    prompt: String,
    session: Mutex<Option<String>>,
    deadline: tokio::time::Instant,
    identity: Value,
    result_manifest: OnceLock<kcoder_types::integrations::office::OfficeArtifactManifest>,
    materials: super::materials_ssh::FrozenSshMaterials,
    close: OnceLock<NativeRemoteControlFrameV1>,
}
impl AcceptedSshRemoteAuthority {
    pub fn capture(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        attempt: &TurnAttemptIdentity,
        caller: &ToolContext,
        admitted: (
            NativeRemoteRegistry,
            ConfiguredNativeSshPeer,
            RemoteDelegateInput,
            Arc<NativeRemoteHostClient>,
            &Mutex<Vec<NativeRemoteSourceTaskOwner>>,
        ),
    ) -> Result<Arc<Self>> {
        let (registry, mut selector, input, host_client, owners) = admitted;
        input.validate().map_err(anyhow::Error::msg)?;
        validate_caller(native, engine, attempt, caller, &input.prompt)?;
        let materials = super::materials_ssh::FrozenSshMaterials::capture(
            native,
            engine,
            attempt,
            caller,
            &input.materials,
        )?;
        ensure!(
            registry
                .configured_ssh_peer(&input.peer_id, &input.peer_revision)?
                .as_ref()
                == Some(&selector),
            "REMOTE_RUNNER_CONFIGURATION_CHANGED"
        );
        ensure!(
            input.maximum_seconds <= selector.maximum_duration_seconds,
            "REMOTE_NATIVE_DEADLINE_EXCEEDED"
        );
        selector
            .target
            .expected_native_sha256
            .make_ascii_lowercase();
        host_client.verify_owner()?;
        let budget = NativeRemoteSourceBudget::capture(native, engine, attempt, caller)?;
        budget.bind_goal_for_original_owner(owners)?;
        budget.require_delegation_policy()?;
        let source = budget.frozen_native_facts()?;
        let operation = format!(
            "remote-{}",
            super::launch::digest(&(
                IntegrationOwner::from(&source.scope),
                &source.attempt,
                &source.tool_call_id
            ))?
        );
        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_secs(u64::from(input.maximum_seconds));
        let frames = NativeRemoteSourceFrames::bind_original(
            host_client,
            budget.clone(),
            selector.target.clone(),
            &operation,
            deadline,
            caller
                .abort_token
                .as_ref()
                .map(CancellationToken::child_token)
                .unwrap_or_default(),
        )?;
        let formats = engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("REMOTE_NATIVE_SETTINGS_UNAVAILABLE"))?
            .integrations
            .office
            .allowed_formats
            .clone();
        let bind = NativeRemoteControlFrameV1 {
            version: NATIVE_REMOTE_CONTROL_VERSION,
            operation_id: operation.clone(),
            request_id: format!("native-bind-{operation}"),
            endpoint_revision: selector.target.target_revision.clone(),
            endpoint_instance_id: frames.endpoint_instance_id().into(),
            source_accepted_sha256: source.accepted_receipt_sha256,
            message: NativeRemoteControlDataV1::BindOriginal(NativeRemoteBindOriginalV1 {
                source_scope: source.scope,
                source_attempt: (&source.attempt).into(),
                frozen_input_sha256: format!("{:x}", Sha256::digest(input.prompt.as_bytes())),
                deadline_utc_ms: frames.deadline_utc_ms(),
                prompt: input.prompt.clone(),
                allowed_output_formats: formats,
                materials: materials.offers(),
            }),
        };
        bind.validate_shape().map_err(anyhow::Error::msg)?;
        let identity = json!({"kind":"native_ssh_acp","target":selector.target,"implementation":"kcoder","version":kcoder_cli_commands::build_identity::version()});
        let control = NativeRemoteSourceControl::bind_original(frames.clone())?;
        Ok(Arc::new(Self {
            native: native.recapture_for_owned_service()?,
            engine: engine.clone(),
            caller: caller.clone(),
            attempt: attempt.clone(),
            registry,
            selector,
            budget,
            frames,
            control,
            bind,
            bound: AtomicBool::new(false),
            prompt: input.prompt,
            session: Mutex::default(),
            deadline,
            identity,
            result_manifest: OnceLock::new(),
            materials,
            close: OnceLock::new(),
        }))
    }
    pub fn original_close(&self) -> Result<NativeRemoteControlFrameV1> {
        self.check_owned_native_close(&self.native)?;
        let request = NativeRemoteControlFrameV1 {
            request_id: format!("native-close-{}", self.operation()),
            message: NativeRemoteControlDataV1::CloseOriginal(self.control.observed_receiver()?),
            ..self.bind.clone()
        };
        request.validate_shape().map_err(anyhow::Error::msg)?;
        if let Some(original) = self.close.get() {
            ensure!(*original == request, "REMOTE_ORIGINAL_CLOSE_CHANGED");
            return Ok(original.clone());
        }
        self.close
            .set(request.clone())
            .map_err(|_| anyhow::anyhow!("REMOTE_ORIGINAL_CLOSE_CHANGED"))?;
        Ok(request)
    }
    pub fn frames(&self) -> Arc<NativeRemoteSourceFrames> {
        self.frames.clone()
    }
    pub fn original_bind(&self) -> &NativeRemoteControlFrameV1 {
        &self.bind
    }
    pub fn operation(&self) -> &str {
        &self.bind.operation_id
    }
    pub fn materials(&self) -> &super::materials_ssh::FrozenSshMaterials {
        &self.materials
    }
    pub fn observed_receiver(&self) -> Result<NativeRemoteAcceptedFactsV1> {
        self.control.observed_receiver()
    }
    pub fn bind_result_manifest(
        &self,
        manifest: &kcoder_types::integrations::office::OfficeArtifactManifest,
    ) -> Result<()> {
        self.check_owned_native_observation(&self.native)?;
        manifest.validate()?;
        let receiver = self.control.observed_receiver()?;
        let scope = receiver
            .receiver_scope
            .as_ref()
            .context("REMOTE_ENDPOINT_RECEIVER_SCOPE_REQUIRED")?;
        let settings = self
            .engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("REMOTE_NATIVE_SETTINGS_UNAVAILABLE"))?;
        ensure!(
            manifest.owner == IntegrationOwner::from(scope)
                && manifest.task.thread_id == receiver.identity.thread_id
                && manifest.task.turn_id == receiver.identity.turn_id
                && manifest.task.run_id.is_none()
                && settings.integrations.office.enabled
                && settings
                    .integrations
                    .office
                    .allowed_formats
                    .contains(&manifest.format)
                && manifest.bytes <= settings.integrations.office.max_output_bytes,
            "REMOTE_ENDPOINT_MANIFEST_OWNER_CHANGED"
        );
        if let Some(old) = self.result_manifest.get() {
            ensure!(old == manifest, "REMOTE_ENDPOINT_MANIFEST_CHANGED");
            return Ok(());
        }
        self.result_manifest
            .set(manifest.clone())
            .map_err(|_| anyhow::anyhow!("REMOTE_ENDPOINT_MANIFEST_CHANGED"))
    }
    pub fn read_request(
        &self,
        id: &str,
        message: NativeRemoteControlDataV1,
    ) -> Result<NativeRemoteControlFrameV1> {
        let mut request = self.bind.clone();
        request.request_id = id.into();
        request.message = message;
        request.validate_shape().map_err(anyhow::Error::msg)?;
        Ok(request)
    }
    pub fn read_reply(
        &self,
        request: &NativeRemoteControlFrameV1,
        reply: Value,
    ) -> Result<NativeRemoteReceiptDataV1> {
        self.check_owned_native_observation(&self.native)?;
        let reply: NativeRemoteControlReplyV1 = rpc_codec::decode(reply)?;
        ensure!(
            reply.version == NATIVE_REMOTE_CONTROL_VERSION
                && reply.operation_id == request.operation_id
                && reply.request_id == request.request_id
                && reply.endpoint_revision == request.endpoint_revision
                && reply.endpoint_instance_id == request.endpoint_instance_id
                && reply.state == NativeRemoteReceiptStateV1::Received,
            "REMOTE_ORIGINAL_READ_RECEIPT_CHANGED"
        );
        Ok(reply.data)
    }
    fn check(&self) -> Result<()> {
        ensure!(
            !self.frames.original_close_admitted(),
            "REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL"
        );
        self.native.verify()?;
        self.registry.check_current()?;
        self.budget.require_delegation_policy()?;
        validate_caller(
            &self.native,
            &self.engine,
            &self.attempt,
            &self.caller,
            &self.prompt,
        )?;
        ensure!(
            tokio::time::Instant::now() < self.deadline,
            "REMOTE_NATIVE_DEADLINE_EXPIRED"
        );
        Ok(())
    }
}
impl NativeRemoteAuthority for AcceptedSshRemoteAuthority {
    fn admit_owned_native_cancel(&self, session: &Value) -> Result<()> {
        self.check_owned_native_close(&self.native)?;
        let original = self
            .session
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_SESSION_UNAVAILABLE"))?;
        ensure!(
            original.as_deref() == session.as_str() && original.is_some(),
            "REMOTE_ORIGINAL_SESSION_CHANGED"
        );
        self.frames.admit_original_cancel(session)
    }

    fn handle_owned_native_settlement<'a>(
        &'a self,
        frame: &'a Value,
    ) -> kcoder_acp::outbound::OwnedNativeControlFuture<'a> {
        Box::pin(async move {
            self.native.verify()?;
            self.budget.verify_retained_observation_owner()?;
            self.frames.verify_retained_source()?;
            ensure!(
                self.bound.load(Ordering::Acquire),
                "REMOTE_ORIGINAL_BIND_REQUIRED"
            );
            let response = self.control.handle_dispatched_settlement_frame(frame)?;
            self.frames
                .admit_original_settlement_reply(&frame["id"], &response)?;
            Ok(Some(response))
        })
    }

    fn check_owned_native_close(&self, context: &NativeIntegrationContext) -> Result<()> {
        context.validate_scope(self.native.scope())?;
        self.native.verify()?;
        self.registry.check_current()?;
        self.budget.verify_retained_observation_owner()?;
        ensure!(
            self.bound.load(Ordering::Acquire),
            "REMOTE_ORIGINAL_BIND_REQUIRED"
        );
        self.frames.verify_owner()?;
        self.control.observed_receiver()?;
        Ok(())
    }
    fn verify_owned_native_close(&self, intent: &Value) -> Result<()> {
        let expected = self.original_close()?;
        ensure!(
            *intent == serde_json::to_value(&expected)?,
            "REMOTE_ORIGINAL_CLOSE_CHANGED"
        );
        Ok(())
    }
    fn admit_owned_native_close(&self, intent: &Value) -> Result<()> {
        let expected = self.original_close()?;
        ensure!(
            *intent == serde_json::to_value(&expected)?,
            "REMOTE_ORIGINAL_CLOSE_CHANGED"
        );
        self.frames.admit_original_close(&expected)
    }
    fn verify_owned_native_close_receipt(&self, receipt: &Value) -> Result<()> {
        self.check_owned_native_close(&self.native)?;
        let request = self.close.get().context("REMOTE_ORIGINAL_CLOSE_REQUIRED")?;
        let reply: NativeRemoteControlReplyV1 = rpc_codec::decode(receipt.clone())?;
        ensure!(
            reply.version == request.version
                && reply.operation_id == request.operation_id
                && reply.request_id == request.request_id
                && reply.endpoint_revision == request.endpoint_revision
                && reply.endpoint_instance_id == request.endpoint_instance_id
                && reply.state == NativeRemoteReceiptStateV1::Received,
            "REMOTE_OWNER_CLOSE_RECEIPT_REQUIRED"
        );
        ensure!(
            matches!(reply.data, NativeRemoteReceiptDataV1::OwnerClosed {
            accepted, backend_exited: true,
            owner_tree_cleanup_confirmed: true, ..
        } if accepted == self.control.observed_receiver()?),
            "REMOTE_OWNER_CLOSE_UNCONFIRMED"
        );
        Ok(())
    }
    fn observe_owned_native_close(&self, receipt: &Value) -> Result<()> {
        self.verify_owned_native_close_receipt(receipt)?;
        self.frames.observe_receiver_cleanup(true)
    }

    fn check_owned_native_control(&self, context: &NativeIntegrationContext) -> Result<()> {
        ensure!(
            !self.frames.original_close_admitted(),
            "REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL"
        );
        context.validate_scope(self.native.scope())?;
        self.native.verify()?;
        self.registry.check_current()?;
        self.budget.require_owned_transport_policy()?;
        super::authority::validate_captured_caller(
            &self.native,
            &self.engine,
            &self.attempt,
            &self.caller,
            &self.prompt,
        )?;
        ensure!(
            tokio::time::Instant::now() < self.deadline,
            "REMOTE_NATIVE_DEADLINE_EXPIRED"
        );
        self.frames.verify_owner()
    }
    fn verify_owned_native_material(&self, request: &Value) -> Result<()> {
        self.check()?;
        ensure!(
            self.bound.load(Ordering::Acquire),
            "REMOTE_ORIGINAL_BIND_REQUIRED"
        );
        let request: NativeRemoteControlFrameV1 = rpc_codec::decode(request.clone())?;
        request.validate_shape().map_err(anyhow::Error::msg)?;
        ensure!(
            request.operation_id == self.bind.operation_id
                && request.endpoint_instance_id == self.bind.endpoint_instance_id
                && request.endpoint_revision == self.bind.endpoint_revision
                && request.source_accepted_sha256 == self.bind.source_accepted_sha256,
            "REMOTE_MATERIAL_ORIGINAL_BIND_CHANGED"
        );
        self.materials.verify_write(
            &request,
            &self.caller.abort_token.clone().unwrap_or_default(),
        )
    }
    fn material_intent(&self) -> Result<Value> {
        Ok(json!({"materials":self.materials.offers()}))
    }
    fn material_receipt(&self) -> Result<Value> {
        ensure!(self.materials.all_finished()?, "REMOTE_MATERIAL_INCOMPLETE");
        Ok(
            json!({"materials":self.materials.offers(),"byteTransferComplete":true,"readerComplete":true,"businessCompleted":false}),
        )
    }
    fn check_owned_native_observation(&self, context: &NativeIntegrationContext) -> Result<()> {
        context.validate_scope(self.native.scope())?;
        self.native.verify()?;
        self.budget.verify_retained_observation_owner()?;
        self.frames.verify_retained_source()
    }
    fn verify_owned_native_read(&self, request: &Value) -> Result<()> {
        self.check_owned_native_observation(&self.native)?;
        ensure!(
            self.bound.load(Ordering::Acquire),
            "REMOTE_ORIGINAL_BIND_REQUIRED"
        );
        let request: NativeRemoteControlFrameV1 = rpc_codec::decode(request.clone())?;
        request.validate_shape().map_err(anyhow::Error::msg)?;
        ensure!(
            request.operation_id == self.bind.operation_id
                && request.endpoint_instance_id == self.bind.endpoint_instance_id
                && request.endpoint_revision == self.bind.endpoint_revision
                && request.source_accepted_sha256 == self.bind.source_accepted_sha256,
            "REMOTE_ORIGINAL_READ_CHANGED"
        );
        match request.message {
            NativeRemoteControlDataV1::ObserveOriginal => {}
            NativeRemoteControlDataV1::ReadArtifactManifest(receiver) => ensure!(
                receiver == self.control.observed_receiver()?,
                "REMOTE_CONTROL_ORIGINAL_RECEIVER_REQUIRED"
            ),
            NativeRemoteControlDataV1::ReadArtifactChunk(read) => {
                ensure!(
                    read.receiver_accepted == self.control.observed_receiver()?,
                    "REMOTE_CONTROL_ORIGINAL_RECEIVER_REQUIRED"
                );
                let manifest = self
                    .result_manifest
                    .get()
                    .context("REMOTE_ENDPOINT_MANIFEST_REQUIRED")?;
                ensure!(
                    read.artifact.id == manifest.id
                        && read.artifact.revision == manifest.revision
                        && read.manifest_sha256 == super::launch::digest(manifest)?
                        && read.offset < manifest.bytes,
                    "REMOTE_ENDPOINT_MANIFEST_CHANGED"
                );
            }
            _ => anyhow::bail!("REMOTE_NATIVE_READ_ONLY_REQUIRED"),
        }
        Ok(())
    }
    fn owned_endpoint_instance_id(&self) -> Option<&str> {
        Some(self.frames.endpoint_instance_id())
    }
    fn original_attempt(&self) -> &TurnAttemptIdentity {
        &self.attempt
    }
    fn verify_original_tool(
        &self,
        engine_state: &kcoder_state::AppState,
        tool_state: &kcoder_state::AppState,
        tool_call_id: Option<&str>,
        _is_aborted: &dyn Fn() -> bool,
    ) -> Result<()> {
        self.check()?;
        ensure!(
            self.engine
                .state
                .inspection_identity()
                .matches(engine_state)
                && self.engine.state.inspection_identity().matches(tool_state)
                && self.caller.tool_call_id.as_deref() == tool_call_id,
            "REMOTE_NATIVE_CALL_OWNER_CHANGED"
        );
        Ok(())
    }
    fn check_current(&self, context: &NativeIntegrationContext) -> Result<()> {
        context.validate_scope(self.native.scope())?;
        self.check()
    }
    fn verify_runner(
        &self,
        _: &NativeIntegrationContext,
        _: &InstalledOutboundRunner,
    ) -> Result<()> {
        anyhow::bail!("REMOTE_SSH_LOCAL_RUNNER_UNAVAILABLE")
    }
    fn verify_owned_frame_transport(&self, actual: &dyn OwnedNativeFrameTransport) -> Result<()> {
        self.check()?;
        ensure!(
            // Trait-object vtables may be duplicated across codegen units.
            // The retained concrete allocation is the identity, not its vtable.
            std::ptr::addr_eq(
                actual,
                self.frames.as_ref() as &dyn OwnedNativeFrameTransport
            ),
            "REMOTE_ORIGINAL_TRANSPORT_CHANGED"
        );
        self.frames.verify_owner()
    }
    fn verify_owned_native_bind(&self, intent: &Value) -> Result<()> {
        self.check()?;
        ensure!(
            !self.bound.load(Ordering::Acquire) && *intent == serde_json::to_value(&self.bind)?,
            "REMOTE_ORIGINAL_BIND_CHANGED"
        );
        Ok(())
    }
    fn verify_owned_native_bind_receipt(&self, receipt: &Value) -> Result<()> {
        let expected = &self.bind;
        let NativeRemoteControlDataV1::BindOriginal(bind) = &expected.message else {
            anyhow::bail!("REMOTE_ORIGINAL_BIND_CHANGED")
        };
        let receipt: NativeRemoteControlReplyV1 = rpc_codec::decode(receipt.clone())?;
        ensure!(
            receipt.version == NATIVE_REMOTE_CONTROL_VERSION
                && receipt.operation_id == expected.operation_id
                && receipt.request_id == expected.request_id
                && receipt.endpoint_revision == expected.endpoint_revision
                && receipt.endpoint_instance_id == expected.endpoint_instance_id
                && receipt.state == NativeRemoteReceiptStateV1::Received
                && matches!(&receipt.data, NativeRemoteReceiptDataV1::OriginalBound { frozen_input_sha256, receiver_settings_sha256 }
                if frozen_input_sha256 == &bind.frozen_input_sha256 && receiver_settings_sha256.len() == 64
                    && receiver_settings_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())),
            "REMOTE_ORIGINAL_BIND_RECEIPT_REQUIRED"
        );
        Ok(())
    }
    fn observe_owned_native_bind(&self, receipt: &Value) -> Result<()> {
        self.verify_owned_native_bind_receipt(receipt)?;
        self.control.bind_receiver_settings(
            receipt["data"]["receiverSettingsSha256"]
                .as_str()
                .context("REMOTE_CONTROL_RECEIVER_SETTINGS_REQUIRED")?,
        )?;
        self.bound.store(true, Ordering::Release);
        Ok(())
    }
    fn handle_owned_native_control<'a>(
        &'a self,
        frame: &'a Value,
    ) -> kcoder_acp::outbound::OwnedNativeControlFuture<'a> {
        Box::pin(async move {
            let request: NativeRemoteControlFrameV1 = rpc_codec::decode(frame["params"].clone())?;
            if matches!(
                request.message,
                NativeRemoteControlDataV1::ReserveModel(_)
                    | NativeRemoteControlDataV1::DispatchModel(_)
            ) {
                self.check_owned_native_control(&self.native)?;
            } else {
                self.check_owned_native_observation(&self.native)?;
            }
            ensure!(
                self.bound.load(Ordering::Acquire),
                "REMOTE_ORIGINAL_BIND_REQUIRED"
            );

            if let NativeRemoteControlDataV1::ReceiverAccepted(accepted) = &request.message {
                accepted
                    .receiver_scope
                    .as_ref()
                    .context("REMOTE_ENDPOINT_RECEIVER_SCOPE_REQUIRED")?
                    .validate()?;
            }
            self.control.handle_owned_frame(frame).map(Some)
        })
    }
    fn check_frozen_intent(&self, stage: OutboundEffect, actual: &Value) -> Result<()> {
        self.check()?;
        match stage {
            OutboundEffect::Spawn => ensure!(
                *actual
                    == json!({"expectedName":"kcoder","expectedVersion":kcoder_cli_commands::build_identity::version()}),
                "REMOTE_FROZEN_INTENT_CHANGED"
            ),
            OutboundEffect::Initialize => ensure!(
                actual["protocolVersion"] == 1,
                "REMOTE_FROZEN_INTENT_CHANGED"
            ),
            OutboundEffect::Session => {
                ensure!(
                    self.bound.load(Ordering::Acquire),
                    "REMOTE_ORIGINAL_BIND_REQUIRED"
                );
                ensure!(self.materials.all_finished()?, "REMOTE_MATERIAL_INCOMPLETE");
                let workspace = self
                    .frames
                    .receiver_workspace()?
                    .context("REMOTE_HOST_RECEIVER_WORKSPACE_REQUIRED")?;
                ensure!(
                    actual["cwd"].as_str() == workspace.to_str()
                        && actual
                            .get("mcpServers")
                            .is_none_or(|value| value.as_array().is_some_and(Vec::is_empty)),
                    "REMOTE_FROZEN_INTENT_CHANGED"
                );
            }
            OutboundEffect::Prompt => ensure!(
                self.bound.load(Ordering::Acquire)
                    && actual["prompt"] == json!([{"type":"text","text":self.prompt}])
                    && self
                        .session
                        .lock()
                        .map_err(|_| anyhow::anyhow!("REMOTE_SESSION_UNAVAILABLE"))?
                        .as_deref()
                        == actual["sessionId"].as_str(),
                "REMOTE_FROZEN_INTENT_CHANGED"
            ),
        }
        Ok(())
    }
    fn observe_receipt(&self, stage: OutboundEffect, safe: &Value) -> Result<()> {
        if stage == OutboundEffect::Session {
            let id = safe["sessionId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .context("REMOTE_SESSION_ID_REQUIRED")?;
            let mut session = self
                .session
                .lock()
                .map_err(|_| anyhow::anyhow!("REMOTE_SESSION_UNAVAILABLE"))?;
            ensure!(
                session.as_deref().is_none_or(|original| original == id),
                "REMOTE_SESSION_CHANGED"
            );
            *session = Some(id.into());
        }
        Ok(())
    }
    fn recipient_revision(&self) -> &str {
        &self.selector.target.target_revision
    }
    fn recipient_identity(&self) -> &Value {
        &self.identity
    }
    fn deadline(&self) -> tokio::time::Instant {
        self.deadline
    }
}
