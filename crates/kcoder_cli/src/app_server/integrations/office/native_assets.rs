//! Connection-owned opaque Office leases over the existing attachment reader.
//!
//! This adapter neither publishes paths nor creates a second asset store. All
//! artifact bytes remain in OfficeStore; each range reopens its real private
//! namespace and verifies the immutable content and current source authority.
use super::native_host::{
    NativeOfficeAcceptedTurnAuthority, NativeOfficeAssets, NativeOfficeTaskAuthority,
};
use super::{OfficeReadHeader, OfficeReadWorker};
use crate::app_server::{
    attachments::{AttachmentDirectories, open_owned_staged_attachment},
    integrations::core::{NativeDomain, NativeDomainGuard, NativeIntegrationContext},
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_app_protocol::{
    AttachmentReadChunkParams, AttachmentReadChunkResult, AttachmentReadParams,
    AttachmentReadResult, AttachmentSaveResult,
};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use kcoder_engine::QueryEngine;
#[cfg(test)]
use kcoder_state::integrations::office::OfficeNativeInput;
use kcoder_state::integrations::office::{OfficeInputMetadata, OfficeInputReceipt, OfficeStore};
use kcoder_tools::ToolContext;
use kcoder_types::integrations::{core::*, office::*};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

const PREFIX: &str = "office-export:";
const LEASE_MILLIS: u64 = 15 * 60 * 1000;
const MAX_LEASES: usize = 64;
#[cfg(test)]
const MAX_INPUTS: usize = 32;
const CHUNK_BYTES: usize = 512 * 1024;
const PREVIEW_BYTES: usize = 256 * 1024;
#[path = "export_read_progress.rs"]
mod export_read_progress;
mod history;
use history::{HistoryRoot, HistoryWitness};
mod channel_material;
#[path = "export_acknowledgements.rs"]
mod export_acknowledgements;
mod inputs;
pub(crate) use inputs::NativeOfficePreparedInput;

#[derive(Clone)]
struct ExportLease {
    scope: IntegrationScope,
    operation: String,
    manifest: OfficeArtifactManifest,
    inputs: Vec<OfficeCanonicalInputIdentity>,
    receipt: OfficeExportReceipt,
    history: Option<HistoryWitness>,
    read_progress: Arc<Mutex<export_read_progress::ExportReadProgress>>,
}

/// Constructed only by the original export owner after complete native byte
/// observations and an explicit matching client acknowledgement.
pub(in crate::app_server::integrations) struct VerifiedOfficeExportAcknowledgement {
    scope: IntegrationScope,
    manifest: OfficeArtifactManifest,
    export_id: String,
    bytes: u64,
    sha256: String,
    completed_at_ms: u64,
    acknowledged_at_ms: u64,
    source_identities: Vec<OfficeCanonicalInputIdentity>,
}

impl VerifiedOfficeExportAcknowledgement {
    pub(in crate::app_server::integrations) fn scope(&self) -> &IntegrationScope {
        &self.scope
    }
    pub(in crate::app_server::integrations) fn manifest(&self) -> &OfficeArtifactManifest {
        &self.manifest
    }
    pub(in crate::app_server::integrations) fn export_id(&self) -> &str {
        &self.export_id
    }
    pub(in crate::app_server::integrations) fn bytes(&self) -> u64 {
        self.bytes
    }
    pub(in crate::app_server::integrations) fn sha256(&self) -> &str {
        &self.sha256
    }
    pub(in crate::app_server::integrations) fn completed_at_ms(&self) -> u64 {
        self.completed_at_ms
    }
}
struct InputLease {
    scope: IntegrationScope,
    parent: PrivateDirectory,
    parent_path: PathBuf,
    filename: OsString,
    identity: PortableLeaseIdentity,
    receipt: OfficeInputReceipt,
}

#[derive(Default)]
struct ResultExportHistory {
    seen: BTreeSet<(String, u64)>,
    saturated: bool,
}
/// Held once per real app-server connection and dropped with that owner.
/// Creating this in-memory registry does not create a private namespace/file.
#[cfg_attr(not(test), derive(Default))]
pub(crate) struct NativeOfficeTransfers {
    #[cfg(test)]
    connection_id: String,
    exports: Mutex<BTreeMap<String, ExportLease>>,
    exported_artifacts: Mutex<ResultExportHistory>,
    inputs: Mutex<BTreeMap<String, Arc<InputLease>>>,
}
#[cfg(test)]
impl Default for NativeOfficeTransfers {
    fn default() -> Self {
        Self {
            #[cfg(test)]
            connection_id: format!("office-connection-{}", uuid::Uuid::new_v4()),
            exports: Mutex::default(),
            exported_artifacts: Mutex::default(),
            inputs: Mutex::default(),
        }
    }
}
impl std::fmt::Debug for NativeOfficeTransfers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeOfficeTransfers")
            .field(
                "exports",
                &self.exports.try_lock().ok().map(|items| items.len()),
            )
            .field(
                "inputs",
                &self.inputs.try_lock().ok().map(|items| items.len()),
            )
            .finish_non_exhaustive()
    }
}

