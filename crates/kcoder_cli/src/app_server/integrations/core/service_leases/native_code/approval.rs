//! Explicit native account consent for one real saved-code source and immutable input.
use super::source::NativeSavedCodeSource;
use super::*;
use crate::app_server::integrations::core::service_leases::code_task;
use crate::app_server::{
    ConnectionState,
    integrations::core::{NativeOperations, NativePolicyService},
};
use anyhow::{Context, ensure};
use kcoder_engine::QueryEngine;
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Weak},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

type Selection = kcoder_app_protocol::integrations::code_services::NativeCodeServicePreparePayload;

pub(crate) struct NativeCodeServiceApproval {
    native: NativeIntegrationContext,
    origin: QueryEngine,
    request: IntegrationRequest,
    selection: Selection,
    owner: Weak<()>,
    ended: CancellationToken,
    deadline: Instant,
    identity_revision: u64,
}
impl NativeCodeServiceApproval {
    pub(in crate::app_server) fn capture(
        state: &ConnectionState,
        origin: &QueryEngine,
        request: IntegrationRequest,
    ) -> Result<Self> {
        request.validate(true)?;
        ensure!(
            cfg!(target_os = "linux"),
            "SERVICE_NATIVE_PLATFORM_UNSUPPORTED"
        );
        #[cfg(target_os = "linux")]
        kcoder_native_scope::service_identity::verify_current_unix_account()?;

        ensure!(
            state.initialized
                && !state.native_source_dispatch
                && state.native_source_accepted.is_none()
                && !state.input_ended.is_cancelled(),
            "NATIVE_CODE_ORIGINAL_MANAGEMENT_REQUIRED"
        );
        ensure!(
            origin
                .settings
                .read()
                .map_err(|_| anyhow::anyhow!("NATIVE_CODE_CONFIGURATION_UNAVAILABLE"))?
                .integrations
                .services
                .enabled,
            "SERVICE_FEATURE_DISABLED"
        );
        let native = state
            .integration_context
            .as_ref()
            .context("NATIVE_CODE_SCOPE_UNAVAILABLE")?
            .recapture_for_owned_service()?;
        native.validate_scope(&request.scope)?;
        ensure!(
            native.scope().organization_id.is_none(),
            "NATIVE_CODE_ORGANIZATION_UNSUPPORTED"
        );
        let selection: Selection =
            serde_json::from_value(serde_json::Value::Object(request.payload.clone()))?;
        ensure!(
            selection.purpose == kcoder_app_protocol::integrations::code_services::NativeCodeServicePurpose::SavedCode
                && selection.explicit_background_consent
                && (1..=MAX_INTEGRATION_DELEGATION_TTL_MS).contains(&selection.expires_in_ms),
            "NATIVE_CODE_EXPLICIT_CONSENT_REQUIRED"
        );
        let identity_revision = native.source_authority_epoch()?.1;
        let result = Self {
            native,
            origin: origin.clone(),
            deadline: Instant::now() + Duration::from_millis(request.timeout_ms),
            request,
            selection,
            owner: Arc::downgrade(&state.source_management_owner),
            ended: state.input_ended.clone(),
            identity_revision,
        };
        result.verify()?;
        Ok(result)
    }
    fn verify(&self) -> Result<()> {
        self.native.validate_scope(&self.request.scope)?;
        ensure!(
            self.owner.upgrade().is_some()
                && !self.ended.is_cancelled()
                && Instant::now() < self.deadline
                && self.native.source_authority_epoch()?.1 == self.identity_revision,
            "NATIVE_CODE_MANAGEMENT_OWNER_ENDED"
        );
        ensure!(
            self.origin
                .settings
                .read()
                .map_err(|_| anyhow::anyhow!("NATIVE_CODE_CONFIGURATION_UNAVAILABLE"))?
                .integrations
                .services
                .enabled,
            "SERVICE_FEATURE_DISABLED"
        );
        Ok(())
    }
    pub(crate) fn prepare(self) -> Result<NativeCodeServiceRecord> {
        self.verify()?;
        let operation = self
            .request
            .operation_id
            .as_deref()
            .context("NATIVE_CODE_OPERATION_REQUIRED")?;
        let id = format!(
            "native-code-{:x}",
            Sha256::digest(serde_json::to_vec(&(
                IntegrationOwner::from(self.native.scope()),
                operation
            ))?)
        );
        let task = code_task::prepare(&self.native, &self.selection.code_workflow, &id)?;
        let source =
            NativeSavedCodeSource::capture(&self.native, &self.origin, task.clone(), &self.ended)?;
        let mut operations = NativeOperations::load(&self.native)?;
        if operations.is_none() {
            operations = Some(NativeOperations::initialize(&self.native, operation)?);
        }
        let operations = operations.context("NATIVE_CODE_OPERATION_STORE_UNAVAILABLE")?;
        let prior = operations.read(&self.native, operation)?;
        let (receipt, execute) = operations.begin(
            &self.native,
            &self.request,
            "P-POLICY",
            "prepareNativeCodeService",
        )?;
        let storage = match NativeServiceLeases::load(&self.native)? {
            Some(storage) => storage,
            None => {
                ensure!(execute, "NATIVE_CODE_ORIGINAL_STORE_REQUIRED");
                NativeServiceLeases::initialize(&self.native, operation)?
            }
        };
        let store = storage.store(&self.native)?;
        if receipt.phase == IntegrationOperationPhase::Completed {
            return store
                .read_native_code(&id)?
                .context("NATIVE_CODE_ORIGINAL_RECORD_MISSING");
        }
        let prepared = store.read_native_code_preparation(&id)?;
        if prepared.is_some() {
            ensure!(prior.is_some(), "NATIVE_CODE_ORIGINAL_OPERATION_MISSING");
        }
        let intent = if let Some((intent, launch)) = prepared {
            ensure!(
                launch.task == task
                    && intent.configuration_sha256 == source.configuration_sha256
                    && intent.native_image_sha256 == source.image.sha256(),
                "NATIVE_CODE_ORIGINAL_SOURCE_CHANGED"
            );
            self.native.validate_scope(&intent.scope)?;
            intent
        } else {
            ensure!(execute, "NATIVE_CODE_ORIGINAL_ISSUE_REQUIRES_READ");
            let intent = NativeCodeServiceIntent {
                template: NATIVE_CODE_SERVICE_TEMPLATE_V1.into(),
                lease_id: id.clone(),
                operation_id: operation.into(),
                scope: self.native.scope().clone(),
                definition_id: task.definition_id.clone(),
                definition_version: task.version,
                definition_sha256: task.definition_sha256.clone(),
                task_sha256: code_task::sha256(&task)?,
                configuration_sha256: source.configuration_sha256.clone(),
                native_image_sha256: source.image.sha256().into(),
                expires_at_ms: now()?
                    .checked_add(self.selection.expires_in_ms)
                    .context("NATIVE_CODE_SERVICE_DEADLINE_INVALID")?,
            };
            let launch = NativeCodeServiceLaunchSpec {
                schema_version: 1,
                lease_id: id.clone(),
                profile_path: self.native.profile_path()?.to_path_buf(),
                workspace_path: source.workspace_path.clone(),
                settings_file: source.settings_file.clone(),
                task,
            };
            store.prepare_native_code(&intent, &launch)?;
            intent
        };
        self.verify()?;
        let snapshot = source.snapshot()?;
        let issuer = NativePolicyService::open_after_native_code_approval(&self.native, operation)?;
        let grant = if execute {
            issuer.issue_native_code_service(&self.native, &intent, &snapshot, now()?)?
        } else {
            issuer
                .read_native_code_service_issue(&self.native, &intent, now()?)?
                .context("NATIVE_CODE_ORIGINAL_ISSUE_REQUIRES_READ")?
        };
        ensure!(
            grant.status == IntegrationDelegationStatus::Active,
            "NATIVE_CODE_SERVICE_UNAVAILABLE"
        );
        let record = store.commit_native_code(NativeCodeServiceRecord {
            schema_version: 1,
            revision: 1,
            intent,
            grant_ref: grant.reference.clone(),
            state: NativeCodeServiceState::Approved,
            enabled: false,
            observed_at_ms: now()?,
        })?;
        operations.transition_with_entity(
            &self.native,
            &receipt,
            IntegrationOperationPhase::Completed,
            Some(IntegrationEntityRef {
                kind: IntegrationEntityKind::Delegation,
                id: grant.reference.id,
                revision: Some(grant.reference.revision),
            }),
            None,
        )?;
        self.verify()?;
        Ok(record)
    }
}
