//! A single public control-plane intent, not a grant reconstructed from JSON scope.
use super::NativeIntegrationContext;
use crate::app_server::{ConnectionState, SessionLease};
use anyhow::{Context, Result, ensure};
use kcoder_engine::QueryEngine;
use kcoder_types::integrations::core::*;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Weak};
use tokio_util::sync::CancellationToken;

/// The actual inbound connection owns the only strong owner token. A private
/// SDK callback has neither ConnectionState nor a public-control owner token.
/// Keeping this request permit cannot extend a disconnected caller's authority.
pub(crate) struct NativeTaskCapabilityScopeManagementPermit {
    owner: Weak<()>,
    ended: CancellationToken,
    native: NativeIntegrationContext,
    lease: crate::app_server::workspace_registry::NativeSessionLeaseWitness,
    native_target: std::path::PathBuf,
    state: kcoder_state::AppStateLifecycleIdentity,
    engine: QueryEngine,
    operation: String,
    task_key: String,
    selection_sha256: String,
    request_payload_sha256: String,
    resource_bindings_sha256: Option<String>,
    expires: std::time::Instant,
}
impl NativeTaskCapabilityScopeManagementPermit {
    /// Invoke only in the finite public source-selection handler, after the
    /// original task is resolved on this connection's actual native target.
    /// This is never a private Port or model-tool constructor.
    pub(in crate::app_server) fn from_public_control(
        state: &ConnectionState,
        engine: &QueryEngine,
        lease: &SessionLease,
        request: &IntegrationRequest,
        actual_task_key: &str,
        selection: &IntegrationTaskCapabilityScopeSelection,
    ) -> Result<Arc<Self>> {
        request.validate(true)?;
        selection.validate()?;
        let native = state
            .integration_context
            .as_ref()
            .context("TASK_CAPABILITY_SCOPE_NATIVE_CALLER_UNAVAILABLE")?
            .recapture_for_owned_service()?;
        native.validate_scope(&request.scope)?;
        ensure!(
            native.scope().organization_id.is_none(),
            "TASK_CAPABILITY_SCOPE_ORGANIZATION_POLICY_REQUIRED"
        );
        ensure!(
            lease.matches_target(&engine.session_lease_target()),
            "TASK_CAPABILITY_SCOPE_NATIVE_CALLER_CHANGED"
        );
        let witness = lease.native_witness()?;
        let native_target = engine.session_lease_target();
        witness.verify_target(&native_target)?;
        ensure!(
            !state.input_ended.is_cancelled()
                && !actual_task_key.is_empty()
                && actual_task_key.len() <= 256,
            "TASK_CAPABILITY_SCOPE_NATIVE_CALLER_CHANGED"
        );
        let permit = Arc::new(Self {
            owner: Arc::downgrade(&state.source_management_owner),
            ended: state.input_ended.clone(),
            native,
            lease: witness,
            native_target,
            state: engine.state.inspection_lifecycle_identity(),
            engine: engine.clone(),
            operation: request
                .operation_id
                .clone()
                .context("TASK_CAPABILITY_SCOPE_OPERATION_REQUIRED")?,
            task_key: actual_task_key.into(),
            selection_sha256: selection_digest(selection)?,
            request_payload_sha256: format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&request.payload)?)
            ),
            resource_bindings_sha256: request
                .payload
                .get("params")
                .and_then(|params| params.get("resourceBindings"))
                .filter(|bindings| !bindings.is_null())
                .map(|bindings| {
                    // The original request still has its separate exact payload hash.
                    // Match resource intent using the same typed representation as verification.
                    let typed: Vec<IntegrationTaskResourceBinding> =
                        serde_json::from_value(bindings.clone())?;
                    Ok::<_, anyhow::Error>(format!(
                        "{:x}",
                        Sha256::digest(serde_json::to_vec(&typed)?)
                    ))
                })
                .transpose()?,
            expires: std::time::Instant::now()
                + std::time::Duration::from_millis(request.timeout_ms),
        });
        permit.verify(
            &request.scope,
            actual_task_key,
            request.operation_id.as_deref().unwrap(),
            selection,
        )?;
        Ok(permit)
    }
    pub(crate) fn verify_resource_intent(
        &self,
        scope: &IntegrationScope,
        task: &str,
        operation: &str,
        bindings: &[IntegrationTaskResourceBinding],
    ) -> Result<()> {
        self.native.validate_scope(scope)?;
        ensure!(
            self.owner.upgrade().is_some()
                && !self.ended.is_cancelled()
                && std::time::Instant::now() < self.expires
                && task == self.task_key
                && operation == self.operation
                && self.state.matches(&self.engine.state)
                && self.resource_bindings_sha256.as_deref()
                    == Some(
                        format!("{:x}", Sha256::digest(serde_json::to_vec(bindings)?)).as_str()
                    ),
            "TASK_RESOURCE_NATIVE_CONTROL_INTENT_CHANGED"
        );
        self.lease.verify_target(&self.native_target)
    }
    pub(crate) fn verify_resource_request(&self, request: &IntegrationRequest) -> Result<()> {
        self.native.validate_scope(&request.scope)?;
        ensure!(
            self.owner.upgrade().is_some()
                && !self.ended.is_cancelled()
                && std::time::Instant::now() < self.expires
                && request.operation_id.as_deref() == Some(self.operation.as_str())
                && format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&request.payload)?)
                ) == self.request_payload_sha256,
            "TASK_RESOURCE_NATIVE_CONTROL_INTENT_CHANGED"
        );
        self.lease.verify_target(&self.native_target)
    }
    pub(crate) fn verify(
        &self,
        scope: &IntegrationScope,
        actual_task_key: &str,
        operation: &str,
        selection: &IntegrationTaskCapabilityScopeSelection,
    ) -> Result<()> {
        ensure!(
            self.owner.upgrade().is_some()
                && !self.ended.is_cancelled()
                && std::time::Instant::now() < self.expires,
            "TASK_CAPABILITY_SCOPE_NATIVE_CALLER_EXPIRED"
        );
        self.native.validate_scope(scope)?;
        self.lease.verify_target(&self.native_target)?;
        ensure!(
            self.state.matches(&self.engine.state)
                && self.engine.session_lease_target() == self.native_target
                && self.task_key == actual_task_key
                && self.operation == operation
                && self.selection_sha256 == selection_digest(selection)?,
            "TASK_CAPABILITY_SCOPE_NATIVE_CONTROL_INTENT_CHANGED"
        );
        ensure!(
            self.owner.upgrade().is_some() && !self.ended.is_cancelled(),
            "TASK_CAPABILITY_SCOPE_NATIVE_CALLER_EXPIRED"
        );
        Ok(())
    }
}

