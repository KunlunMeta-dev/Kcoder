use super::*;
use kcoder_config::VerifiedPrivateLease;

/// A held execution lease acquired before a Host accepts asynchronous verification.
pub struct SourceUploadVerification {
    store: SourceUploads,
    operation_id: String,
    directory: PrivateDirectory,
    manifest: ValidatedManifest,
    writer: VerifiedPrivateLease,
    cancel_watermark: u64,
}
impl SourceUploadVerification {
    pub fn run(self, check: impl FnMut(u64, u64) -> bool) -> Result<SourceUploadState> {
        let Self {
            store,
            operation_id,
            directory,
            manifest,
            writer,
            cancel_watermark,
        } = self;
        store.finish_held(
            &operation_id,
            directory,
            manifest,
            writer,
            cancel_watermark,
            check,
        )
    }
}

impl SourceUploads {
    /// Only a completed full hash publishes Ready. Cancellation is independent of
    /// this writer, and source bytes remain private for explicit retry or later use.
    pub fn finish(
        &self,
        operation_id: &str,
        cancel_watermark: u64,
        check: impl FnMut(u64, u64) -> bool,
    ) -> Result<SourceUploadState> {
        self.prepare_verification(operation_id, cancel_watermark)?
            .run(check)
    }

    pub fn prepare_verification(
        &self,
        operation_id: &str,
        cancel_watermark: u64,
    ) -> Result<SourceUploadVerification> {
        let (directory, manifest) = self.selected(operation_id)?;
        let writer = operation_lease(&directory, "writer.lock")?;
        if load::<Receipt>(&directory, RECEIPT)?.is_none() {
            active_watermark(&directory, cancel_watermark)?;
            let progress = Self::progress(&directory, &manifest)?;
            ensure!(
                progress.stage != SourceUploadStage::Ready,
                "source_upload_recovery_required"
            );
            ensure!(
                progress
                    .files
                    .iter()
                    .zip(&manifest.manifest().files)
                    .all(|(done, file)| done.accepted == file.bytes),
                "source_upload_parts_incomplete"
            );
        }
        let store = SourceUploads {
            store: Store::reopen_existing(
                &self.store.profile,
                &self.store.identity,
                &self.store.authority,
                "browser-uploads",
            )?,
        };
        Ok(SourceUploadVerification {
            store,
            operation_id: operation_id.into(),
            directory,
            manifest,
            writer,
            cancel_watermark,
        })
    }

