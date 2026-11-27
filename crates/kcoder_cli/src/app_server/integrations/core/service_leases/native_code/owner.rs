//! A dedicated real account process reopens the original code source and signed lease.
use super::diagnostics::{self, Stage};
use super::*;
use crate::app_server::integrations::core::service_leases::process::NativeServiceProcess;
use crate::app_server::integrations::core::{NativeOperations, NativePolicyService};
use anyhow::{Context, ensure};
use kcoder_permissions::integrations::core::NativeCodeServicePermit;
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(crate) struct NativeCodeServiceOwner {
    native: NativeIntegrationContext,
    storage: NativeServiceLeases,
    record: NativeCodeServiceRecord,
    pub(super) launch: NativeCodeServiceLaunchSpec,
    source: NativeSavedCodeSource,
    issuer: NativePolicyService,
    permit: NativeCodeServicePermit,
    process: NativeServiceProcess,
    stop: CancellationToken,
}
impl NativeCodeServiceOwner {
    pub(super) fn open_existing(profile: &Path, workspace: &Path, id: &str) -> Result<Arc<Self>> {
        // This initial context is a read-only native locator. Its revision does
        // not authorize a service; resolved current settings supply that later.
        let mut native = diagnostics::mark(
            Stage::OwnerOpen,
            NativeIntegrationContext::capture_existing(
                profile,
                workspace,
                "native-code-service-read",
                "native-code-preflight-only",
            ),
        )?;
        let storage = diagnostics::mark(Stage::OwnerStore, NativeServiceLeases::load(&native))?
            .context("NATIVE_CODE_ORIGINAL_STORE_REQUIRED")?;
        let store = storage.store(&native)?;
        let record = store
            .read_native_code(id)?
            .context("NATIVE_CODE_SERVICE_NOT_FOUND")?;
        ensure!(record.enabled, "NATIVE_CODE_SERVICE_NOT_ENABLED");
        let launch = diagnostics::mark(Stage::OwnerRecord, store.read_native_code_launch(id))?;
        let settings = diagnostics::mark(
            Stage::OwnerSettings,
            super::source::load_settings(profile, workspace, &launch.settings_file),
        )?;
        let revision = kcoder_engine::model_configuration_summary(
            &settings,
            kcoder_types::ModelConfigurationBoundary::SessionSnapshot,
        )?
        .revision;
        native.refresh_configuration_revision(revision)?;
        diagnostics::mark(
            Stage::OwnerScope,
            native.validate_scope(&record.intent.scope),
        )?;
        let source = diagnostics::mark(
            Stage::OwnerSource,
            NativeSavedCodeSource::from_launch(&native, &launch, &CancellationToken::new()),
        )?;
        let snapshot = source.snapshot()?;
        let issuer = diagnostics::mark(Stage::OwnerIssuer, NativePolicyService::load(&native))?
            .context("NATIVE_CODE_ORIGINAL_ISSUER_REQUIRED")?;
        let permit = diagnostics::mark(
            Stage::OwnerIssuer,
            issuer.authorize_native_code_service(&native, &record, &snapshot, now()?),
        )?;
        let operations = NativeOperations::load(&native)?
            .context("NATIVE_CODE_ORIGINAL_OPERATION_STORE_REQUIRED")?;
        let receipt = diagnostics::mark(
            Stage::OwnerApprovalReceipt,
            operations.read(&native, &record.intent.operation_id),
        )?
        .context("NATIVE_CODE_ORIGINAL_OPERATION_REQUIRED")?;
        ensure!(
            receipt.phase == IntegrationOperationPhase::Completed
                && receipt
                    .entity_ref
                    .as_ref()
                    .is_some_and(
                        |reference| reference.kind == IntegrationEntityKind::Delegation
                            && reference.id == record.grant_ref.id
                            && reference.revision.as_deref()
                                == Some(record.grant_ref.revision.as_str())
                    ),
            "NATIVE_CODE_ORIGINAL_APPROVAL_UNCONFIRMED"
        );
        let process = diagnostics::mark(
            Stage::OwnerProcess,
            NativeServiceProcess::capture_native_code(
                &native,
                &record,
                &storage,
                source.image.duplicate_handle()?,
            ),
        )?;
        let owner = Arc::new(Self {
            native,
            storage,
            record,
            launch,
            source,
            issuer,
            permit,
            process,
            stop: CancellationToken::new(),
        });
        owner.verify()?;
        let current = owner
            .storage
            .store(&owner.native)?
            .read_native_code(id)?
            .context("NATIVE_CODE_SERVICE_NOT_FOUND")?;
        diagnostics::mark(
            Stage::OwnerRunning,
            owner.storage.store(&owner.native)?.transition_native_code(
                id,
                current.revision,
                NativeCodeServiceState::Running,
                now()?,
            ),
        )?;
        Ok(owner)
    }
    pub(crate) fn native(&self) -> &NativeIntegrationContext {
        &self.native
    }
    pub(super) fn launch(&self) -> &NativeCodeServiceLaunchSpec {
        &self.launch
    }
    pub(super) fn intent(&self) -> &NativeCodeServiceIntent {
        &self.record.intent
    }
    pub(crate) fn cancellation(&self) -> CancellationToken {
        self.stop.clone()
    }
    pub(crate) fn verify(&self) -> Result<()> {
        self.process.verify()?;
        self.native.verify()?;
        ensure!(!self.stop.is_cancelled(), "NATIVE_CODE_SERVICE_STOPPED");
        let record = self
            .storage
            .store(&self.native)?
            .read_native_code(&self.record.intent.lease_id)?
            .context("NATIVE_CODE_SERVICE_NOT_FOUND")?;
        ensure!(
            record.intent == self.record.intent
                && record.grant_ref == self.record.grant_ref
                && record.enabled
                && record.state != NativeCodeServiceState::Revoked,
            "NATIVE_CODE_ORIGINAL_LEASE_CHANGED"
        );
        let source = self.source.snapshot()?;
        self.issuer
            .revalidate_native_code_service(&self.native, &self.permit, &source, now()?)
    }
    pub(super) fn claim_runtime_once(&self) -> Result<bool> {
        self.verify()?;
        self.storage
            .store(&self.native)?
            .claim_native_code_runtime(&self.record.intent.lease_id)
    }
    pub(super) fn request_stop(&self) {
        self.stop.cancel();
    }
    pub(super) fn record_stopped_after_cleanup(&self) -> Result<()> {
        self.process.verify()?;
        let current = self
            .storage
            .store(&self.native)?
            .read_native_code(&self.record.intent.lease_id)?
            .context("NATIVE_CODE_SERVICE_NOT_FOUND")?;
        if current.state == NativeCodeServiceState::Revoked {
            return Ok(());
        }
        self.storage.store(&self.native)?.transition_native_code(
            &self.record.intent.lease_id,
            current.revision,
            NativeCodeServiceState::Stopped,
            now()?,
        )?;
        Ok(())
    }
}