/// Rust-only composition. The optional provider handles explicitly routed
/// external kinds (wiki_page/publication), never a fallback after a denial.
pub(crate) struct NativeOfficeFileAssets {
    native: NativeIntegrationContext,
    engine: QueryEngine,
    transfers: Arc<NativeOfficeTransfers>,
    sources: Option<Arc<dyn NativeOfficeAssets>>,
    history: Option<HistoryRoot>,
}
impl NativeOfficeFileAssets {
    fn original_read_worker() -> Result<OfficeReadWorker> {
        let program = std::env::current_exe()?;
        #[cfg(test)]
        let program = std::env::var_os("KCODER_OFFICE_READER_TEST_BIN")
            .map(std::path::PathBuf::from)
            .unwrap_or(program);
        OfficeReadWorker::from_trusted_program(&program)
    }

    pub(crate) fn capture(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        transfers: Arc<NativeOfficeTransfers>,
        sources: Option<Arc<dyn NativeOfficeAssets>>,
    ) -> Result<Self> {
        let result = Self {
            native: native.recapture_for_owned_service()?,
            engine: engine.clone(),
            transfers,
            sources,
            history: None,
        };
        result.check(native, &CancellationToken::new())?;
        Ok(result)
    }

    /// Read-only composition over the native factory's real workspace engine.
    /// This does not start/resume a thread or modify any AppState session ID.
    pub(crate) fn capture_management(
        native: &NativeIntegrationContext,
        workspace_engine: &QueryEngine,
        transfers: Arc<NativeOfficeTransfers>,
        sources: Option<Arc<dyn NativeOfficeAssets>>,
    ) -> Result<Self> {
        let mut result = Self::capture(native, workspace_engine, transfers, sources)?;
        result.history = HistoryRoot::observe(workspace_engine)?;
        Ok(result)
    }

    pub(crate) fn is_export_locator(value: &str) -> bool {
        value.starts_with(PREFIX)
    }
    pub(crate) fn export_locator(receipt: &OfficeExportReceipt) -> String {
        format!("{PREFIX}{}:{}", receipt.export_id, receipt.lease_revision)
    }

    /// Read only this original in-memory owner's current export lease. A
    /// persisted receipt without its actual owner is never adopted as a lease.
    pub(crate) fn current_result_export(
        &self,
        native: &NativeIntegrationContext,
        manifest: &OfficeArtifactManifest,
        cancel: &CancellationToken,
    ) -> Result<Option<OfficeExportReceipt>> {
        self.check(native, cancel)?;
        let history = self.check_manifest(manifest, &self.store()?)?;
        ensure!(
            self.history.is_some() && history.is_some(),
            "OFFICE_NATIVE_TASK_NOT_FOUND"
        );
        let leases = self
            .transfers
            .exports
            .lock()
            .map_err(|_| anyhow::anyhow!("OFFICE_HOST_UNCONFIRMED"))?;
        let mut found = None;
        for lease in leases
            .values()
            .filter(|lease| lease.scope == *native.scope() && lease.manifest == *manifest)
        {
            ensure!(
                now()? < lease.receipt.expires_at_ms,
                "OFFICE_EXPORT_PROVIDER_UNAVAILABLE"
            );
            lease.receipt.validate_for(manifest)?;
            if found.as_ref().is_none_or(|old: &OfficeExportReceipt| {
                old.expires_at_ms < lease.receipt.expires_at_ms
            }) {
                found = Some(lease.receipt.clone());
            }
        }
        let seen = self
            .transfers
            .exported_artifacts
            .lock()
            .map_err(|_| anyhow::anyhow!("OFFICE_HOST_UNCONFIRMED"))?;
        ensure!(
            found.is_some()
                || (!seen.saturated
                    && !seen
                        .seen
                        .contains(&(manifest.id.clone(), manifest.revision))),
            "OFFICE_EXPORT_PROVIDER_UNAVAILABLE"
        );
        Ok(found)
    }

    /// A private result-source caller separately proves its exact canonical
    /// reference and current purpose before using this historical observation.
    pub(crate) fn read_result_manifest(
        &self,
        native: &NativeIntegrationContext,
        reference: &OfficeArtifactRef,
        task: &OfficeTaskRef,
        cancel: &CancellationToken,
    ) -> Result<OfficeArtifactManifest> {
        self.check(native, cancel)?;
        let store = self.store()?;
        let manifest = store
            .read_artifact(reference)?
            .context("OFFICE_ARTIFACT_NOT_FOUND")?;
        ensure!(
            manifest.task == *task && self.history.is_some(),
            "OFFICE_NATIVE_TASK_NOT_FOUND"
        );
        ensure!(
            self.check_manifest(&manifest, &store)?.is_some(),
            "OFFICE_NATIVE_TASK_NOT_FOUND"
        );
        Ok(manifest)
    }

