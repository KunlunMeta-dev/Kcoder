//! Actual public-call provenance is distinct from SDK member authorization.
use super::super::core::NativeIntegrationContext;
use crate::app_server::ConnectionState;
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::integrations::connectivity::ConnectivityPortCall;
use kcoder_types::integrations::core::*;
use serde_json::{Value, json};
use std::sync::{Arc, Weak};
use tokio_util::sync::CancellationToken;

pub(crate) struct NativeConnectivityPublicCall {
    context: NativeIntegrationContext,
    call: ConnectivityPortCall,
    owner: Weak<()>,
    ended: CancellationToken,
    expires: std::time::Instant,
    identity_revision: u64,
}

/// Retained native owner consent, not a serialized or cached policy decision.
/// Every use must still verify the current source, credential and physical owner.
pub(super) struct NativeConnectivityManagementOwner {
    context: NativeIntegrationContext,
    owner: Weak<()>,
    ended: CancellationToken,
    identity_revision: u64,
}
impl NativeConnectivityManagementOwner {
    pub(super) fn client_cancellation(&self) -> CancellationToken {
        self.ended.clone()
    }
    /// Verify first-party control of a task on the current app-server.
    pub(super) fn initialized_task_ui_context(
        state: &ConnectionState,
    ) -> Result<&NativeIntegrationContext> {
        ensure!(
            state.initialized
                && state.integration_task_capability_scope_v1
                && state.interaction_binding_v1
                && !state.native_source_dispatch
                && state.native_source_accepted.is_none()
                && state.native_runtime_thread_initializer.is_none()
                && !state.input_ended.is_cancelled(),
            "TASK_UI_NATIVE_SOURCE_REQUIRED"
        );
        let native = state
            .integration_context
            .as_ref()
            .context("TASK_UI_SCOPE_REQUIRED")?;
        native.verify()?;
        ensure!(
            native.scope().organization_id.is_none(),
            "TASK_UI_ORGANIZATION_UNAVAILABLE"
        );
        Ok(native)
    }

    /// Capture a task owner that can hand control to the original app-server.
    pub(super) fn from_initialized_task_ui(state: &ConnectionState) -> Result<Self> {
        ensure!(
            state.thread_runtime_handoff_v1,
            "TASK_UI_NATIVE_SOURCE_REQUIRED"
        );
        Self::from_initialized_task_client(state)
    }

    pub(super) fn from_initialized_task_client(state: &ConnectionState) -> Result<Self> {
        let native = Self::initialized_task_ui_context(state)?;
        Ok(Self {
            context: native.recapture_for_owned_service()?,
            owner: Arc::downgrade(&state.source_management_owner),
            ended: state.input_ended.clone(),
            identity_revision: native.source_authority_epoch()?.1,
        })
    }

