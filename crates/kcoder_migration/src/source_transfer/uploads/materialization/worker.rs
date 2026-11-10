use super::*;
use std::io;

impl SourceUploadMaterialization {
    pub fn run(self, mut check: impl FnMut(u64, u64) -> bool) -> Result<SourceUploadState> {
        let Self {
            store,
            material,
            operation_id,
            directory,
            manifest,
            writer,
            watermark,
        } = self;
        let mut progress = load_progress(&directory, &manifest)?;
        let result = (|| -> Result<()> {
            material.verify_authority()?;
            ensure!(
                control(&directory)?.cancelled == watermark,
                "source_upload_cancelled"
            );
            super::super::active_watermark(&directory, watermark)?;
            if let Some(receipt) = load::<ProductReceipt>(&directory, RECEIPT)? {
                verify_tree(&directory, &manifest, Some(&receipt), || Ok(()))?;
                return Ok(());
            }
            progress.stage = SourceUploadStage::Verifying;
            progress.error = None;
            save(&directory, PROGRESS, &progress)?;
            let mut guard = |bytes| -> Result<()> {
                super::super::active_watermark(&directory, watermark)?;
                ensure!(
                    check(bytes, manifest.total_bytes()),
                    "source_upload_cancelled"
                );
                material.verify_authority()?;
                Ok(())
            };
            let root = ensure_directory(&directory, &directory, "", PRODUCT)?;
            let (upload, _) = store.selected(&operation_id)?;
            let intent: Intent =
                load(&directory, INTENT)?.context("source_upload_product_recovery_required")?;
            let mut prefix = 0u64;
            for (index, entry) in manifest.manifest().files.iter().enumerate() {
                guard(progress.copied)?;
                let parts = entry.relative_path.split('/').collect::<Vec<_>>();
                let mut parent = root.duplicate_handle()?;
                for depth in 1..parts.len() {
                    guard(progress.copied)?;
                    parent = ensure_directory(
                        &directory,
                        &parent,
                        &parts[..depth].join("/"),
                        parts[depth - 1],
                    )?;
                }
                let mut file_check = |bytes| guard(progress.copied.max(prefix + bytes));
                FileCopy {
                    store: &store,
                    upload: &upload,
                    metadata: &directory,
                    parent: &parent,
                    manifest: &manifest,
                    intent: &intent,
                    index,
                    entry,
                    leaf: parts[parts.len() - 1],
                }
                .ensure(&mut file_check)?;
                prefix += entry.bytes;
                if index >= progress.files as usize {
                    progress.files = (index + 1) as u32;
                    progress.copied = prefix;
                    save(&directory, PROGRESS, &progress)?;
                }
            }
            let receipt = verify_tree(&directory, &manifest, None, || guard(progress.copied))?;
            let _commit = operation_lease(&directory, "control.lock")?;
            guard(progress.copied)?;
            exact(&directory, RECEIPT, &receipt)?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                progress.stage = SourceUploadStage::Ready;
                progress.error = None;
            }
            Err(error) => {
                progress.stage = SourceUploadStage::Failed;
                let code = error.to_string();
                progress.error = Some(if super::super::safe_error(&code) {
                    code
                } else {
                    "source_upload_product_copy_failed".into()
                });
                save(&directory, PROGRESS, &progress)?;
                return Err(error);
            }
        }
        save(&directory, PROGRESS, &progress)?;
        drop(writer);
        store.read_materialization(&operation_id, &manifest.sha256())
    }
}

fn ensure_directory(
    metadata: &PrivateDirectory,
    parent: &PrivateDirectory,
    relative: &str,
    leaf: &str,
) -> Result<PrivateDirectory> {
    let name = node_name(relative);
    let mut birth = match load::<NodeBirth>(metadata, &name)? {
        Some(birth) => birth,
        None => {
            ensure_missing(parent, leaf)?;
            let birth = NodeBirth {
                relative: relative.into(),
                staging: format!("product-dir-{}", uuid::Uuid::new_v4()),
                identity: None,
                published: false,
            };
            exact(metadata, &name, &birth)?;
            birth
        }
    };
    ensure!(
        birth.relative == relative && !birth.staging.is_empty(),
        "source_upload_product_birth_unknown"
    );
    if birth.identity.is_none() {
        ensure!(!birth.published, "source_upload_product_birth_unknown");
        ensure_missing(parent, leaf)?;
        ensure_missing(parent, &birth.staging)?;
        let child = parent.create_private_child(OsStr::new(&birth.staging))?;
        birth.identity = Some(NodeIdentity::Directory(child.directory_identity()?));
        save(metadata, &name, &birth)?;
    }
    let Some(NodeIdentity::Directory(identity)) = &birth.identity else {
        anyhow::bail!("source_upload_product_changed")
    };
    let child = match parent.open_child(OsStr::new(leaf), false) {
        Ok(child) => child,
        Err(error) if missing(&error) && !birth.published => {
            let staged = parent.open_child(OsStr::new(&birth.staging), false)?;
            ensure!(
                staged.directory_identity()? == *identity,
                "source_upload_product_changed"
            );
            parent.rename_no_replace(OsStr::new(&birth.staging), OsStr::new(leaf))?;
            staged
        }
        Err(error) => return Err(error),
    };
    child.verify_private_directory()?;
    ensure!(
        child.directory_identity()? == *identity,
        "source_upload_product_changed"
    );
    if !birth.published {
        birth.published = true;
        save(metadata, &name, &birth)?;
    }
    Ok(child)
}