fn selection_digest(selection: &IntegrationTaskCapabilityScopeSelection) -> Result<String> {
    selection.validate()?;
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(selection)?)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::integrations::core::runtime_driver::test_support::{
        Fixture, resident, shutdown,
    };
    use serde_json::json;

    #[tokio::test]
    async fn original_resource_intent_ignores_json_field_order_but_keeps_exact_owner_and_payload() {
        let fixture = Fixture::new();
        let (manager, engine) = resident(&fixture).await;
        let state = ConnectionState {
            integration_context: Some(fixture.context.recapture_for_owned_service().unwrap()),
            ..Default::default()
        };
        let selection: IntegrationTaskCapabilityScopeSelection =
            serde_json::from_value(serde_json::json!({"mode":"inherit_current","sources":[]}))
                .unwrap();
        let raw = serde_json::json!([{"source":{"sourceRef":{"id":"actual-source","revision":"actual-security"},"accountRef":null},"connectionRef":{"id":"application","revision":"3"},"resourceRefs":[{"id":"actual-resource","kind":"document","revision":"1"}]}]);
        let typed: Vec<IntegrationTaskResourceBinding> =
            serde_json::from_value(raw.clone()).unwrap();
        let mut request = fixture.request("resource-field-order");
        request.payload = serde_json::json!({"params":{"resourceBindings":raw}})
            .as_object()
            .unwrap()
            .clone();
        let permit = NativeTaskCapabilityScopeManagementPermit::from_public_control(
            &state,
            &engine,
            manager.lease(&engine.session_id()).unwrap(),
            &request,
            "actual-root-task",
            &selection,
        )
        .unwrap();
        permit
            .verify_resource_intent(
                &request.scope,
                "actual-root-task",
                "resource-field-order",
                &typed,
            )
            .unwrap();
        permit.verify_resource_request(&request).unwrap();
        let mut different = typed.clone();
        different[0].resource_refs[0].revision = "different".into();
        assert!(
            permit
                .verify_resource_intent(
                    &request.scope,
                    "actual-root-task",
                    "resource-field-order",
                    &different
                )
                .is_err()
        );
        let mut changed = request.clone();
        changed.payload.insert("extra".into(), true.into());
        assert!(permit.verify_resource_request(&changed).is_err());
        state.input_ended.cancel();
        assert!(
            permit
                .verify_resource_intent(
                    &request.scope,
                    "actual-root-task",
                    "resource-field-order",
                    &typed
                )
                .is_err()
        );
        shutdown(manager).await;
    }

    #[tokio::test]
    async fn public_control_intent_is_exact_revocable_and_cannot_borrow_another_native_lease() {
        let fixture = Fixture::new();
        let (manager, engine) = resident(&fixture).await;
        let state = ConnectionState {
            integration_context: Some(fixture.context.recapture_for_owned_service().unwrap()),
            ..Default::default()
        };
        let selection: IntegrationTaskCapabilityScopeSelection =
            serde_json::from_value(json!({"mode":"none","sources":[]})).unwrap();
        let mut request = fixture.request("explicit-source-selection");
        request.payload = json!({"threadId":engine.session_id(),"selection":selection})
            .as_object()
            .unwrap()
            .clone();
        let lease = manager.lease(&engine.session_id()).unwrap();
        let permit = NativeTaskCapabilityScopeManagementPermit::from_public_control(
            &state,
            &engine,
            lease,
            &request,
            "actual-root-task",
            &selection,
        )
        .unwrap();
        permit
            .verify(
                &request.scope,
                "actual-root-task",
                "explicit-source-selection",
                &selection,
            )
            .unwrap();
        assert!(
            permit
                .verify(
                    &request.scope,
                    "another-task",
                    "explicit-source-selection",
                    &selection
                )
                .is_err()
        );
        assert!(
            permit
                .verify(
                    &request.scope,
                    "actual-root-task",
                    "another-operation",
                    &selection
                )
                .is_err()
        );
        let other:IntegrationTaskCapabilityScopeSelection=serde_json::from_value(json!({"mode":"selected","sources":[{"sourceRef":{"id":"unrelated-source","revision":"1"},"accountRef":null}]})).unwrap();
        assert!(
            permit
                .verify(
                    &request.scope,
                    "actual-root-task",
                    "explicit-source-selection",
                    &other
                )
                .is_err()
        );
        state.input_ended.cancel();
        assert!(
            permit
                .verify(
                    &request.scope,
                    "actual-root-task",
                    "explicit-source-selection",
                    &selection
                )
                .is_err()
        );
        shutdown(manager).await;
    }

    #[tokio::test]
    async fn user_permit_cannot_survive_native_state_epoch_or_connection_owner_drop() {
        let fixture = Fixture::new();
        let (manager, engine) = resident(&fixture).await;
        let state = ConnectionState {
            integration_context: Some(fixture.context.recapture_for_owned_service().unwrap()),
            ..Default::default()
        };
        let selection: IntegrationTaskCapabilityScopeSelection =
            serde_json::from_value(json!({"mode":"none","sources":[]})).unwrap();
        let request = fixture.request("actual-source-change");
        let permit = NativeTaskCapabilityScopeManagementPermit::from_public_control(
            &state,
            &engine,
            manager.lease(&engine.session_id()).unwrap(),
            &request,
            "task",
            &selection,
        )
        .unwrap();
        drop(state);
        assert!(
            permit
                .verify(&request.scope, "task", "actual-source-change", &selection)
                .is_err()
        );
        let state = ConnectionState {
            integration_context: Some(fixture.context.recapture_for_owned_service().unwrap()),
            ..Default::default()
        };
        let permit = NativeTaskCapabilityScopeManagementPermit::from_public_control(
            &state,
            &engine,
            manager.lease(&engine.session_id()).unwrap(),
            &request,
            "task",
            &selection,
        )
        .unwrap();
        let history = engine.state.history_path().unwrap();
        engine.state.add_message(kcoder_types::Message::user_text(
            "Owned history for epoch replacement",
        ));
        engine.state.flush_history().await.unwrap();
        engine.state.resume_from_history(&history).unwrap();
        assert!(
            permit
                .verify(&request.scope, "task", "actual-source-change", &selection)
                .is_err()
        );
        shutdown(manager).await;
    }
}
