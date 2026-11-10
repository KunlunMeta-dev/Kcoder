//! A target-owned product view of uploaded bytes. Ready never publishes migrated work.
use super::{SOURCE_UPLOAD_PART_BYTES, SourceUploads};
use crate::source_transfer::{
    model::{TransferAuthority, digest, valid_sha, valid_uuid},
    storage::{
        Control, Store, control, exact, load, missing, operation_lease, save, try_operation_lease,
    },
};
use crate::source_upload::manifest::ValidatedManifest;
use anyhow::{Context, Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, VerifiedPrivateLease};
use kcoder_types::migration_source_upload::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    fs::File,
    io::Read,
    path::Path,
    path::PathBuf,
};

mod binding;
mod model;
#[cfg(test)]
mod tests;
mod worker;

pub(crate) use binding::UploadedRootBinding;
use model::*;

/// Independent execution/cancellation domain; the original upload stays immutable Ready.
pub struct SourceUploadMaterialization {
    store: SourceUploads,
    material: Store,
    operation_id: String,
    directory: PrivateDirectory,
    manifest: ValidatedManifest,
    writer: VerifiedPrivateLease,
    watermark: u64,
}

impl SourceUploads {
    fn product_store(&self, create: bool) -> Result<Store> {
        self.store.sibling(ROLE, create)
    }

    fn product_intent(
        &self,
        operation_id: &str,
        expected_manifest: &str,
    ) -> Result<(ValidatedManifest, Intent)> {
        let (upload, manifest) = self.selected(operation_id)?;
        ensure!(
            manifest.sha256() == expected_manifest,
            "source_upload_manifest_changed"
        );
        let receipt: super::Receipt =
            load(&upload, super::RECEIPT)?.context("source_upload_not_ready")?;
        super::verify_receipt(&upload, &manifest, &receipt)?;
        Ok((
            manifest,
            Intent {
                version: 1,
                upload_directory: upload.directory_identity()?,
                manifest: expected_manifest.into(),
                upload_receipt: receipt,
            },
        ))
    }

    /// Explicit preparation is the only entry which may create this product namespace.
    /// Already published or interrupted operations reconcile their original intent.
    pub fn prepare_materialization(
        &self,
        operation_id: &str,
        expected_manifest: &str,
    ) -> Result<(SourceUploadState, Option<SourceUploadMaterialization>)> {
        let (manifest, intent) = self.product_intent(operation_id, expected_manifest)?;
        let (upload, _) = self.selected(operation_id)?;
        let _creating = operation_lease(&upload, "writer.lock")?;
        let mut start: ProductStart;
        let fresh = if let Some(previous) = load::<ProductStart>(&upload, START)? {
            ensure!(
                previous.version == 1 && previous.intent_sha256 == digest(&intent)?,
                "source_upload_product_binding_changed"
            );
            start = previous;
            false
        } else {
            match self.product_store(false) {
                Ok(material) => ensure!(
                    !material.has_operation(operation_id)?,
                    "source_upload_product_birth_unknown"
                ),
                Err(error) if missing(&error) => {}
                Err(error) => return Err(error),
            }
            start = ProductStart {
                version: 1,
                intent_sha256: digest(&intent)?,
                role_directory: None,
                operation_directory: None,
            };
            exact(&upload, START, &start)?;
            true
        };
        let material = self.product_store(fresh)?;
        let role_identity = material.root()?.directory_identity()?;
        if fresh {
            start.role_directory = Some(role_identity.clone());
            save(&upload, START, &start)?;
        } else {
            ensure!(
                start.role_directory.as_ref() == Some(&role_identity),
                "source_upload_product_birth_unknown"
            );
        }
        let exists = material.has_operation(operation_id)?;
        ensure!(fresh || exists, "source_upload_product_birth_unknown");
        let metadata_bytes = metadata_budget(&manifest)?;
        if fresh {
            material.reserve(operation_id, &digest(&intent)?, metadata_bytes)?;
        } else {
            let reservation: serde_json::Value =
                load(&material.root()?, &format!("reserve-{operation_id}.json"))?
                    .context("source_upload_product_recovery_required")?;
            ensure!(
                reservation
                    == serde_json::json!({"owner":material.identity,"request":operation_id,
                "binding":digest(&intent)?,"bytes":metadata_bytes}),
                "source_upload_product_binding_changed"
            );
        }
        if !exists {
            ensure!(
                fs2::available_space(&self.store.profile)?
                    >= manifest.total_bytes() + metadata_bytes,
                "source_upload_product_disk_budget"
            );
        }
        let directory = material.operation(operation_id, &digest(&intent)?, fresh)?;
        let operation_identity = directory.directory_identity()?;
        if let Some(expected) = &start.operation_directory {
            ensure!(
                expected == &operation_identity,
                "source_upload_product_birth_unknown"
            );
        } else {
            start.operation_directory = Some(operation_identity);
            save(&upload, START, &start)?;
        }
        let writer = operation_lease(&directory, "writer.lock")?;
        if fresh {
            exact(&directory, INTENT, &intent)?;
        } else {
            ensure!(
                load::<Intent>(&directory, INTENT)?.as_ref() == Some(&intent),
                "source_upload_product_recovery_required"
            );
        }
        if load::<Progress>(&directory, PROGRESS)?.is_none() {
            ensure!(!exists, "source_upload_product_recovery_required");
            save(
                &directory,
                PROGRESS,
                &Progress {
                    stage: SourceUploadStage::Prepared,
                    copied: 0,
                    files: 0,
                    error: None,
                },
            )?;
        }
        let mut state = self.product_view(
            operation_id,
            &directory,
            &manifest,
            SourceUploadWorkerState::Running,
        )?;
        if load::<ProductReceipt>(&directory, RECEIPT)?.is_some() {
            drop(writer);
            state.worker_state = SourceUploadWorkerState::Stopped;
            return Ok((state, None));
        }
        super::active_watermark(&directory, state.cancel_watermark)?;
        let lease = SourceUploadMaterialization {
            store: SourceUploads {
                store: Store::reopen_existing(
                    &self.store.profile,
                    &self.store.identity,
                    &self.store.authority,
                    "browser-uploads",
                )?,
            },
            material,
            operation_id: operation_id.into(),
            directory,
            manifest,
            writer,
            watermark: state.cancel_watermark,
        };
        Ok((state, Some(lease)))
    }

