use super::*;

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PayloadBirth {
    manifest: String,
    index: usize,
    identity: PortableLeaseIdentity,
}
#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingPart {
    manifest: String,
    index: usize,
    offset: u64,
    bytes: usize,
    sha256: String,
}

pub(super) fn existing_payload(
    directory: &PrivateDirectory,
    manifest: &ValidatedManifest,
    index: usize,
) -> Result<(File, PortableLeaseIdentity)> {
    let birth: PayloadBirth =
        load(directory, &proof(index))?.context("source_upload_recovery_required")?;
    ensure!(
        birth.manifest == manifest.sha256() && birth.index == index,
        "source_upload_file_changed"
    );
    let file = directory.open_read_write_file(OsStr::new(&payload(index)), false)?;
    ensure!(
        directory.portable_regular_handle_identity(&file)? == birth.identity
            && directory.portable_regular_identity(OsStr::new(&payload(index)))? == birth.identity,
        "source_upload_file_changed"
    );
    Ok((file, birth.identity))
}

pub(super) fn ensure_payload(
    directory: &PrivateDirectory,
    manifest: &ValidatedManifest,
    index: usize,
    prior: &FileProgress,
) -> Result<(File, PortableLeaseIdentity)> {
    if load::<PayloadBirth>(directory, &proof(index))?.is_none() {
        ensure!(
            prior.accepted == 0 && prior.identity.is_none(),
            "source_upload_recovery_required"
        );
        match directory.open_single_link_regular_file(OsStr::new(&payload(index))) {
            Err(error) if missing(&error) => {}
            _ => anyhow::bail!("source_upload_recovery_required"),
        }
        directory.atomic_publish_observed_from_reader(
            OsStr::new(&payload(index)),
            &mut Cursor::new(&[]),
            false,
            || Ok(None),
            |file| {
                exact(
                    directory,
                    &proof(index),
                    &PayloadBirth {
                        manifest: manifest.sha256(),
                        index,
                        identity: directory.portable_regular_handle_identity(file)?,
                    },
                )
            },
        )?;
    }
    let (file, identity) = existing_payload(directory, manifest, index)?;
    ensure!(
        prior
            .identity
            .as_ref()
            .is_none_or(|expected| expected == &identity),
        "source_upload_file_changed"
    );
    Ok((file, identity))
}

impl SourceUploads {
    /// Repeating an acknowledged part only reads its exact original bytes. A pending
    /// append may resume only when the persisted intent and every existing prefix match.
    pub fn part(
        &self,
        operation_id: &str,
        cancel_watermark: u64,
        index: usize,
        part: u32,
        data: &[u8],
    ) -> Result<SourceUploadState> {
        let (directory, manifest) = self.selected(operation_id)?;
        let writer = operation_lease(&directory, "writer.lock")?;
        let entry = manifest
            .manifest()
            .files
            .get(index)
            .context("source_upload_invalid_file")?;
        let offset = u64::from(part) * SOURCE_UPLOAD_PART_BYTES as u64;
        ensure!(
            offset < entry.bytes
                && data.len() as u64 == (entry.bytes - offset).min(SOURCE_UPLOAD_PART_BYTES as u64),
            "source_upload_invalid_part"
        );
        let end = offset + data.len() as u64;
        let mut progress = Self::progress(&directory, &manifest)?;
        let previous = progress.files[index].clone();
        if end <= previous.accepted {
            let (mut file, _) = existing_payload(&directory, &manifest, index)?;
            let mut original = vec![0u8; data.len()];
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(&mut original)?;
            ensure!(original == data, "source_upload_part_conflict");
            drop(writer);
            return self.read(operation_id);
        }
        active_watermark(&directory, cancel_watermark)?;
        ensure!(
            load::<Receipt>(&directory, RECEIPT)?.is_none(),
            "source_upload_already_ready"
        );
        ensure!(offset == previous.accepted, "source_upload_part_order");
        let intent = PendingPart {
            manifest: manifest.sha256(),
            index,
            offset,
            bytes: data.len(),
            sha256: format!("{:x}", Sha256::digest(data)),
        };
        let intent_name = format!("upload-file-{index:04}.pending.json");
        let (mut file, identity) = ensure_payload(&directory, &manifest, index, &previous)?;
        let length = file.metadata()?.len();
        ensure!(
            length >= offset && length <= end,
            "source_upload_file_changed"
        );
        let prior_intent = load::<PendingPart>(&directory, &intent_name)?;
        if let Some(prior_intent) = &prior_intent {
            // A durable intent survives even when the interrupted append wrote zero
            // bytes. Only an acknowledged earlier part may be replaced by the next.
            if prior_intent.offset == offset {
                ensure!(prior_intent == &intent, "source_upload_part_conflict");
            } else {
                ensure!(
                    prior_intent.manifest == intent.manifest
                        && prior_intent.index == index
                        && prior_intent.offset < offset
                        && prior_intent.offset.checked_add(prior_intent.bytes as u64)
                            == Some(offset),
                    "source_upload_part_conflict"
                );
            }
        }
        if length > offset {
            ensure!(
                prior_intent.as_ref() == Some(&intent),
                "source_upload_part_conflict"
            );
            let mut prefix = vec![0u8; (length - offset) as usize];
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(&mut prefix)?;
            ensure!(
                prefix == data[..prefix.len()],
                "source_upload_part_conflict"
            );
        } else {
            save(&directory, &intent_name, &intent)?;
        }
        active_watermark(&directory, cancel_watermark)?;
        file.seek(SeekFrom::Start(length))?;
        #[cfg(test)]
        if let Some(bytes) = FAIL_PART_AFTER_BYTES.with(|value| value.take()) {
            let remaining = &data[(length - offset) as usize..];
            file.write_all(&remaining[..bytes.min(remaining.len())])?;
            file.sync_all()?;
            anyhow::bail!("source_upload_fixture_lost_part_receipt");
        }
        file.write_all(&data[(length - offset) as usize..])?;
        file.sync_all()?;
        ensure!(
            file.metadata()?.len() == end
                && directory.portable_regular_handle_identity(&file)? == identity
                && directory.portable_regular_identity(OsStr::new(&payload(index)))? == identity,
            "source_upload_file_changed"
        );
        // A concurrent cancel does not erase a completed append. Its original bytes
        // and receipt remain available, but no following part can pass the watermark.
        progress.files[index] = FileProgress {
            accepted: end,
            identity: Some(identity),
        };
        progress.stage = SourceUploadStage::Receiving;
        progress.error = None;
        save(&directory, PROGRESS, &progress)?;
        drop(writer);
        self.read(operation_id)
    }
}

#[cfg(test)]
#[path = "parts_review_tests.rs"]
mod review_tests;
