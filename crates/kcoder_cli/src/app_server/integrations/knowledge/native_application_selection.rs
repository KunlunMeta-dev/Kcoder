//! Exact public resource-read consent, independent of MCP registration and task execution.
use super::rpc::configuration::EngineSnapshot;
use crate::app_server::{
    AppServerEngineFactory, ConnectionState,
    integrations::{
        connectivity::NativeApplicationResourceConnection,
        core::{NativeIntegrationContext, NativeOperations},
    },
};
use anyhow::{Context, Result, ensure};
use kcoder_engine::QueryEngine;
use kcoder_state::AppStateLifecycleIdentity;
use kcoder_types::integrations::{core::*, knowledge::*};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Weak};
use tokio_util::sync::CancellationToken;

pub(crate) struct NativeApplicationReadAuthority {
    native: NativeIntegrationContext,
    engine: QueryEngine,
    state: AppStateLifecycleIdentity,
    owner: Weak<()>,
    ended: CancellationToken,
    operation: String,
    pub(super) connection: Arc<NativeApplicationResourceConnection>,
    params: AutomationApplicationSelectionParams,
    receipt: AutomationApplicationSelectionReceipt,
}
impl NativeApplicationReadAuthority {
    pub(super) fn source_ref(&self) -> &str {
        &self.receipt.source_ref
    }
    pub(super) fn resource_uri(&self) -> &str {
        &self.params.resource_uri
    }
    pub(super) fn resource_ref(&self) -> &str {
        &self.receipt.resource_ref
    }
    pub(super) fn revision(&self) -> &str {
        &self.receipt.selection_revision
    }
    pub(super) fn verify_current(&self, native: &NativeIntegrationContext) -> Result<()> {
        native.validate_scope(self.native.scope())?;
        self.native.verify()?;
        {
            let settings = self
                .engine
                .settings
                .read()
                .map_err(|_| anyhow::anyhow!("AUTOMATION_CONFIGURATION_UNAVAILABLE"))?;
            ensure!(
                !settings.training_mode
                    && settings.integrations.knowledge.business_automation_enabled,
                "AUTOMATION_NATIVE_FEATURE_UNAVAILABLE"
            );
        }
        ensure!(
            self.owner.upgrade().is_some()
                && !self.ended.is_cancelled()
                && self.state.matches(&self.engine.state),
            "AUTOMATION_APPLICATION_READ_OWNER_CHANGED"
        );
        EngineSnapshot::capture(&self.engine)?.verify_binding(&self.engine, native)?;
        let ledger = NativeOperations::load(native)?
            .context("AUTOMATION_APPLICATION_READ_CONSENT_UNAVAILABLE")?;
        let receipt = ledger
            .read(native, &self.operation)?
            .context("AUTOMATION_APPLICATION_READ_CONSENT_UNAVAILABLE")?;
        ensure!(
            receipt.port == "P-AUTOMATION"
                && receipt.method == "selectApplicationEventSource"
                && receipt.phase == IntegrationOperationPhase::Completed
                && receipt.entity_ref.as_ref().is_some_and(|entity| entity.kind
                    == IntegrationEntityKind::Input
                    && entity.id == self.receipt.source_ref
                    && entity.revision.as_deref()
                        == Some(self.receipt.selection_revision.as_str())),
            "AUTOMATION_APPLICATION_READ_CONSENT_CHANGED"
        );
        self.connection.verify_current(native)?;
        ensure!(
            self.owner.upgrade().is_some() && !self.ended.is_cancelled(),
            "AUTOMATION_APPLICATION_READ_OWNER_CHANGED"
        );
        Ok(())
    }
}

