use super::parts::{count, verify_file};
use super::*;
struct PartsReader<'a, F> {
    directory: PrivateDirectory,
    manifest: &'a Manifest,
    index: u32,
    file: Option<File>,
    receipt: Option<PartReceipt>,
    part_hash: Sha256,
    total_hash: Sha256,
    bytes: u64,
    part_bytes: u64,
    check: F,
    complete: bool,
}
impl<F: FnMut(u64) -> bool> Read for PartsReader<'_, F> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if out.is_empty() || self.complete {
            return Ok(0);
        }
        let result: Result<usize> = (|| {
            ensure!((self.check)(self.bytes), "local_upload_cancelled");
            loop {
                if self.file.is_none() {
                    if self.index == count(self.manifest) {
                        ensure!(
                            self.bytes == self.manifest.bytes
                                && format!("{:x}", self.total_hash.clone().finalize())
                                    == self.manifest.sha256,
                            "local_upload_content_changed"
                        );
                        self.complete = true;
                        return Ok(0);
                    }
                    let receipt: PartReceipt = load(
                        &self.directory,
                        &format!("part-{:04}.receipt.json", self.index),
                    )?
                    .context("local_upload_incomplete")?;
                    ensure!(
                        receipt.part.index == self.index
                            && receipt.part.manifest == hash(self.manifest)?
                            && receipt.part.bytes
                                == parts::expected_size(self.manifest, self.index)?,
                        "local_upload_part_changed"
                    );
                    let file =
                        self.directory
                            .open_single_link_regular_file(OsStr::new(&format!(
                                "part-{:04}.bin",
                                self.index
                            )))?;
                    ensure!(
                        file_identity(&file)? == receipt.identity,
                        "local_upload_part_changed"
                    );
                    self.file = Some(file);
                    self.receipt = Some(receipt);
                    self.part_hash = Sha256::new();
                    self.part_bytes = 0;
                }
                let file = self.file.as_mut().context("local_upload_incomplete")?;
                let limit = out.len().min(64 * 1024);
                let n = file.read(&mut out[..limit])?;
                if n != 0 {
                    self.bytes += n as u64;
                    self.part_bytes += n as u64;
                    ensure!(
                        self.bytes <= self.manifest.bytes
                            && self.part_bytes <= self.receipt.as_ref().unwrap().part.bytes,
                        "local_upload_content_changed"
                    );
                    self.part_hash.update(&out[..n]);
                    self.total_hash.update(&out[..n]);
                    return Ok(n);
                }
                let receipt = self.receipt.take().context("local_upload_incomplete")?;
                ensure!(
                    self.part_bytes == receipt.part.bytes
                        && format!("{:x}", self.part_hash.clone().finalize())
                            == receipt.part.sha256
                        && file_identity(file)? == receipt.identity,
                    "local_upload_part_changed"
                );
                ensure!(
                    file_identity(&self.directory.open_single_link_regular_file(OsStr::new(
                        &format!("part-{:04}.bin", self.index)
                    ))?)?
                        == receipt.identity,
                    "local_upload_part_changed"
                );
                self.file = None;
                self.index += 1;
            }
        })();
        result.map_err(std::io::Error::other)
    }
}
impl Operation<'_> {
    pub(super) fn clean_assembly(&self) -> Result<()> {
        self.clean_assembly_with(|_| Ok(false))
    }
    pub(super) fn clean_assembly_with(
        &self,
        mut extra: impl FnMut(&OsStr) -> Result<bool>,
    ) -> Result<()> {
        self.directory.visit_entry_names_bounded(48, |name| {
            let allowed = name.to_str().is_some_and(|name| {
                matches!(
                    name,
                    "grant.json"
                        | "state.json"
                        | "control.json"
                        | "writer.lock"
                        | "control.lock"
                        | "parts"
                        | "manifest.json"
                        | "assembly.json"
                        | "assembled.json"
                        | "authorization.json"
                        | "selection.json"
                        | "payload.bin"
                        | "source-reference.json"
                        | "source-retired.json"
                        | "collection-control.lock"
                        | "collection-writer.lock"
                        | "collection.json"
                        | "collection-complete.json"
                        | "payload.bin.proof.json"
                )
            });
            let plan = match name.to_str() {
                Some(name) => self.registered_plan_file(name)?,
                None => false,
            };
            ensure!(
                allowed || plan || extra(name)?,
                "local_upload_recovery_required"
            );
            Ok(())
        })
    }
    fn assemble(
        &self,
        manifest: &Manifest,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<Assembled> {
        self.clean_parts(manifest)?;
        self.clean_assembly()?;
        let assembly = Assembly {
            manifest: hash(manifest)?,
            bytes: manifest.bytes,
            sha256: manifest.sha256.clone(),
        };
        exact(&self.directory, "assembly.json", &assembly)?;
        if let Some(assembled) = load::<Assembled>(&self.directory, "assembled.json")? {
            ensure!(
                assembled.assembly == assembly,
                "local_upload_manifest_changed"
            );
            ensure!(
                verify_file(
                    &self.directory,
                    "payload.bin",
                    manifest.bytes,
                    &manifest.sha256,
                    &mut check
                )? == assembled.identity,
                "local_upload_payload_changed"
            );
            return Ok(assembled);
        }
        match self
            .directory
            .open_single_link_regular_file(OsStr::new("payload.bin"))
        {
            Ok(_) => {}
            Err(error) if missing(&error) => {
                let mut reader = PartsReader {
                    directory: self.parts_dir()?,
                    manifest,
                    index: 0,
                    file: None,
                    receipt: None,
                    part_hash: Sha256::new(),
                    total_hash: Sha256::new(),
                    bytes: 0,
                    part_bytes: 0,
                    check: &mut check,
                    complete: false,
                };
                let bytes = self.directory.atomic_publish_observed_from_reader(
                    OsStr::new("payload.bin"),
                    &mut reader,
                    false,
                    || {
                        self.allow()?;
                        Ok(None)
                    },
                    |file| {
                        if self.grant.version == 3 {
                            self.append_file_proof("payload.bin", file)?;
                        }
                        Ok(())
                    },
                )?;
                ensure!(bytes == manifest.bytes, "local_upload_content_changed");
            }
            Err(error) => return Err(error),
        }
        let identity = verify_file(
            &self.directory,
            "payload.bin",
            manifest.bytes,
            &manifest.sha256,
            &mut check,
        )?;
        let assembled = Assembled { assembly, identity };
        exact(&self.directory, "assembled.json", &assembled)?;
        Ok(assembled)
    }
}
fn code(error: &anyhow::Error) -> &'static str {
    for cause in error.chain() {
        match cause.to_string().as_str() {
            "local_upload_cancelled" | "local_attachment_cancelled" => {
                return "local_upload_cancelled";
            }
            "local_upload_content_changed"
            | "local_upload_part_changed"
            | "local_upload_payload_changed" => return "local_upload_content_changed",
            "local_upload_authorization_unknown" => return "local_upload_authorization_unknown",
            _ => {}
        }
    }
    "local_upload_outcome_unknown"
}
impl HistoryLocalAttachmentUploads {
    /// Assemble and authorize only. Copying into the native attachment store remains explicit.
    pub fn finish(
        &self,
        operation_id: &str,
        sequence: u64,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalLocalAttachmentUpload> {
        let op = self.operation(operation_id, true)?;
        if op.native_job()?.is_some() {
            return op.view();
        }
        op.check_sequence(sequence)?;
        op.allow()?;
        let manifest = op.manifest()?.context("local_upload_not_begun")?;
        ensure!(
            op.receipts(Some(&manifest))?.0 == count(&manifest),
            "local_upload_incomplete"
        );
        let mut progress = op.progress()?;
        progress.stage = Stage::Assembling;
        progress.error = None;
        progress.bytes = 0;
        op.checkpoint(&mut progress)?;
        let mut callback_error: Option<anyhow::Error> = None;
        let result: Result<()> = {
            let mut poll = |bytes: u64| -> bool {
                let result: Result<bool> = (|| {
                    op.allow()?;
                    if !check(bytes) {
                        return Ok(false);
                    }
                    if bytes.saturating_sub(progress.bytes) >= 1024 * 1024 {
                        progress.bytes = bytes;
                        op.checkpoint(&mut progress)?;
                    }
                    Ok(true)
                })();
                match result {
                    Ok(allowed) => allowed,
                    Err(error) => {
                        callback_error = Some(error);
                        false
                    }
                }
            };
            (|| {
                let request = op.grant.frozen.reopen(&self.root, &mut poll)?;
                let previous = load::<Authorization>(&op.directory, "authorization.json")?;
                let assembled = op.assemble(&manifest, &mut poll)?;
                let path = self
                    .root
                    .join("migrations/local-attachment-uploads")
                    .join(operation_id);
                let selected = match SelectedLocalFile::reopen_staged_upload(
                    &path,
                    &op.directory,
                    manifest.bytes,
                    &manifest.sha256,
                    &mut poll,
                )? {
                    Some(selected) => selected,
                    None => {
                        ensure!(previous.is_none(), "local_upload_authorization_unknown");
                        let selected = SelectedLocalFile::select_staged_upload(
                            &path,
                            &op.directory,
                            manifest.bytes,
                            &manifest.sha256,
                            &mut poll,
                        )?;
                        selected.persist_staged_upload(&op.directory)?;
                        selected
                    }
                };
                let authorization = Authorization {
                    assembled,
                    selection_revision: selected.revision()?,
                };
                exact(&op.directory, "authorization.json", &authorization)?;
                ensure!(poll(manifest.bytes), "local_upload_cancelled");
                let local = HistoryLocalAttachments::open(&self.root)?;
                local.authorize_with_cancel(operation_id, &request, &selected, &mut poll)?;
                let control = op.control()?;
                if control.revision > control.acknowledged {
                    local.cancel(operation_id)?;
                }
                Ok(())
            })()
        };
        match result {
            Ok(()) => {
                progress.stage = Stage::Authorized;
                progress.bytes = manifest.bytes;
                progress.error = None;
            }
            Err(error) => {
                let error = callback_error.as_ref().unwrap_or(&error);
                let failure = code(error);
                progress.cancel_watermark = op.control()?.revision;
                progress.stage = if failure == "local_upload_cancelled"
                    && load::<Authorization>(&op.directory, "authorization.json")?.is_none()
                {
                    Stage::Cancelled
                } else if failure == "local_upload_content_changed" {
                    Stage::Failed
                } else {
                    Stage::OutcomeUnknown
                };
                progress.error = Some(failure.into());
            }
        }
        op.checkpoint(&mut progress)?;
        op.view()
    }
}