    fn selected_product(
        &self,
        operation_id: &str,
        expected_manifest: &str,
    ) -> Result<(Store, PrivateDirectory, ValidatedManifest)> {
        let (manifest, intent) = self.product_intent(operation_id, expected_manifest)?;
        let material = self.product_store(false)?;
        let directory = material.existing(operation_id)?;
        let (upload, _) = self.selected(operation_id)?;
        let start: ProductStart =
            load(&upload, START)?.context("source_upload_product_birth_unknown")?;
        ensure!(
            start.version == 1
                && start.intent_sha256 == digest(&intent)?
                && start.role_directory == Some(material.root()?.directory_identity()?)
                && start.operation_directory == Some(directory.directory_identity()?),
            "source_upload_product_birth_unknown"
        );
        ensure!(
            load::<Intent>(&directory, INTENT)?.as_ref() == Some(&intent),
            "source_upload_product_binding_changed"
        );
        Ok((material, directory, manifest))
    }

    /// No operation, role or native identity is initialized by observation.
    pub fn read_materialization(
        &self,
        operation_id: &str,
        expected_manifest: &str,
    ) -> Result<SourceUploadState> {
        let (_, directory, manifest) = self.selected_product(operation_id, expected_manifest)?;
        let observation = try_operation_lease(&directory, "writer.lock");
        let state = match &observation {
            Ok(Some(_)) => SourceUploadWorkerState::Stopped,
            Ok(None) => SourceUploadWorkerState::Running,
            Err(_) => SourceUploadWorkerState::Unknown,
        };
        self.product_view(operation_id, &directory, &manifest, state)
    }

