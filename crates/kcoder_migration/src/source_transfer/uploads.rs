//! Private user-supplied bytes reuse Native operation birth, quotas and cancellation leases.
use super::{model::*, storage::*};
use crate::source_upload::manifest::{ValidatedManifest, validate_manifest};
use anyhow::{Context, Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use kcoder_types::migration_source_upload::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::File,
    io::{Cursor, Read, Seek, SeekFrom, Write},
    path::Path,
};

#[cfg(test)]
mod control_tests;
mod materialization;
mod parts;
pub use materialization::SourceUploadMaterialization;
pub(crate) use materialization::UploadedRootBinding;
#[cfg(test)]
mod tests;
mod verification;
pub use verification::SourceUploadVerification;

pub const SOURCE_UPLOAD_PART_BYTES: usize = 128 * 1024;
const MANIFEST: &str = "upload-manifest.json";
const PROGRESS: &str = "upload-progress.json";
const RECEIPT: &str = "upload-receipt.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileProgress {
    accepted: u64,
    identity: Option<PortableLeaseIdentity>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Progress {
    stage: SourceUploadStage,
    verified: u64,
    verified_files: u32,
    files: Vec<FileProgress>,
    error: Option<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    manifest: String,
    identities: Vec<PortableLeaseIdentity>,
}

pub struct SourceUploads {
    store: Store,
}