    pub(crate) fn read_result_bytes(
        &self,
        native: &NativeIntegrationContext,
        manifest: &OfficeArtifactManifest,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        self.check(native, cancel)?;
        ensure!(
            manifest.bytes <= 100 * 1024 * 1024,
            "OFFICE_OUTPUT_TOO_LARGE"
        );
        let store = self.store()?;
        let history = self.check_manifest(manifest, &store)?;
        ensure!(
            self.history.is_some() && history.is_some(),
            "OFFICE_NATIVE_TASK_NOT_FOUND"
        );
        let reference = OfficeArtifactRef {
            id: manifest.id.clone(),
            revision: manifest.revision,
        };
        let mut bytes = Vec::new();
        while (bytes.len() as u64) < manifest.bytes {
            ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
            let (chunk, total) =
                store.read_artifact_chunk(&reference, bytes.len() as u64, CHUNK_BYTES)?;
            ensure!(
                total == manifest.bytes
                    && !chunk.is_empty()
                    && (bytes.len() + chunk.len()) as u64 <= total,
                "OFFICE_CONTENT_CORRUPT"
            );
            bytes.extend_from_slice(&chunk);
        }
        ensure!(
            hash(&bytes) == manifest.sha256
                && self.check_manifest(manifest, &self.store()?)? == history,
            "OFFICE_CONTENT_CORRUPT"
        );
        self.check(native, cancel)?;
        Ok(bytes)
    }