    fn product_view(
        &self,
        operation_id: &str,
        directory: &PrivateDirectory,
        manifest: &ValidatedManifest,
        worker_state: SourceUploadWorkerState,
    ) -> Result<SourceUploadState> {
        self.store.verify_authority()?;
        let mut progress = load_progress(directory, manifest)?;
        let control = control(directory)?;
        let receipt = load::<ProductReceipt>(directory, RECEIPT)?;
        if let Some(receipt) = &receipt {
            // Publication follows all final counters. Do not mix a precommit sample
            // with an immutable completion observed a moment later.
            progress = load_progress(directory, manifest)?;
            verify_tree(directory, manifest, Some(receipt), || Ok(()))?;
            ensure!(
                progress.copied == manifest.total_bytes()
                    && progress.files as usize == manifest.manifest().files.len(),
                "source_upload_product_progress_changed"
            );
        } else {
            ensure!(
                progress.stage != SourceUploadStage::Ready,
                "source_upload_product_recovery_required"
            );
        }
        let cancelled = control.cancelled != control.acknowledged;
        let stage = if receipt.is_some() {
            SourceUploadStage::Ready
        } else if cancelled && worker_state == SourceUploadWorkerState::Stopped {
            SourceUploadStage::Cancelled
        } else if cancelled {
            SourceUploadStage::CancelRequested
        } else {
            progress.stage
        };
        Ok(SourceUploadState {
            operation_id: operation_id.into(),
            manifest_sha256: manifest.sha256(),
            source: manifest.manifest().source,
            stage,
            sequence: control.sequence,
            cancel_watermark: control.cancelled,
            cancel_requested: cancelled,
            worker_state,
            total_files: manifest.manifest().files.len() as u32,
            completed_files: progress.files,
            total_bytes: manifest.total_bytes(),
            received_bytes: manifest.total_bytes(),
            verified_bytes: progress.copied,
            error_code: progress.error,
        })
    }

    pub fn cancel_materialization(
        &self,
        operation_id: &str,
        expected_manifest: &str,
        command_id: &str,
    ) -> Result<SourceUploadState> {
        valid_uuid(command_id)?;
        let (_, directory, _) = self.selected_product(operation_id, expected_manifest)?;
        let controller = operation_lease(&directory, "control.lock")?;
        if load::<ProductReceipt>(&directory, RECEIPT)?.is_none() {
            let mut control = control(&directory)?;
            if !control.commands.iter().any(|command| command == command_id) {
                ensure!(
                    control.commands.len() < 256,
                    "source_transfer_command_limit"
                );
                control.cancelled = control
                    .cancelled
                    .checked_add(1)
                    .context("source_transfer_revision_exhausted")?;
                control.sequence = control
                    .sequence
                    .checked_add(1)
                    .context("source_transfer_revision_exhausted")?;
                control.commands.push(command_id.into());
                save(&directory, "control.json", &control)?;
            }
        }
        drop(controller);
        self.read_materialization(operation_id, expected_manifest)
    }

    pub fn resume_materialization(
        &self,
        operation_id: &str,
        expected_manifest: &str,
        sequence: u64,
        watermark: u64,
    ) -> Result<SourceUploadState> {
        let (_, directory, manifest) = self.selected_product(operation_id, expected_manifest)?;
        let writer = operation_lease(&directory, "writer.lock")?;
        let controller = operation_lease(&directory, "control.lock")?;
        if load::<ProductReceipt>(&directory, RECEIPT)?.is_none() {
            let mut control: Control = control(&directory)?;
            ensure!(
                control.sequence == sequence && control.cancelled == watermark,
                "source_transfer_revision_conflict"
            );
            control.acknowledged = watermark;
            control.sequence = control
                .sequence
                .checked_add(1)
                .context("source_transfer_revision_exhausted")?;
            save(&directory, "control.json", &control)?;
            let mut progress = load_progress(&directory, &manifest)?;
            progress.stage = SourceUploadStage::Prepared;
            progress.error = None;
            save(&directory, PROGRESS, &progress)?;
        }
        drop(controller);
        drop(writer);
        self.read_materialization(operation_id, expected_manifest)
    }

    /// A native-only registry, never a public path or assertion about the browser's OS.
    pub fn product_registry(
        &self,
        operation_id: &str,
        expected_manifest: &str,
    ) -> Result<crate::discovery::SourceRegistry> {
        let (material, directory, manifest) =
            self.selected_product(operation_id, expected_manifest)?;
        let receipt: ProductReceipt =
            load(&directory, RECEIPT)?.context("source_upload_product_not_ready")?;
        verify_tree(&directory, &manifest, Some(&receipt), || Ok(()))?;
        let binding = UploadedRootBinding::capture(
            self,
            &material,
            operation_id,
            manifest.sha256(),
            receipt,
        )?;
        crate::discovery::SourceRegistry::from_uploaded_product(binding)
    }
}