impl SourceUploads {
    pub fn open(profile: &Path) -> Result<Self> {
        Ok(Self {
            store: Store::open(profile, "browser-uploads")?,
        })
    }
    /// Read-only recovery never initializes a profile, namespace, identity or operation.
    pub fn open_existing(profile: &Path) -> Result<Self> {
        Ok(Self {
            store: Store::open_existing(profile, "browser-uploads")?,
        })
    }
    pub fn prepare(
        &self,
        operation_id: &str,
        manifest: SourceUploadManifest,
    ) -> Result<SourceUploadState> {
        self.store.require_creation()?;
        valid_uuid(operation_id)?;
        let manifest = validate_manifest(manifest)?;
        let digest = manifest.sha256();
        // Reserve room for the immutable upload and later Native snapshot materialization.
        self.store
            .reserve(operation_id, &digest, manifest.total_bytes() * 2)?;
        let root = self.store.root()?;
        let _creation = lease(&root, "upload-create.lock")?;
        let existed = self.store.has_operation(operation_id)?;
        if !existed {
            ensure!(
                fs2::available_space(&self.store.profile)?
                    >= manifest.total_bytes() * 2 + 1024 * 1024,
                "source_upload_disk_budget"
            );
        }
        let directory = self.store.operation(operation_id, &digest, true)?;
        let writer = operation_lease(&directory, "writer.lock")?;
        exact(&directory, MANIFEST, manifest.manifest())?;
        if load::<Progress>(&directory, PROGRESS)?.is_none() {
            ensure!(!existed, "source_upload_recovery_required");
            save(
                &directory,
                PROGRESS,
                &Progress {
                    stage: SourceUploadStage::Prepared,
                    verified: 0,
                    verified_files: 0,
                    files: manifest
                        .manifest()
                        .files
                        .iter()
                        .map(|_| FileProgress {
                            accepted: 0,
                            identity: None,
                        })
                        .collect(),
                    error: None,
                },
            )?;
        }
        drop(writer);
        self.read(operation_id)
    }
    fn selected(&self, operation_id: &str) -> Result<(PrivateDirectory, ValidatedManifest)> {
        let directory = self.store.existing(operation_id)?;
        let manifest = validate_manifest(
            load(&directory, MANIFEST)?.context("source_upload_recovery_required")?,
        )?;
        let anchor: Anchor =
            load(&directory, "binding.json")?.context("source_upload_recovery_required")?;
        ensure!(
            anchor.binding == manifest.sha256(),
            "source_upload_manifest_changed"
        );
        Ok((directory, manifest))
    }
    pub fn read(&self, operation_id: &str) -> Result<SourceUploadState> {
        let (directory, manifest) = self.selected(operation_id)?;
        let observation = try_operation_lease(&directory, "writer.lock");
        let state = match &observation {
            Ok(Some(_)) => SourceUploadWorkerState::Stopped,
            Ok(None) => SourceUploadWorkerState::Running,
            Err(_) => SourceUploadWorkerState::Unknown,
        };
        // Keep the free writer held until progress/control have been sampled together.
        self.view(operation_id, &directory, &manifest, state)
    }
    fn progress(directory: &PrivateDirectory, manifest: &ValidatedManifest) -> Result<Progress> {
        let progress: Progress =
            load(directory, PROGRESS)?.context("source_upload_recovery_required")?;
        ensure!(
            progress.files.len() == manifest.manifest().files.len()
                && progress.verified <= manifest.total_bytes()
                && progress.verified_files as usize <= progress.files.len()
                && progress
                    .files
                    .iter()
                    .zip(&manifest.manifest().files)
                    .all(|(done, file)| done.accepted <= file.bytes
                        && (done.accepted == 0 || done.identity.is_some()))
                && progress
                    .error
                    .as_ref()
                    .is_none_or(|value| safe_error(value)),
            "source_upload_invalid_progress"
        );
        Ok(progress)
    }
    fn view(
        &self,
        operation_id: &str,
        directory: &PrivateDirectory,
        manifest: &ValidatedManifest,
        worker_state: SourceUploadWorkerState,
    ) -> Result<SourceUploadState> {
        self.store.verify_authority()?;
        let mut progress = Self::progress(directory, manifest)?;
        #[cfg(test)]
        VIEW_AFTER_PROGRESS.with(|callback| {
            let callback = callback.borrow_mut().take();
            if let Some(callback) = callback {
                callback();
            }
        });
        let control = control(directory)?;
        let receipt = load::<Receipt>(directory, RECEIPT)?;
        // A running writer may publish after our first sample. The immutable
        // receipt follows the final counters, so resample after observing it.
        if receipt.is_some() {
            progress = Self::progress(directory, manifest)?;
        }
        ensure!(
            progress.stage != SourceUploadStage::Ready || receipt.is_some(),
            "source_upload_recovery_required"
        );
        if let Some(receipt) = &receipt {
            verify_receipt(directory, manifest, receipt)?;
            ensure!(
                progress.verified == manifest.total_bytes()
                    && progress.verified_files as usize == progress.files.len()
                    && progress
                        .files
                        .iter()
                        .zip(&manifest.manifest().files)
                        .zip(&receipt.identities)
                        .all(|((done, file), identity)| done.accepted == file.bytes
                            && done.identity.as_ref() == Some(identity)),
                "source_upload_invalid_progress"
            );
        }
        let cancelled = control.cancelled != control.acknowledged;
        let stage = if receipt.is_some() {
            SourceUploadStage::Ready
        } else if cancelled {
            if worker_state == SourceUploadWorkerState::Stopped {
                SourceUploadStage::Cancelled
            } else {
                SourceUploadStage::CancelRequested
            }
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
            total_files: progress.files.len() as u32,
            completed_files: progress.verified_files,
            total_bytes: manifest.total_bytes(),
            received_bytes: progress.files.iter().map(|file| file.accepted).sum(),
            verified_bytes: progress.verified,
            error_code: progress.error,
        })
    }
    pub fn cancel(&self, operation_id: &str, command_id: &str) -> Result<SourceUploadState> {
        valid_uuid(command_id)?;
        let (directory, _) = self.selected(operation_id)?;
        let controller = operation_lease(&directory, "control.lock")?;
        // The receipt and cancellation share the same commit lock. Sampling the
        // receipt before this lease could cancel an already completed upload.
        if load::<Receipt>(&directory, RECEIPT)?.is_none() {
            let mut value = control(&directory)?;
            if !value.commands.iter().any(|existing| existing == command_id) {
                ensure!(value.commands.len() < 256, "source_transfer_command_limit");
                value.cancelled = value
                    .cancelled
                    .checked_add(1)
                    .context("source_transfer_revision_exhausted")?;
                value.sequence = value
                    .sequence
                    .checked_add(1)
                    .context("source_transfer_revision_exhausted")?;
                value.commands.push(command_id.into());
                save(&directory, "control.json", &value)?;
            }
        }
        drop(controller);
        self.read(operation_id)
    }
    pub fn resume(
        &self,
        operation_id: &str,
        sequence: u64,
        cancel_watermark: u64,
    ) -> Result<SourceUploadState> {
        let (directory, _) = self.selected(operation_id)?;
        let writer = operation_lease(&directory, "writer.lock")?;
        let controller = operation_lease(&directory, "control.lock")?;
        if load::<Receipt>(&directory, RECEIPT)?.is_none() {
            let mut value = control(&directory)?;
            ensure!(
                value.sequence == sequence && value.cancelled == cancel_watermark,
                "source_transfer_revision_conflict"
            );
            value.acknowledged = cancel_watermark;
            value.sequence = value
                .sequence
                .checked_add(1)
                .context("source_transfer_revision_exhausted")?;
            save(&directory, "control.json", &value)?;
        }
        drop(controller);
        drop(writer);
        self.read(operation_id)
    }
    pub fn manifest(&self, operation_id: &str) -> Result<SourceUploadManifest> {
        Ok(self.selected(operation_id)?.1.manifest().clone())
    }

    /// Only accepted receipts are resumable offsets. A partially written pending
    /// part stays at its old offset until the original bytes reconcile it.
    pub fn files(&self, operation_id: &str, cursor: Option<u32>) -> Result<SourceUploadFilePage> {
        let (directory, manifest) = self.selected(operation_id)?;
        let progress = Self::progress(&directory, &manifest)?;
        let start = cursor.unwrap_or(0) as usize;
        ensure!(
            start <= progress.files.len(),
            "source_upload_invalid_cursor"
        );
        let end = (start + 10).min(progress.files.len());
        let files = (start..end)
            .map(|index| {
                let accepted = progress.files[index].accepted;
                SourceUploadFileProgress {
                    file_index: index as u32,
                    accepted_bytes: accepted,
                    next_part: accepted.div_ceil(SOURCE_UPLOAD_PART_BYTES as u64) as u32,
                    complete: accepted == manifest.manifest().files[index].bytes,
                }
            })
            .collect();
        self.store.verify_authority()?;
        Ok(SourceUploadFilePage {
            operation_id: operation_id.into(),
            manifest_sha256: manifest.sha256(),
            files,
            next_cursor: (end < progress.files.len()).then_some(end as u32),
        })
    }
}