    fn check(&self, native: &NativeIntegrationContext, cancel: &CancellationToken) -> Result<()> {
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        native.validate_scope(self.native.scope())?;
        self.native.validate_scope(native.scope())?;
        self.native.verify()?;
        super::organization_policy::verify(native)?;
        let path = self
            .engine
            .native_settings_source_path()
            .context("OFFICE_NATIVE_PROFILE_UNAVAILABLE")?;
        let profile = PrivateDirectory::open_existing(
            path.parent().context("OFFICE_NATIVE_PROFILE_UNAVAILABLE")?,
        )?;
        let workspace = PrivateDirectory::open_existing(&self.engine.state.cwd())?;
        ensure!(
            path.is_absolute()
                && profile.directory_identity()? == native.profile()?.directory_identity()?
                && workspace.directory_identity()? == native.workspace_directory_identity()?,
            "OFFICE_SCOPE_CHANGED"
        );
        let settings = self
            .engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("OFFICE_SETTINGS_UNAVAILABLE"))?;
        settings.integrations.office.validate()?;
        ensure!(settings.integrations.office.enabled, "OFFICE_DISABLED");
        Ok(())
    }

    fn store(&self) -> Result<OfficeStore> {
        let guard = NativeDomainGuard::observe(
            self.native.profile()?,
            self.native.scope(),
            NativeDomain::Office,
        )?
        .context("OFFICE_NATIVE_STORE_UNCONFIRMED")?;
        OfficeStore::open_in(
            &guard.directory(self.native.profile()?)?,
            OsStr::new("data"),
            IntegrationOwner::from(self.native.scope()),
        )?
        .context("OFFICE_NATIVE_STORE_UNCONFIRMED")
    }

    fn request(&self, payload: Value) -> IntegrationRequest {
        IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: format!("office-claim-{}", uuid::Uuid::new_v4()),
            scope: self.native.scope().clone(),
            operation_id: None,
            expected_revision: None,
            timeout_ms: 30_000,
            cancellation_ref: None,
            payload: payload.as_object().cloned().unwrap_or_default(),
        }
    }

    fn check_manifest(
        &self,
        manifest: &OfficeArtifactManifest,
        store: &OfficeStore,
    ) -> Result<Option<HistoryWitness>> {
        manifest.validate()?;
        ensure!(
            manifest.owner == IntegrationOwner::from(self.native.scope()),
            "OFFICE_OWNER_MISMATCH"
        );
        let reference = OfficeArtifactRef {
            id: manifest.id.clone(),
            revision: manifest.revision,
        };
        ensure!(
            store.read_artifact(&reference)?.as_ref() == Some(manifest),
            "OFFICE_ARTIFACT_NOT_FOUND"
        );
        // Only this real same-owner manifest selects the historical task.
        let history = if let Some(root) = &self.history {
            Some(root.task_witness(&self.native, &self.engine, &manifest.task)?)
        } else {
            NativeOfficeAcceptedTurnAuthority.validate(
                &self.native,
                &self.engine,
                &manifest.task,
            )?;
            None
        };
        let settings = self
            .engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("OFFICE_SETTINGS_UNAVAILABLE"))?;
        ensure!(
            settings
                .integrations
                .office
                .allowed_formats
                .contains(&manifest.format)
                && manifest.bytes <= settings.integrations.office.max_output_bytes,
            "OFFICE_FORMAT_UNAVAILABLE"
        );
        Ok(history)
    }

    /// Existing attachment/read and attachment/read/chunk call these only for
    /// the reserved opaque prefix. All other paths keep their current reader.
    pub(crate) async fn read_attachment(
        &self,
        native: &NativeIntegrationContext,
        params: &AttachmentReadParams,
        cancel: &CancellationToken,
    ) -> Result<AttachmentReadResult> {
        let lease = self.lookup(&params.path, &params.thread_id)?;
        ensure!(
            lease.manifest.bytes <= PREVIEW_BYTES as u64,
            "attachment preview exceeds the 256 KiB response limit"
        );
        let chunk = self
            .read_with_budget(native, lease, 0, PREVIEW_BYTES, cancel)
            .await
            .map_err(export_error)?;
        Ok(AttachmentReadResult {
            content_base64: chunk.content_base64,
            size: chunk.total_size,
        })
    }

    pub(crate) async fn read_attachment_chunk(
        &self,
        native: &NativeIntegrationContext,
        params: &AttachmentReadChunkParams,
        cancel: &CancellationToken,
    ) -> Result<AttachmentReadChunkResult> {
        ensure!(
            (1..=CHUNK_BYTES).contains(&(params.length as usize)),
            "OFFICE_INVALID_INPUT"
        );
        let lease = self.lookup(&params.path, &params.thread_id)?;
        self.read_with_budget(native, lease, params.offset, params.length as usize, cancel)
            .await
            .map_err(export_error)
    }

    pub(in crate::app_server::integrations) async fn acknowledge_export(
        &self,
        native: &NativeIntegrationContext,
        params: &kcoder_app_protocol::integrations::office::OfficeExportAcknowledgementParams,
        cancel: &CancellationToken,
    ) -> Result<VerifiedOfficeExportAcknowledgement> {
        self.check(native, cancel)?;
        let lease = self
            .transfers
            .exports
            .lock()
            .map_err(|_| anyhow::anyhow!("OFFICE_EXPORT_UNCONFIRMED"))?
            .get(&params.export_id)
            .cloned()
            .context("OFFICE_EXPORT_PROVIDER_UNAVAILABLE")?;
        let locator = format!("{PREFIX}{}:{}", params.export_id, params.lease_revision);
        let original = self.lookup(&locator, &lease.manifest.task.thread_id)?;
        ensure!(
            original.receipt.export_id == params.export_id
                && original.receipt.reference == params.reference
                && original.receipt.bytes == params.bytes
                && original.receipt.sha256 == params.sha256,
            "OFFICE_EXPORT_RECEIPT_INVALID"
        );
        let complete = original
            .read_progress
            .lock()
            .map_err(|_| anyhow::anyhow!("OFFICE_EXPORT_UNCONFIRMED"))?
            .complete()?;
        // A last-byte probe validates the original current manifest, sources
        // and export authorization again. It cannot fill a missing prefix.
        self.read_with_budget(native, original.clone(), original.receipt.bytes, 1, cancel)
            .await?;
        self.check(native, cancel)?;
        ensure!(
            complete.bytes == original.receipt.bytes && complete.sha256 == original.receipt.sha256,
            "OFFICE_EXPORT_UNCONFIRMED"
        );
        Ok(VerifiedOfficeExportAcknowledgement {
            scope: original.scope,
            manifest: original.manifest,
            export_id: original.receipt.export_id,
            bytes: complete.bytes,
            sha256: complete.sha256,
            completed_at_ms: complete.completed_at_ms,
            acknowledged_at_ms: now()?,
            source_identities: original.inputs,
        })
    }

    async fn read_with_budget(
        &self,
        native: &NativeIntegrationContext,
        lease: ExportLease,
        offset: u64,
        length: usize,
        cancel: &CancellationToken,
    ) -> Result<AttachmentReadChunkResult> {
        tokio::select! {
            result = self.read_lease(native, lease, offset, length, cancel) => result,
            _ = cancel.cancelled() => anyhow::bail!("OFFICE_CANCELLED"),
            _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => anyhow::bail!("OFFICE_TIMEOUT"),
        }
    }

    fn lookup(&self, locator: &str, thread: &str) -> Result<ExportLease> {
        ensure!(locator.len() <= 200, "OFFICE_EXPORT_RECEIPT_INVALID");
        let value = locator
            .strip_prefix(PREFIX)
            .context("OFFICE_EXPORT_RECEIPT_INVALID")?;
        let (id, revision) = value
            .split_once(':')
            .context("OFFICE_EXPORT_RECEIPT_INVALID")?;
        let leases = self
            .transfers
            .exports
            .lock()
            .map_err(|_| anyhow::anyhow!("OFFICE_HOST_UNCONFIRMED"))?;
        let lease = leases
            .get(id)
            .context("OFFICE_EXPORT_PROVIDER_UNAVAILABLE")?;
        ensure!(
            lease.scope == *self.native.scope()
                && lease.receipt.lease_revision == revision
                && lease.manifest.task.thread_id == thread
                && (self.history.is_some() || thread == self.engine.session_id())
                && now()? < lease.receipt.expires_at_ms,
            "OFFICE_EXPORT_RECEIPT_INVALID"
        );
        Ok(lease.clone())
    }

    async fn read_lease(
        &self,
        native: &NativeIntegrationContext,
        lease: ExportLease,
        offset: u64,
        length: usize,
        cancel: &CancellationToken,
    ) -> Result<AttachmentReadChunkResult> {
        self.check(native, cancel)?;
        let request = self.request(json!({"reference":lease.receipt.reference}));
        super::organization_policy::authorize_actions(
            native,
            &["read", "export"],
            &request.request_id,
        )?;
        let store = self.store()?;
        let original_history = self.check_manifest(&lease.manifest, &store)?;
        if lease.history.is_some() {
            ensure!(
                original_history == lease.history,
                "OFFICE_NATIVE_TASK_NOT_FOUND"
            );
        }
        let before = self
            .validate_sources(native, &request, &lease.manifest.source_refs, cancel)
            .await?;
        ensure!(before == lease.inputs, "OFFICE_INPUT_REVISION_MISMATCH");
        let (bytes, total) = store.read_artifact_chunk(&lease.receipt.reference, offset, length)?;
        let after = self
            .validate_sources(native, &request, &lease.manifest.source_refs, cancel)
            .await?;
        ensure!(after == before, "OFFICE_INPUT_REVISION_MISMATCH");
        self.check(native, cancel)?;
        ensure!(
            self.check_manifest(&lease.manifest, &self.store()?)? == original_history,
            "OFFICE_NATIVE_TASK_NOT_FOUND"
        );
        ensure!(
            now()? < lease.receipt.expires_at_ms,
            "OFFICE_EXPORT_RECEIPT_INVALID"
        );
        super::organization_policy::authorize_actions(
            native,
            &["read", "export"],
            &request.request_id,
        )?;
        lease
            .read_progress
            .lock()
            .map_err(|_| anyhow::anyhow!("OFFICE_EXPORT_UNCONFIRMED"))?
            .observe(offset, &bytes, total, now()?)?;
        Ok(AttachmentReadChunkResult {
            content_base64: STANDARD.encode(&bytes),
            offset,
            size: bytes.len() as u64,
            total_size: total,
            eof: offset + bytes.len() as u64 == total,
        })
    }

    /// Call only with the actual result of this connection's attachment saver,
    /// after Native dispatch has authorized Office input acceptance. No business
    /// payload supplies a path or fabricates an AttachmentSaveResult authority.
    #[cfg(test)]
    pub(crate) fn accept_staged_input(
        &self,
        native: &NativeIntegrationContext,
        staged: &AttachmentDirectories,
        saved: &AttachmentSaveResult,
        operation: &str,
        metadata: OfficeInputMetadata,
        cancel: &CancellationToken,
    ) -> Result<OfficeInputReceipt> {
        self.check(native, cancel)?;
        super::organization_policy::authorize(native, "write", operation)?;
        metadata.validate()?;
        ensure!(
            saved.stage_ref.is_none(),
            "OFFICE_INPUT_PROVIDER_UNAVAILABLE"
        );
        let path = Path::new(&saved.path);
        let file = open_owned_staged_attachment(path, staged)?;
        let parent_path = path
            .parent()
            .context("OFFICE_INPUT_UNCONFIRMED")?
            .to_path_buf();
        let filename = path
            .file_name()
            .context("OFFICE_INPUT_UNCONFIRMED")?
            .to_os_string();
        ensure!(
            filename.to_str() == Some(metadata.filename.as_str()),
            "OFFICE_INPUT_UNCONFIRMED"
        );
        let parent = PrivateDirectory::open_existing(&parent_path)?;
        parent.verify_private_directory()?;
        let identity = parent.portable_regular_handle_identity(&file)?;
        ensure!(
            parent.portable_regular_identity(&filename)? == identity,
            "OFFICE_INPUT_UNCONFIRMED"
        );
        let mut reader = file;
        let bytes = read_bounded(&mut reader, &metadata, cancel)?;
        let input_id = format!(
            "input-{}",
            hash(&serde_json::to_vec(&(native.scope(), operation))?)
        );
        let store = self.store()?;
        let mut inputs = self
            .transfers
            .inputs
            .lock()
            .map_err(|_| anyhow::anyhow!("OFFICE_HOST_UNCONFIRMED"))?;
        if let Some(previous) = inputs.get(&input_id) {
            ensure!(
                previous.identity == identity && previous.receipt.metadata == metadata,
                "OFFICE_OPERATION_CONFLICT"
            );
            ensure!(
                store
                    .read_input(&input_id)?
                    .as_ref()
                    .is_some_and(|record| record.receipt == previous.receipt),
                "OFFICE_INPUT_UNCONFIRMED"
            );
            return Ok(previous.receipt.clone());
        }
        ensure!(inputs.len() < MAX_INPUTS, "OFFICE_INPUT_CAPACITY");
        let (fresh, _) = store.begin_input_attempt(operation, &input_id, metadata)?;
        ensure!(fresh, "OFFICE_INPUT_RECONCILIATION_REQUIRED");
        self.check(native, cancel)?;
        super::organization_policy::authorize(native, "write", operation)?;
        let receipt = store.complete_input(
            operation,
            &input_id,
            bytes.len() as u64,
            &hash(&bytes),
            OfficeNativeInput {
                path: saved.path.clone(),
                stage_ref: None,
                connection_id: self.transfers.connection_id.clone(),
            },
        )?;
        inputs.insert(
            input_id,
            Arc::new(InputLease {
                scope: native.scope().clone(),
                parent,
                parent_path,
                filename,
                identity,
                receipt: receipt.clone(),
            }),
        );
        super::organization_policy::authorize(native, "write", operation)
            .map_err(|_| anyhow::anyhow!("OFFICE_INPUT_RECONCILIATION_REQUIRED"))?;
        Ok(receipt)
    }

    fn input_bytes(
        &self,
        reference: &OfficeArtifactRef,
        cancel: &CancellationToken,
    ) -> Result<(OfficeInputReceipt, Vec<u8>)> {
        ensure!(reference.revision == 1, "OFFICE_INPUT_REVISION_MISMATCH");
        if let Some(stored) =
            self.store()?
                .read_stored_input(&reference.id, 32 * 1024 * 1024, || !cancel.is_cancelled())?
        {
            return Ok(stored);
        }
        let lease = self
            .transfers
            .inputs
            .lock()
            .map_err(|_| anyhow::anyhow!("OFFICE_HOST_UNCONFIRMED"))?
            .get(&reference.id)
            .cloned()
            .context("OFFICE_INPUT_PROVIDER_UNAVAILABLE")?;
        ensure!(lease.scope == *self.native.scope(), "OFFICE_OWNER_MISMATCH");
        lease.parent.verify_private_directory()?;
        let current = PrivateDirectory::open_existing(&lease.parent_path)?;
        ensure!(
            current.directory_identity()? == lease.parent.directory_identity()?
                && current.portable_regular_identity(&lease.filename)? == lease.identity,
            "OFFICE_INPUT_UNCONFIRMED"
        );
        let record = self
            .store()?
            .read_input(&reference.id)?
            .context("OFFICE_INPUT_UNCONFIRMED")?;
        ensure!(
            record.receipt == lease.receipt && record.receipt.status == "accepted",
            "OFFICE_INPUT_UNCONFIRMED"
        );
        let mut file = current.open_single_link_regular_file(&lease.filename)?;
        let bytes = read_bounded(&mut file, &lease.receipt.metadata, cancel)?;
        ensure!(
            current.portable_regular_identity(&lease.filename)? == lease.identity,
            "OFFICE_INPUT_UNCONFIRMED"
        );
        Ok((lease.receipt.clone(), bytes))
    }
}