fn ensure_missing(parent: &PrivateDirectory, leaf: &str) -> Result<()> {
    match parent.entry_metadata(OsStr::new(leaf)) {
        Err(error) if missing(&error) => Ok(()),
        _ => anyhow::bail!("source_upload_product_birth_unknown"),
    }
}

struct FileCopy<'a> {
    store: &'a SourceUploads,
    upload: &'a PrivateDirectory,
    metadata: &'a PrivateDirectory,
    parent: &'a PrivateDirectory,
    manifest: &'a ValidatedManifest,
    intent: &'a Intent,
    index: usize,
    entry: &'a SourceUploadFile,
    leaf: &'a str,
}
impl FileCopy<'_> {
    fn ensure(self, check: &mut dyn FnMut(u64) -> Result<()>) -> Result<()> {
        let Self {
            store,
            upload,
            metadata,
            parent,
            manifest,
            intent,
            index,
            entry,
            leaf,
        } = self;
        let name = node_name(&entry.relative_path);
        let mut birth = match load::<NodeBirth>(metadata, &name)? {
            Some(birth) => birth,
            None => {
                ensure_missing(parent, leaf)?;
                let birth = NodeBirth {
                    relative: entry.relative_path.clone(),
                    staging: String::new(),
                    identity: None,
                    published: false,
                };
                exact(metadata, &name, &birth)?;
                birth
            }
        };
        ensure!(
            birth.relative == entry.relative_path && birth.staging.is_empty(),
            "source_upload_product_changed"
        );
        let copied_now = birth.identity.is_none();
        if copied_now {
            ensure!(!birth.published, "source_upload_product_birth_unknown");
            ensure_missing(parent, leaf)?;
            let held = upload.portable_open_verified_regular(
                OsStr::new(&super::super::payload(index)),
                &intent.upload_receipt.identities[index],
            )?;
            ensure!(
                held.file().metadata()?.len() == entry.bytes,
                "source_upload_file_changed"
            );
            let mut input = CheckedReader {
                input: held.file(),
                hash: Sha256::new(),
                bytes: 0,
                expected: entry,
                check: &mut *check,
                complete: false,
            };
            parent.atomic_publish_observed_from_reader(
                OsStr::new(leaf),
                &mut input,
                false,
                || {
                    store.store.verify_authority()?;
                    ensure!(
                        held.file().metadata()?.len() == entry.bytes
                            && upload.portable_regular_identity(OsStr::new(
                                &super::super::payload(index)
                            ))? == intent.upload_receipt.identities[index],
                        "source_upload_file_changed"
                    );
                    Ok(None)
                },
                |file| {
                    birth.identity = Some(NodeIdentity::File(
                        parent.portable_regular_handle_identity(file)?,
                    ));
                    save(metadata, &name, &birth)
                },
            )?;
            ensure!(input.complete, "source_upload_product_copy_failed");
            #[cfg(test)]
            if FAIL_FILE_PUBLISH.with(|value| value.replace(false)) {
                anyhow::bail!("source_upload_fixture_lost_product_publication");
            }
        }
        let Some(NodeIdentity::File(identity)) = &birth.identity else {
            anyhow::bail!("source_upload_product_changed")
        };
        let held = parent.portable_open_verified_regular(OsStr::new(leaf), identity)?;
        ensure!(
            held.file().metadata()?.len() == entry.bytes,
            "source_upload_product_changed"
        );
        // A previously published node can be reconciled only by its actual original
        // identity and bytes; failed callbacks never authorize another copy.
        if !copied_now {
            let mut input = CheckedReader {
                input: held.file(),
                hash: Sha256::new(),
                bytes: 0,
                expected: entry,
                check: &mut *check,
                complete: false,
            };
            io::copy(&mut input, &mut io::sink())?;
            ensure!(input.complete, "source_upload_product_changed");
        }
        ensure!(
            parent.portable_regular_identity(OsStr::new(leaf))? == *identity,
            "source_upload_product_changed"
        );
        if !birth.published {
            birth.published = true;
            save(metadata, &name, &birth)?;
        }
        ensure!(
            manifest.sha256() == intent.manifest,
            "source_upload_manifest_changed"
        );
        Ok(())
    }
}

struct CheckedReader<'a> {
    input: &'a File,
    hash: Sha256,
    bytes: u64,
    expected: &'a SourceUploadFile,
    check: &'a mut dyn FnMut(u64) -> Result<()>,
    complete: bool,
}
impl Read for CheckedReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        (self.check)(self.bytes).map_err(|_| io::Error::other("source_upload_cancelled"))?;
        if output.is_empty() {
            return Ok(0);
        }
        let requested = output.len().min(SOURCE_UPLOAD_PART_BYTES);
        let count = self.input.read(&mut output[..requested])?;
        self.bytes += count as u64;
        if self.bytes > self.expected.bytes {
            return Err(io::Error::other("source_upload_file_changed"));
        }
        self.hash.update(&output[..count]);
        if count == 0 {
            if self.bytes != self.expected.bytes
                || format!("{:x}", self.hash.clone().finalize()) != self.expected.sha256
            {
                return Err(io::Error::other("source_upload_file_changed"));
            }
            self.complete = true;
        }
        Ok(count)
    }
}

#[cfg(test)]
thread_local! { pub(super) static FAIL_FILE_PUBLISH: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