pub(crate) struct NativeApplicationSelectionControl {
    request: IntegrationRequest,
    native: NativeIntegrationContext,
    engine: QueryEngine,
    factory: AppServerEngineFactory,
    state: AppStateLifecycleIdentity,
    owner: Weak<()>,
    ended: CancellationToken,
    params: AutomationApplicationSelectionParams,
    cache: Arc<tokio::sync::Mutex<super::NativeKnowledgeRpc>>,
    expires: std::time::Instant,
}
impl NativeApplicationSelectionControl {
    pub(in crate::app_server) fn from_public_control(
        state: &ConnectionState,
        engine: &QueryEngine,
        factory: &AppServerEngineFactory,
        request: IntegrationRequest,
    ) -> Result<Self> {
        request.validate(true)?;
        ensure!(
            state.initialized
                && state.integration_automation_v1
                && !state.native_source_dispatch
                && state.native_source_accepted.is_none()
                && !state.input_ended.is_cancelled(),
            "AUTOMATION_APPLICATION_PUBLIC_CONTROL_REQUIRED"
        );
        let settings = engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_CONFIGURATION_UNAVAILABLE"))?;
        ensure!(
            !settings.training_mode && settings.integrations.knowledge.business_automation_enabled,
            "AUTOMATION_NATIVE_FEATURE_UNAVAILABLE"
        );
        drop(settings);
        let native = state
            .integration_context
            .as_ref()
            .context("AUTOMATION_NATIVE_OWNER_UNAVAILABLE")?
            .recapture_for_owned_service()?;
        native.validate_scope(&request.scope)?;
        ensure!(
            native.scope().organization_id.is_none(),
            "AUTOMATION_APPLICATION_ORGANIZATION_POLICY_REQUIRED"
        );
        EngineSnapshot::capture(engine)?.verify_binding(engine, &native)?;
        let params: AutomationApplicationSelectionParams =
            serde_json::from_value(serde_json::Value::Object(request.payload.clone()))?;
        params.validate().map_err(anyhow::Error::msg)?;
        let expires =
            std::time::Instant::now() + std::time::Duration::from_millis(request.timeout_ms);
        Ok(Self {
            request,
            native,
            engine: engine.clone(),
            factory: factory.clone(),
            state: engine.state.inspection_lifecycle_identity(),
            owner: Arc::downgrade(&state.source_management_owner),
            ended: state.input_ended.clone(),
            params,
            cache: state.integration_knowledge.clone(),
            expires,
        })
    }
    fn verify(&self) -> Result<()> {
        ensure!(
            self.owner.upgrade().is_some()
                && !self.ended.is_cancelled()
                && self.state.matches(&self.engine.state)
                && std::time::Instant::now() < self.expires,
            "AUTOMATION_APPLICATION_READ_OWNER_CHANGED"
        );
        EngineSnapshot::capture(&self.engine)?.verify_binding(&self.engine, &self.native)
    }
    fn prepare(&self) -> Result<Arc<NativeApplicationReadAuthority>> {
        self.verify()?;
        let connection = NativeApplicationResourceConnection::capture(
            &self.native,
            &self.engine,
            &self.factory,
            Arc::new(kcoder_config::OsCredentialBackend::new()),
            self.params.source.clone(),
        )?;
        connection.verify_resource_support()?;
        connection.validate_resource_uri(&self.params.resource_uri)?;
        let hash = |value: &serde_json::Value| -> Result<String> {
            Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
        };
        let revision = hash(&serde_json::json!([
            KnowledgeOwner::from(self.native.scope()),
            &self.params
        ]))?;
        // A renewed explicit read consent retains the fixed source/resource locator.
        // It does not reset the original subscription cursor or event identity.
        let locator = hash(&serde_json::json!([
            KnowledgeOwner::from(self.native.scope()),
            self.params.source,
            self.params.resource_uri
        ]))?;
        let receipt = AutomationApplicationSelectionReceipt {
            owner: self.native.scope().into(),
            source_ref: format!("application-events-{locator}"),
            selection_revision: revision.clone(),
            source: self.params.source.clone(),
            resource_ref: format!("application-resource-{locator}"),
        };
        let operation = self
            .request
            .operation_id
            .as_deref()
            .context("AUTOMATION_OPERATION_REQUIRED")?;
        self.verify()?;
        let ledger = match NativeOperations::load(&self.native)? {
            Some(ledger) => ledger,
            None => NativeOperations::initialize(&self.native, operation)?,
        };
        let mut intent = self.request.clone();
        intent.payload =
            serde_json::json!({"selector":self.request.payload,"resolvedSelection":receipt})
                .as_object()
                .unwrap()
                .clone();
        let (original, _) = ledger.begin(
            &self.native,
            &intent,
            "P-AUTOMATION",
            "selectApplicationEventSource",
        )?;
        ensure!(
            matches!(
                original.phase,
                IntegrationOperationPhase::Executing
                    | IntegrationOperationPhase::Unknown
                    | IntegrationOperationPhase::Completed
            ),
            "AUTOMATION_APPLICATION_ORIGINAL_REJECTED"
        );
        self.verify()?;
        connection.verify_current(&self.native)?;
        let entity = IntegrationEntityRef {
            kind: IntegrationEntityKind::Input,
            id: receipt.source_ref.clone(),
            revision: Some(revision),
        };
        if original.phase == IntegrationOperationPhase::Completed {
            ensure!(
                original.entity_ref == Some(entity),
                "AUTOMATION_APPLICATION_READ_CONSENT_CHANGED"
            );
        } else {
            ledger.transition_with_entity(
                &self.native,
                &original,
                IntegrationOperationPhase::Completed,
                Some(entity),
                None,
            )?;
        }
        let selected = Arc::new(NativeApplicationReadAuthority {
            native: self.native.recapture_for_owned_service()?,
            engine: self.engine.clone(),
            state: self.state.clone(),
            owner: self.owner.clone(),
            ended: self.ended.clone(),
            operation: operation.into(),
            connection,
            params: self.params.clone(),
            receipt,
        });
        selected.verify_current(&self.native)?;
        Ok(selected)
    }
    pub(crate) async fn run(self) -> IntegrationReply {
        let request = self.request.clone();
        let cache = self.cache.clone();
        let native = self.native.recapture_for_owned_service();
        let result = async {
            let selected = tokio::task::spawn_blocking(move || self.prepare())
                .await
                .context("AUTOMATION_APPLICATION_SELECTION_WORKER_UNAVAILABLE")??;
            selected.verify_current(&selected.native)?;
            cache
                .lock()
                .await
                .install_application_event_source(selected.native.scope(), selected.clone())?;
            selected.verify_current(&selected.native)?;
            Ok::<_, anyhow::Error>(
                serde_json::to_value(&selected.receipt)?
                    .as_object()
                    .unwrap()
                    .clone(),
            )
        }
        .await;
        // The owned preparation has settled here. Only an authoritative absent
        // original operation can classify a completed pre-write rejection.
        let rejected_before_write = if result.is_err() {
            native
                .as_ref()
                .ok()
                .is_some_and(|native| match NativeOperations::load(native) {
                    Ok(None) => true,
                    Ok(Some(ledger)) => request.operation_id.as_deref().is_some_and(|operation| {
                        matches!(ledger.read(native, operation), Ok(None))
                    }),
                    Err(_) => false,
                })
        } else {
            false
        };
        IntegrationReply {
            contract_version: request.contract_version,
            request_id: request.request_id,
            operation_id: request
                .operation_id
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            entity_revision: IntegrationNullable::Null,
            observed_at: chrono::Utc::now().to_rfc3339(),
            status: if result.is_ok() {
                IntegrationStatus::Completed
            } else if rejected_before_write {
                IntegrationStatus::Rejected
            } else {
                IntegrationStatus::Unknown
            },
            error: if result.is_ok() {
                IntegrationNullable::Null
            } else {
                IntegrationNullable::Value(IntegrationError {
                    code: "AUTOMATION_APPLICATION_SELECTION_UNCONFIRMED".into(),
                    recovery: IntegrationRecovery::ReconcileOriginal,
                    message_key: "knowledgeIntegration.operationFailed".into(),
                })
            },
            result: result
                .ok()
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        }
    }
}

#[cfg(test)]
mod tests;