    pub(super) fn verify(&self, context: &NativeIntegrationContext) -> Result<()> {
        ensure!(
            self.owner.upgrade().is_some() && !self.ended.is_cancelled(),
            "CHANNEL_MANAGEMENT_OWNER_ENDED"
        );
        context.validate_scope(self.context.scope())?;
        // source_authority_epoch() performs the complete context verification.
        ensure!(
            self.context.source_authority_epoch()?.1 == self.identity_revision,
            "CHANNEL_MANAGEMENT_OWNER_CHANGED"
        );
        Ok(())
    }
}
impl NativeConnectivityPublicCall {
    /// Binds a private transport to this real UI stream. It grants no operation
    /// or background lifetime; subsequent calls still capture their own intent.
    pub(super) fn retain_ui_peer_owner(
        &self,
        state: &ConnectionState,
    ) -> Result<NativeConnectivityManagementOwner> {
        self.verify(self.context.scope())?;
        ensure!(
            state.initialized
                && !state.native_source_dispatch
                && state.native_source_accepted.is_none()
                && self
                    .owner
                    .ptr_eq(&Arc::downgrade(&state.source_management_owner)),
            "CHANNEL_PEER_ORIGINAL_UI_REQUIRED"
        );
        Ok(NativeConnectivityManagementOwner {
            context: self.context.recapture_for_owned_service()?,
            owner: self.owner.clone(),
            ended: self.ended.clone(),
            identity_revision: self.identity_revision,
        })
    }
    pub(super) fn retain_application_task_owner(
        &self,
    ) -> Result<NativeConnectivityManagementOwner> {
        self.verify(self.context.scope())?;
        ensure!(self.call.method == kcoder_app_protocol::integrations::connectivity::ConnectivityMethod::PrepareConnectionAction
            && self.call.request.payload.get("action").and_then(Value::as_str) == Some("runOfficeTask"),
            "APPLICATION_ORIGINAL_PUBLIC_TASK_REQUIRED");
        Ok(NativeConnectivityManagementOwner {
            context: self.context.recapture_for_owned_service()?,
            owner: self.owner.clone(),
            ended: self.ended.clone(),
            identity_revision: self.identity_revision,
        })
    }
    pub(super) fn retain_channel_management_owner(
        &self,
    ) -> Result<NativeConnectivityManagementOwner> {
        self.verify(self.context.scope())?;
        ensure!(self.call.port==kcoder_app_protocol::integrations::connectivity::ConnectivityPort::Connection
            && self.call.method==kcoder_app_protocol::integrations::connectivity::ConnectivityMethod::PrepareConnectionAction
            && matches!(self.call.request.payload.get("action").and_then(Value::as_str),Some("start"|"takeoverBot")),
            "CHANNEL_ORIGINAL_START_REQUIRED");
        Ok(NativeConnectivityManagementOwner {
            context: self.context.recapture_for_owned_service()?,
            owner: self.owner.clone(),
            ended: self.ended.clone(),
            identity_revision: self.identity_revision,
        })
    }
    /// Only the finite authenticated public dispatcher owns ConnectionState.
    /// A private Main/SDK callback has no constructor for this request owner.
    pub(in crate::app_server) fn capture(
        state: &ConnectionState,
        call: ConnectivityPortCall,
    ) -> Result<Arc<Self>> {
        call.validate()?;
        ensure!(
            state.initialized
                && !state.native_source_dispatch
                && state.native_source_accepted.is_none()
                && !state.input_ended.is_cancelled(),
            "CONNECTIVITY_PUBLIC_CALLER_REQUIRED"
        );
        let context = state
            .integration_context
            .as_ref()
            .context("CONNECTIVITY_NATIVE_SCOPE_REQUIRED")?
            .recapture_for_owned_service()?;
        context.validate_scope(&call.request.scope)?;
        ensure!(
            context.scope().organization_id.is_none(),
            "CONNECTIVITY_ORGANIZATION_POLICY_REQUIRED"
        );
        let (_, revision) = context.source_authority_epoch()?;
        let result = Arc::new(Self {
            context,
            owner: Arc::downgrade(&state.source_management_owner),
            ended: state.input_ended.clone(),
            expires: std::time::Instant::now()
                + std::time::Duration::from_millis(call.request.timeout_ms),
            call,
            identity_revision: revision,
        });
        result.verify(result.context.scope())?;
        Ok(result)
    }
    pub(crate) fn call(&self) -> &ConnectivityPortCall {
        &self.call
    }
    pub(crate) fn context(&self) -> &NativeIntegrationContext {
        &self.context
    }
    pub(crate) fn remaining(&self) -> Result<std::time::Duration> {
        self.verify(self.context.scope())?;
        Ok(self
            .expires
            .saturating_duration_since(std::time::Instant::now()))
    }
    pub(crate) fn cancellation(&self) -> CancellationToken {
        self.ended.child_token()
    }
    pub(crate) fn initialize_operation(&self) -> Result<&str> {
        self.verify(self.context.scope())?;
        ensure!(self.call.method == kcoder_app_protocol::integrations::connectivity::ConnectivityMethod::PrepareConnectionAction
            && self.call.request.payload.get("action").and_then(Value::as_str) == Some("save"),
            "CONNECTIVITY_EXPLICIT_CONFIGURATION_REQUIRED");
        self.call
            .request
            .operation_id
            .as_deref()
            .context("CONNECTIVITY_OPERATION_REQUIRED")
    }
    pub(crate) fn verify(&self, scope: &IntegrationScope) -> Result<()> {
        ensure!(
            self.owner.upgrade().is_some()
                && !self.ended.is_cancelled()
                && std::time::Instant::now() < self.expires,
            "CONNECTIVITY_PUBLIC_CALLER_EXPIRED"
        );
        self.context.validate_scope(scope)?;
        ensure!(
            self.context.source_authority_epoch()?.1 == self.identity_revision,
            "CONNECTIVITY_PUBLIC_CALLER_CHANGED"
        );
        Ok(())
    }
    /// This authorizes exactly one public management method/body. It supplies no
    /// channel.connect/maintain, Runtime, tool, delivery or signed member grant.
    pub(crate) fn authorize_top_level(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
    ) -> Result<Option<Value>> {
        self.verify(context.scope())?;
        context.validate_scope(&request.scope)?;
        request.validate_method(IntegrationPort::Policy, "evaluateAction")?;
        let method = serde_json::to_value(self.call.method)?
            .as_str()
            .context("CONNECTIVITY_METHOD_INVALID")?
            .to_owned();
        let expected = json!({"action":format!("connectivity.{method}"),
            "resource":{"port":self.call.port,"payload":self.call.request.payload}});
        if Value::Object(request.payload.clone()) != expected
            || request.operation_id != self.call.request.operation_id
        {
            return Ok(None);
        }
        Ok(Some(
            json!({"decision":"allow","policyRevision":format!("native-public-{}",self.identity_revision),
            "reasonCode":"EXACT_NATIVE_PUBLIC_CONTROL_REQUEST"}),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::integrations::core::runtime_driver::test_support::Fixture;
    use kcoder_app_protocol::integrations::connectivity::{ConnectivityMethod, ConnectivityPort};

    #[test]
    fn task_ui_owner_requires_actual_source_capabilities_and_lifetime() -> Result<()> {
        let fixture = Fixture::new();
        let mut state = ConnectionState {
            integration_context: Some(fixture.context),
            ..Default::default()
        };
        assert!(NativeConnectivityManagementOwner::from_initialized_task_ui(&state).is_err());
        state.initialized = true;
        state.integration_task_capability_scope_v1 = true;
        assert!(NativeConnectivityManagementOwner::initialized_task_ui_context(&state).is_err());
        state.interaction_binding_v1 = true;
        NativeConnectivityManagementOwner::initialized_task_ui_context(&state)?;
        NativeConnectivityManagementOwner::from_initialized_task_client(&state)?;
        assert!(NativeConnectivityManagementOwner::from_initialized_task_ui(&state).is_err());
        state.thread_runtime_handoff_v1 = true;
        let owner = NativeConnectivityManagementOwner::from_initialized_task_ui(&state)?;
        owner.verify(state.integration_context.as_ref().unwrap())?;
        state.native_source_dispatch = true;
        assert!(NativeConnectivityManagementOwner::initialized_task_ui_context(&state).is_err());
        assert!(NativeConnectivityManagementOwner::from_initialized_task_ui(&state).is_err());
        state.input_ended.cancel();
        assert!(
            owner
                .verify(state.integration_context.as_ref().unwrap())
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn retained_lifecycle_owner_requires_original_start_and_ends_with_native_owner() -> Result<()> {
        let fixture = Fixture::new();
        let call = request(&fixture.context);
        let state = ConnectionState {
            initialized: true,
            integration_context: Some(fixture.context),
            ..Default::default()
        };
        let captured = NativeConnectivityPublicCall::capture(&state, call.clone())?;
        assert!(captured.retain_channel_management_owner().is_err());
        let mut start = call;
        start.port = ConnectivityPort::Connection;
        start.method = ConnectivityMethod::PrepareConnectionAction;
        start.request.operation_id = Some("original-native-start".into());
        start.request.expected_revision = Some("1".into());
        start.request.payload = json!({"action":"start","connectionId":"original-native-channel"})
            .as_object()
            .unwrap()
            .clone();
        let captured = NativeConnectivityPublicCall::capture(&state, start)?;
        let owner = captured.retain_channel_management_owner()?;
        owner.verify(captured.context())?;
        state.input_ended.cancel();
        assert!(owner.verify(captured.context()).is_err());
        Ok(())
    }

    fn request(context: &NativeIntegrationContext) -> ConnectivityPortCall {
        ConnectivityPortCall {
            port: ConnectivityPort::Connection,
            method: ConnectivityMethod::ListConnections,
            request: IntegrationRequest {
                contract_version: IntegrationContractVersion::ParallelV1,
                request_id: "exact-native-main-list".into(),
                scope: context.scope().clone(),
                operation_id: None,
                expected_revision: None,
                timeout_ms: 1_000,
                cancellation_ref: None,
                payload: json!({"category":"channels","limit":10})
                    .as_object()
                    .unwrap()
                    .clone(),
            },
        }
    }
    #[test]
    fn uninitialized_connection_cannot_create_a_public_request_owner() {
        let fixture = Fixture::new();
        let call = request(&fixture.context);
        let state = ConnectionState {
            integration_context: Some(fixture.context),
            ..Default::default()
        };
        assert_eq!(
            NativeConnectivityPublicCall::capture(&state, call)
                .err()
                .unwrap()
                .to_string(),
            "CONNECTIVITY_PUBLIC_CALLER_REQUIRED"
        );
    }

    #[test]
    fn native_public_main_request_never_accepts_an_internal_origin() {
        let fixture = Fixture::new();
        let call = request(&fixture.context);
        let state = ConnectionState {
            initialized: true,
            integration_context: Some(fixture.context),
            native_source_dispatch: true,
            ..Default::default()
        };
        assert!(NativeConnectivityPublicCall::capture(&state, call).is_err());
    }
    #[test]
    fn native_public_main_owner_is_weak_and_cancellation_revokes_only_that_call() -> Result<()> {
        for drop_connection in [false, true] {
            let fixture = Fixture::new();
            let call = request(&fixture.context);
            let state = ConnectionState {
                initialized: true,
                integration_context: Some(fixture.context),
                ..Default::default()
            };
            let captured = NativeConnectivityPublicCall::capture(&state, call)?;
            if drop_connection {
                drop(state);
            } else {
                state.input_ended.cancel();
            }
            assert!(captured.verify(captured.context.scope()).is_err());
        }
        Ok(())
    }
    #[test]
    fn exact_public_control_body_never_grants_sdk_runtime_or_connection_lifecycle() -> Result<()> {
        let fixture = Fixture::new();
        let call = request(&fixture.context);
        let state = ConnectionState {
            initialized: true,
            integration_context: Some(fixture.context),
            ..Default::default()
        };
        let captured = NativeConnectivityPublicCall::capture(&state, call.clone())?;
        let mut policy_request = call.request;
        policy_request.payload = json!({"action":"connectivity.listConnections",
            "resource":{"port":"P-CONNECTION","payload":{"category":"channels","limit":10}}})
        .as_object()
        .unwrap()
        .clone();
        assert!(
            captured
                .authorize_top_level(&captured.context, &policy_request)?
                .is_some()
        );
        for action in [
            "channel.connect",
            "channel.maintain",
            "channel.acceptTask",
            "delivery.send",
        ] {
            policy_request
                .payload
                .insert("action".into(), json!(action));
            assert!(
                captured
                    .authorize_top_level(&captured.context, &policy_request)?
                    .is_none()
            );
        }
        Ok(())
    }
}
