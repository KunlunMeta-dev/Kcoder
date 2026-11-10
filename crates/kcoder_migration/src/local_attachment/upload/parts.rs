use super::*;
fn leaf(index: u32, suffix: &str) -> String {
    format!("part-{index:04}.{suffix}")
}
pub(super) fn count(manifest: &Manifest) -> u32 {
    manifest
        .bytes
        .div_ceil(u64::from(HISTORICAL_LOCAL_UPLOAD_PART_BYTES)) as u32
}
pub(super) fn expected_size(manifest: &Manifest, index: u32) -> Result<u64> {
    ensure!(index < count(manifest), "local_upload_invalid_part");
    Ok(
        (manifest.bytes - u64::from(index) * u64::from(HISTORICAL_LOCAL_UPLOAD_PART_BYTES))
            .min(u64::from(HISTORICAL_LOCAL_UPLOAD_PART_BYTES)),
    )
}
pub(super) fn verify_file(
    directory: &PrivateDirectory,
    name: &str,
    bytes: u64,
    sha: &str,
    mut check: impl FnMut(u64) -> bool,
) -> Result<String> {
    let mut file = directory.open_single_link_regular_file(OsStr::new(name))?;
    let identity = file_identity(&file)?;
    ensure!(
        file.metadata()?.len() == bytes,
        "local_upload_content_changed"
    );
    let mut hash = Sha256::new();
    let mut done = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        ensure!(check(done), "local_upload_cancelled");
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        done += n as u64;
        ensure!(done <= bytes, "local_upload_content_changed");
        hash.update(&buffer[..n]);
    }
    ensure!(
        done == bytes
            && format!("{:x}", hash.finalize()) == sha
            && file_identity(&file)? == identity,
        "local_upload_content_changed"
    );
    ensure!(
        file_identity(&directory.open_single_link_regular_file(OsStr::new(name))?)? == identity,
        "local_upload_content_changed"
    );
    Ok(identity)
}
impl Operation<'_> {
    pub fn receipts(&self, manifest: Option<&Manifest>) -> Result<(u32, u64)> {
        let Some(manifest) = manifest else {
            return Ok((0, 0));
        };
        let parts = self.parts_dir()?;
        let fingerprint = hash(manifest)?;
        let mut received = 0;
        let mut bytes = 0;
        for index in 0..count(manifest) {
            let Some(receipt) = load::<PartReceipt>(&parts, &leaf(index, "receipt.json"))? else {
                break;
            };
            ensure!(
                receipt.part.index == index
                    && receipt.part.manifest == fingerprint
                    && valid_sha(&receipt.part.sha256)
                    && receipt.part.bytes == expected_size(manifest, index)?,
                "local_upload_part_changed"
            );
            let file = parts.open_single_link_regular_file(OsStr::new(&leaf(index, "bin")))?;
            ensure!(
                file_identity(&file)? == receipt.identity,
                "local_upload_part_changed"
            );
            received += 1;
            bytes += receipt.part.bytes;
        }
        Ok((received, bytes))
    }
    pub fn clean_parts(&self, manifest: &Manifest) -> Result<()> {
        let parts = self.parts_dir()?;
        parts.visit_entry_names_bounded(count(manifest) as usize * 4 + 1, |name| {
            let valid = name.to_str().is_some_and(|name| {
                name.strip_prefix("part-")
                    .and_then(|name| name.split_once('.'))
                    .is_some_and(|(index, suffix)| {
                        index.len() == 4
                            && index
                                .parse::<u32>()
                                .is_ok_and(|index| index < count(manifest))
                            && matches!(
                                suffix,
                                "bin" | "intent.json" | "receipt.json" | "bin.proof.json"
                            )
                    })
            });
            ensure!(valid, "local_upload_recovery_required");
            Ok(())
        })
    }
}
impl HistoryLocalAttachmentUploads {
    /// Only an exact already published part may reconcile an old sequence without writing.
    pub fn part(
        &self,
        operation_id: &str,
        sequence: u64,
        index: u32,
        data: &[u8],
    ) -> Result<HistoricalLocalAttachmentUpload> {
        let op = self.operation(operation_id, true)?;
        let manifest = op.manifest()?.context("local_upload_not_begun")?;
        ensure!(
            data.len() as u64 == expected_size(&manifest, index)?,
            "local_upload_invalid_part"
        );
        let part = Part {
            index,
            bytes: data.len() as u64,
            sha256: format!("{:x}", Sha256::digest(data)),
            manifest: hash(&manifest)?,
        };
        let parts = op.parts_dir()?;
        op.clean_parts(&manifest)?;
        if let Some(receipt) = load::<PartReceipt>(&parts, &leaf(index, "receipt.json"))? {
            ensure!(receipt.part == part, "local_upload_part_conflict");
            ensure!(
                verify_file(
                    &parts,
                    &leaf(index, "bin"),
                    part.bytes,
                    &part.sha256,
                    |_| true
                )? == receipt.identity,
                "local_upload_part_changed"
            );
            return op.view();
        }
        op.check_sequence(sequence)?;
        op.allow()?;
        ensure!(
            op.receipts(Some(&manifest))?.0 == index,
            "local_upload_part_order"
        );
        ensure!(
            load::<Authorization>(&op.directory, "authorization.json")?.is_none(),
            "local_upload_already_authorized"
        );
        let mut progress = op.progress()?;
        progress.stage = Stage::Receiving;
        progress.error = None;
        op.checkpoint(&mut progress)?;
        exact(&parts, &leaf(index, "intent.json"), &part)?;
        let name = leaf(index, "bin");
        match parts.open_single_link_regular_file(OsStr::new(&name)) {
            Ok(_) => {}
            Err(error) if missing(&error) => {
                parts.atomic_publish_observed_from_reader(
                    OsStr::new(&name),
                    &mut Cursor::new(data),
                    false,
                    || {
                        op.allow()?;
                        Ok(None)
                    },
                    |file| {
                        if op.grant.version == 3 {
                            op.append_file_proof(&format!("parts/{name}"), file)?;
                        }
                        Ok(())
                    },
                )?;
            }
            Err(error) => return Err(error),
        }
        let identity = verify_file(&parts, &name, part.bytes, &part.sha256, |_| {
            op.allow().is_ok()
        })?;
        exact(
            &parts,
            &leaf(index, "receipt.json"),
            &PartReceipt { part, identity },
        )?;
        let control = op.control()?;
        if control.revision > control.acknowledged {
            progress.stage = Stage::Cancelled;
            progress.cancel_watermark = control.revision;
            progress.error = Some("local_upload_cancelled".into());
        }
        op.checkpoint(&mut progress)?;
        op.view()
    }
}