    fn finish_held(
        &self,
        operation_id: &str,
        directory: PrivateDirectory,
        manifest: ValidatedManifest,
        writer: VerifiedPrivateLease,
        cancel_watermark: u64,
        mut check: impl FnMut(u64, u64) -> bool,
    ) -> Result<SourceUploadState> {
        if let Some(receipt) = load::<Receipt>(&directory, RECEIPT)? {
            verify_receipt(&directory, &manifest, &receipt)?;
            drop(writer);
            return self.read(operation_id);
        }
        active_watermark(&directory, cancel_watermark)?;
        let mut progress = Self::progress(&directory, &manifest)?;
        ensure!(
            progress.stage != SourceUploadStage::Ready,
            "source_upload_recovery_required"
        );
        ensure!(
            progress
                .files
                .iter()
                .zip(&manifest.manifest().files)
                .all(|(done, file)| done.accepted == file.bytes),
            "source_upload_parts_incomplete"
        );
        progress.stage = SourceUploadStage::Verifying;
        progress.verified = 0;
        progress.verified_files = 0;
        progress.error = None;
        save(&directory, PROGRESS, &progress)?;
        let result = (|| -> Result<Receipt> {
            let mut identities = Vec::with_capacity(progress.files.len());
            for (index, entry) in manifest.manifest().files.iter().enumerate() {
                active_watermark(&directory, cancel_watermark)?;
                ensure!(
                    check(progress.verified, manifest.total_bytes()),
                    "source_upload_cancelled"
                );
                let (mut file, identity) =
                    parts::ensure_payload(&directory, &manifest, index, &progress.files[index])?;
                let start = progress.verified;
                let mut last_checkpoint = start;
                let mut checkpoint_error = None;
                let verified = fingerprint(&mut file, entry.bytes, &entry.sha256, &mut |bytes| {
                    let verified = start + bytes;
                    if active_watermark(&directory, cancel_watermark).is_err()
                        || !check(verified, manifest.total_bytes())
                    {
                        return false;
                    }
                    if verified.saturating_sub(last_checkpoint) >= 4 * 1024 * 1024 {
                        progress.verified = verified;
                        if let Err(error) = save(&directory, PROGRESS, &progress) {
                            checkpoint_error = Some(error);
                            return false;
                        }
                        last_checkpoint = verified;
                    }
                    true
                });
                if let Some(error) = checkpoint_error {
                    return Err(error);
                }
                verified?;
                ensure!(
                    directory.portable_regular_identity(OsStr::new(&payload(index)))? == identity,
                    "source_upload_file_changed"
                );
                progress.files[index].identity = Some(identity.clone());
                progress.verified = start + entry.bytes;
                progress.verified_files += 1;
                save(&directory, PROGRESS, &progress)?;
                identities.push(identity);
            }
            // This is the commit point: a later cancel may preserve this completed
            // receipt, but cannot turn an earlier cancellation into success.
            let _control = operation_lease(&directory, "control.lock")?;
            active_watermark(&directory, cancel_watermark)?;
            let receipt = Receipt {
                manifest: manifest.sha256(),
                identities,
            };
            exact(&directory, RECEIPT, &receipt)?;
            Ok(receipt)
        })();
        match result {
            Ok(_) => {
                progress.stage = SourceUploadStage::Ready;
                progress.error = None;
            }
            Err(error) => {
                progress.stage = SourceUploadStage::Failed;
                let code = error.to_string();
                progress.error = Some(if safe_error(&code) {
                    code
                } else {
                    "source_upload_verification_failed".into()
                });
                save(&directory, PROGRESS, &progress)?;
                return Err(error);
            }
        }
        save(&directory, PROGRESS, &progress)?;
        drop(writer);
        self.read(operation_id)
    }

    /// The caller owns publication. A failed/cancelled copy may have written an
    /// incomplete prefix; it must remain in an owned temporary destination.
    pub fn copy_verified_file(
        &self,
        operation_id: &str,
        index: usize,
        output: &mut impl Write,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<()> {
        let (directory, manifest) = self.selected(operation_id)?;
        let receipt: Receipt = load(&directory, RECEIPT)?.context("source_upload_not_ready")?;
        verify_receipt(&directory, &manifest, &receipt)?;
        let entry = manifest
            .manifest()
            .files
            .get(index)
            .context("source_upload_invalid_file")?;
        let identity = &receipt.identities[index];
        let held =
            directory.portable_open_verified_regular(OsStr::new(&payload(index)), identity)?;
        let mut file = held.file();
        let mut digest = Sha256::new();
        let mut bytes = 0;
        let mut buffer = [0u8; SOURCE_UPLOAD_PART_BYTES];
        loop {
            ensure!(check(bytes), "source_upload_cancelled");
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            bytes += count as u64;
            ensure!(bytes <= entry.bytes, "source_upload_file_changed");
            digest.update(&buffer[..count]);
            output.write_all(&buffer[..count])?;
        }
        ensure!(
            bytes == entry.bytes
                && format!("{:x}", digest.finalize()) == entry.sha256
                && held.file().metadata()?.len() == entry.bytes
                && directory.portable_regular_identity(OsStr::new(&payload(index)))? == *identity,
            "source_upload_file_changed"
        );
        self.store.verify_authority()?;
        Ok(())
    }
}