#[async_trait]
#[kcoder_async_box::shared]
impl NativeOfficeAssets for NativeOfficeFileAssets {
    async fn validate_sources(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        sources: &[OfficeResourceRef],
        cancel: &CancellationToken,
    ) -> Result<Vec<OfficeCanonicalInputIdentity>> {
        self.check(native, cancel)?;
        native.validate_scope(&request.scope)?;
        super::organization_policy::authorize(native, "read", &request.request_id)?;
        ensure!(sources.len() <= 128, "OFFICE_INVALID_INPUT");
        let remote_identities =
            super::super::core::remote_delegations::validate_office_source_refs(native, sources)?;
        let application_sources = sources
            .iter()
            .filter(|source| {
                matches!(
                    source.kind.as_str(),
                    "application_connection" | "application_resource" | "application_receipt"
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        let application_identities = if application_sources.is_empty() {
            Vec::new()
        } else {
            self.sources
                .as_ref()
                .context("OFFICE_SOURCE_IDENTITIES_UNAVAILABLE")?
                .validate_sources(native, request, &application_sources, cancel)
                .await?
        };
        let mut identities = Vec::with_capacity(sources.len());
        for source in sources {
            source.validate()?;
            let sha256 = match source.kind.as_str() {
                "input" => {
                    if let Some(receipt) = self
                        .store()?
                        .validate_stored_input(&source.id, || !cancel.is_cancelled())?
                    {
                        ensure!(
                            revision(source)? == receipt.revision,
                            "OFFICE_INPUT_REVISION_MISMATCH"
                        );
                        identities.push(OfficeCanonicalInputIdentity {
                            reference: source.clone(),
                            sha256: receipt.sha256.context("OFFICE_INPUT_UNCONFIRMED")?,
                        });
                        continue;
                    }
                    let (receipt, _) = self.input_bytes(
                        &OfficeArtifactRef {
                            id: source.id.clone(),
                            revision: revision(source)?,
                        },
                        cancel,
                    )?;
                    receipt.sha256.context("OFFICE_INPUT_UNCONFIRMED")?
                }
                "artifact" => {
                    let reference = OfficeArtifactRef {
                        id: source.id.clone(),
                        revision: revision(source)?,
                    };
                    let store = self.store()?;
                    let manifest = store
                        .read_artifact(&reference)?
                        .context("OFFICE_ARTIFACT_NOT_FOUND")?;
                    // A source artifact with its own resources must be checked by
                    // the caller's bounded source provider, never silently flattened.
                    ensure!(
                        manifest.source_refs.is_empty(),
                        "OFFICE_SOURCE_IDENTITIES_UNAVAILABLE"
                    );
                    store.read_artifact_chunk(&reference, 0, 1)?;
                    manifest.sha256
                }
                "dataset" => {
                    let data = self
                        .store()?
                        .read_dataset(&OfficeArtifactRef {
                            id: source.id.clone(),
                            revision: revision(source)?,
                        })?
                        .context("OFFICE_DATASET_NOT_FOUND")?;
                    ensure!(
                        data.source_refs.is_empty(),
                        "OFFICE_SOURCE_IDENTITIES_UNAVAILABLE"
                    );
                    hash(&serde_json::to_vec(&data)?)
                }
                "remote_operation" | "acp_session" | "native_remote_artifact" => remote_identities
                    .iter()
                    .find(|identity| identity.reference == *source)
                    .context("REMOTE_OFFICE_SOURCE_PAIR_REQUIRED")?
                    .sha256
                    .clone(),
                "application_connection" | "application_resource" | "application_receipt" => {
                    application_identities
                        .iter()
                        .find(|identity| identity.reference == *source)
                        .context("APPLICATION_BUSINESS_SOURCE_CHANGED")?
                        .sha256
                        .clone()
                }
                "wiki_page" | "publication" => {
                    let result = self
                        .sources
                        .as_ref()
                        .context("OFFICE_SOURCE_IDENTITIES_UNAVAILABLE")?
                        .validate_sources(native, request, std::slice::from_ref(source), cancel)
                        .await?;
                    ensure!(
                        result.len() == 1 && result[0].reference == *source,
                        "OFFICE_CANONICAL_INPUT_IDENTITY_MISMATCH"
                    );
                    result[0].validate()?;
                    result[0].sha256.clone()
                }
                _ => anyhow::bail!("OFFICE_INPUT_PROVIDER_UNAVAILABLE"),
            };
            identities.push(OfficeCanonicalInputIdentity {
                reference: source.clone(),
                sha256,
            });
        }
        self.check(native, cancel)?;
        super::organization_policy::authorize(native, "read", &request.request_id)?;
        Ok(identities)
    }

    async fn prepare_export(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        manifest: &OfficeArtifactManifest,
        bytes: Vec<u8>,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.check(native, cancel)?;
        request.validate(true)?;
        native.validate_scope(&request.scope)?;
        super::organization_policy::authorize_actions(
            native,
            &["read", "export"],
            &request.request_id,
        )?;
        let history = self.check_manifest(manifest, &self.store()?)?;
        ensure!(
            bytes.len() as u64 == manifest.bytes && hash(&bytes) == manifest.sha256,
            "OFFICE_CONTENT_CORRUPT"
        );
        let inputs = self
            .validate_sources(native, request, &manifest.source_refs, cancel)
            .await?;
        ensure!(
            self.check_manifest(manifest, &self.store()?)? == history,
            "OFFICE_NATIVE_TASK_NOT_FOUND"
        );
        self.check(native, cancel)?;
        super::organization_policy::authorize_actions(
            native,
            &["read", "export"],
            &request.request_id,
        )?;
        let operation = request
            .operation_id
            .as_ref()
            .context("OFFICE_OPERATION_REQUIRED")?;
        let mut leases = self
            .transfers
            .exports
            .lock()
            .map_err(|_| anyhow::anyhow!("OFFICE_HOST_UNCONFIRMED"))?;
        if let Some(previous) = leases
            .values()
            .find(|lease| lease.scope == request.scope && lease.operation == *operation)
        {
            ensure!(
                previous.manifest == *manifest && previous.inputs == inputs,
                "OFFICE_OPERATION_CONFLICT"
            );
            ensure!(
                now()? < previous.receipt.expires_at_ms,
                "OFFICE_EXPORT_PROVIDER_UNAVAILABLE"
            );
            return Ok(serde_json::to_value(&previous.receipt)?);
        }
        let time = now()?;
        leases.retain(|_, lease| lease.receipt.expires_at_ms > time);
        ensure!(leases.len() < MAX_LEASES, "OFFICE_INPUT_CAPACITY");
        let title = manifest
            .title
            .chars()
            .filter(|c| {
                !c.is_control()
                    && !matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
            })
            .take(120)
            .collect::<String>();
        let title = title.trim().trim_matches('.');
        let filename = format!(
            "{}.{}",
            if title.is_empty() { "result" } else { title },
            manifest.format.extension()
        );
        let receipt = OfficeExportReceipt {
            schema_version: 1,
            export_id: format!("export-{}", uuid::Uuid::new_v4()),
            reference: OfficeArtifactRef {
                id: manifest.id.clone(),
                revision: manifest.revision,
            },
            filename,
            media_type: manifest.format.media_type().into(),
            bytes: manifest.bytes,
            sha256: manifest.sha256.clone(),
            lease_revision: format!("lease-{}", uuid::Uuid::new_v4()),
            expires_at_ms: time + LEASE_MILLIS,
        };
        receipt.validate_for(manifest)?;
        // Bounded loss-of-owner memory: once saturated, result lookup fails
        // closed for absent leases instead of recreating an old expired export.
        let mut seen = self
            .transfers
            .exported_artifacts
            .lock()
            .map_err(|_| anyhow::anyhow!("OFFICE_HOST_UNCONFIRMED"))?;
        if seen.seen.len() < MAX_LEASES {
            seen.seen.insert((manifest.id.clone(), manifest.revision));
        } else {
            seen.saturated = true;
        }
        drop(seen);
        leases.insert(
            receipt.export_id.clone(),
            ExportLease {
                scope: request.scope.clone(),
                operation: operation.clone(),
                manifest: manifest.clone(),
                inputs,
                receipt: receipt.clone(),
                history,
                read_progress: Arc::new(Mutex::new(export_read_progress::ExportReadProgress::new(
                    receipt.bytes,
                    &receipt.sha256,
                )?)),
            },
        );
        Ok(serde_json::to_value(receipt)?)
    }

    async fn prepare_input(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<OfficeInputReceipt> {
        self.check(native, cancel)?;
        native.validate_scope(&request.scope)?;
        super::organization_policy::authorize(native, "read", &request.request_id)?;
        let input_id = request
            .payload
            .get("inputId")
            .and_then(Value::as_str)
            .context("OFFICE_INVALID_INPUT")?;
        if let Some(receipt) = self
            .store()?
            .validate_stored_input(input_id, || !cancel.is_cancelled())?
        {
            super::organization_policy::authorize(native, "read", &request.request_id)?;
            return Ok(receipt);
        }
        let (receipt, _) = self.input_bytes(
            &OfficeArtifactRef {
                id: input_id.into(),
                revision: 1,
            },
            cancel,
        )?;
        super::organization_policy::authorize(native, "read", &request.request_id)?;
        Ok(receipt)
    }

    async fn read_input(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        reference: &OfficeArtifactRef,
        cursor: Option<&str>,
        limit: usize,
        tool: &ToolContext,
    ) -> Result<Value> {
        let cancel = tool
            .abort_token
            .as_ref()
            .map(CancellationToken::child_token)
            .unwrap_or_default();
        self.check(native, &cancel)?;
        native.validate_scope(&request.scope)?;
        super::organization_policy::authorize(native, "read", &request.request_id)?;
        let (receipt, bytes) = self.input_bytes(reference, &cancel)?;
        let worker = Self::original_read_worker()?;
        let result = worker
            .read(
                OfficeReadHeader {
                    schema_version: 1,
                    operation: None,
                    reference: reference.clone(),
                    filename: receipt.metadata.filename,
                    byte_length: bytes.len() as u64,
                    sha256: hash(&bytes),
                    scope_sha256: hash(&serde_json::to_vec(native.scope())?),
                    cursor: cursor.map(str::to_owned),
                    limit,
                },
                bytes,
                request.timeout_ms.min(60_000),
                &cancel,
            )
            .await?;
        self.input_bytes(reference, &cancel)?;
        self.check(native, &cancel)?;
        super::organization_policy::authorize(native, "read", &request.request_id)?;
        Ok(result)
    }
}

fn revision(source: &OfficeResourceRef) -> Result<u64> {
    let value: u64 = source
        .revision
        .parse()
        .context("OFFICE_INPUT_REVISION_MISMATCH")?;
    ensure!(
        value > 0 && source.revision == value.to_string(),
        "OFFICE_INPUT_REVISION_MISMATCH"
    );
    Ok(value)
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn export_error(error: anyhow::Error) -> anyhow::Error {
    let code = error
        .chain()
        .find_map(|cause| office_public_error_code(&cause.to_string()))
        .unwrap_or("OFFICE_EXPORT_PROVIDER_UNAVAILABLE");
    anyhow::anyhow!(code)
}
fn now() -> Result<u64> {
    Ok(u64::try_from(chrono::Utc::now().timestamp_millis())?)
}
fn read_bounded(
    file: &mut std::fs::File,
    metadata: &OfficeInputMetadata,
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    ensure!(
        file.metadata()?.len() == metadata.expected_bytes,
        "OFFICE_INPUT_SIZE_MISMATCH"
    );
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.expected_bytes)?);
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        let count = file.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        ensure!(
            bytes.len().saturating_add(count) as u64 <= metadata.expected_bytes,
            "OFFICE_INPUT_SIZE_MISMATCH"
        );
        bytes.extend_from_slice(&chunk[..count]);
    }
    ensure!(
        bytes.len() as u64 == metadata.expected_bytes
            && hash(&bytes).eq_ignore_ascii_case(&metadata.expected_sha256),
        "OFFICE_INPUT_HASH_MISMATCH"
    );
    Ok(bytes)
}

#[cfg(test)]
#[path = "native_assets_tests.rs"]
mod tests;