fn payload(index: usize) -> String {
    format!("upload-file-{index:04}.bin")
}
fn proof(index: usize) -> String {
    format!("upload-file-{index:04}.proof.json")
}
fn safe_error(value: &str) -> bool {
    value.len() < 128
        && value
            .bytes()
            .all(|ch| ch.is_ascii_lowercase() || ch == b'_' || ch.is_ascii_digit())
        && (value.starts_with("source_upload_") || value.starts_with("source_transfer_"))
}
fn active_watermark(directory: &PrivateDirectory, expected: u64) -> Result<()> {
    let state = control(directory)?;
    ensure!(
        state.cancelled == expected && state.cancelled == state.acknowledged,
        "source_upload_cancelled"
    );
    Ok(())
}
fn verify_receipt(
    directory: &PrivateDirectory,
    manifest: &ValidatedManifest,
    receipt: &Receipt,
) -> Result<()> {
    ensure!(
        receipt.manifest == manifest.sha256()
            && receipt.identities.len() == manifest.manifest().files.len(),
        "source_upload_receipt_changed"
    );
    for (index, (file, identity)) in manifest
        .manifest()
        .files
        .iter()
        .zip(&receipt.identities)
        .enumerate()
    {
        let held =
            directory.portable_open_verified_regular(OsStr::new(&payload(index)), identity)?;
        ensure!(
            held.file().metadata()?.len() == file.bytes,
            "source_upload_file_changed"
        );
    }
    Ok(())
}

#[cfg(test)]
thread_local! { static FAIL_PART_AFTER_BYTES: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) }; }
#[cfg(test)]
thread_local! { static VIEW_AFTER_PROGRESS: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) }; }
