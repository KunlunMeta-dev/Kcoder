use super::*;
pub(super) use kcoder_types::local_attachment_upload::HistoricalLocalAttachmentUploadStage as Stage;
pub(super) const BUDGET: u64 = 32 * 1024;
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Frozen {
    pub profile_identity: String,
    pub selection: HistoricalAttachmentSelection,
    pub reference: String,
    pub info: HistoricalAttachmentInfo,
    pub revision: String,
}
impl Frozen {
    pub fn from_request(value: &LocalAttachmentRequest) -> Self {
        Self {
            profile_identity: value.profile_identity.clone(),
            selection: value.selection.clone(),
            reference: value.reference.clone(),
            info: value.info.clone(),
            revision: value.revision.clone(),
        }
    }
    pub fn reopen(
        &self,
        root: &Path,
        check: impl FnMut(u64) -> bool,
    ) -> Result<LocalAttachmentRequest> {
        ensure!(
            PrivateDirectory::open_existing(root)?.directory_identity()? == self.profile_identity,
            "local_upload_owner_changed"
        );
        let selected = target(root, &self.selection, Some(&self.revision))?;
        let reference = selected.reference(&self.selection, check)?;
        ensure!(
            reference.fingerprint == self.reference
                && reference.info == self.info
                && reference.revision == self.revision,
            "local_upload_reference_changed"
        );
        Ok(LocalAttachmentRequest {
            _source: selected,
            profile_identity: self.profile_identity.clone(),
            selection: self.selection.clone(),
            reference: self.reference.clone(),
            info: self.info.clone(),
            revision: self.revision.clone(),
        })
    }
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Grant {
    pub version: u8,
    pub owner: String,
    pub operation_id: String,
    pub directory_identity: String,
    pub writer_identity: String,
    pub control_identity: String,
    pub frozen: Frozen,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_birth: Option<super::collection::Birth>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Control {
    pub revision: u64,
    pub acknowledged: u64,
    pub sequence: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Progress {
    pub sequence: u64,
    pub stage: Stage,
    pub bytes: u64,
    pub cancel_watermark: u64,
    pub error: Option<String>,
}
impl Default for Progress {
    fn default() -> Self {
        Self {
            sequence: 0,
            stage: Stage::Prepared,
            bytes: 0,
            cancel_watermark: 0,
            error: None,
        }
    }
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Manifest {
    pub filename: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Part {
    pub index: u32,
    pub bytes: u64,
    pub sha256: String,
    pub manifest: String,
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct PartReceipt {
    pub part: Part,
    pub identity: String,
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Assembly {
    pub manifest: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Assembled {
    pub assembly: Assembly,
    pub identity: String,
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Authorization {
    pub assembled: Assembled,
    pub selection_revision: String,
}
pub(super) struct Operation<'a> {
    pub store: &'a HistoryLocalAttachmentUploads,
    pub directory: PrivateDirectory,
    pub grant: Grant,
    pub _writer: Option<File>,
}
pub(super) fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub(super) fn valid_filename(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 255
            && !value.chars().any(|c| c.is_control() || "/\\:".contains(c))
            && !matches!(value, "." | ".."),
        "local_upload_invalid_filename"
    );
    let name = value.to_ascii_lowercase();
    ensure!(
        !name.starts_with(".env")
            && !matches!(
                name.as_str(),
                "auth.json" | "credentials.json" | "credentials.toml"
            ),
        "local_upload_sensitive_file"
    );
    Ok(())
}
pub(super) fn load<T: serde::de::DeserializeOwned>(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<Option<T>> {
    let mut file = match directory.open_regular_file_snapshot(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    ensure!(
        file.metadata()?.len() <= BUDGET,
        "local_upload_metadata_budget_exceeded"
    );
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(BUDGET + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= BUDGET,
        "local_upload_metadata_budget_exceeded"
    );
    Ok(Some(serde_json::from_slice(&bytes).map_err(|_| {
        anyhow::anyhow!("local_upload_invalid_metadata")
    })?))
}
pub(super) fn save(directory: &PrivateDirectory, name: &str, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() as u64 <= BUDGET,
        "local_upload_metadata_budget_exceeded"
    );
    directory.atomic_replace(OsStr::new(name), &bytes)
}
pub(super) fn exact<T: Serialize + serde::de::DeserializeOwned + PartialEq>(
    directory: &PrivateDirectory,
    name: &str,
    value: &T,
) -> Result<()> {
    if let Some(existing) = load::<T>(directory, name)? {
        ensure!(existing == *value, "local_upload_metadata_changed");
        return Ok(());
    }
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() as u64 <= BUDGET,
        "local_upload_metadata_budget_exceeded"
    );
    directory.atomic_publish_from_reader(
        OsStr::new(name),
        &mut Cursor::new(bytes),
        false,
        || Ok(None),
    )?;
    Ok(())
}
pub(super) fn file_identity(file: &File) -> Result<String> {
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "local_upload_unsafe_file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(metadata.nlink() == 1, "local_upload_unsafe_file");
        Ok(format!(
            "{}:{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime(),
            metadata.ctime(),
            metadata.ctime_nsec()
        ))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: file owns a live handle and info is writable native output storage.
        ensure!(
            unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } != 0
                && info.nNumberOfLinks == 1,
            "local_upload_unsafe_file"
        );
        Ok(format!(
            "{}:{}:{}:{}:{}:{}:{}:{}:{}",
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
            info.ftCreationTime.dwHighDateTime,
            info.ftCreationTime.dwLowDateTime,
            info.ftLastWriteTime.dwHighDateTime,
            info.ftLastWriteTime.dwLowDateTime,
            info.nFileSizeHigh,
            info.nFileSizeLow
        ))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = metadata;
        anyhow::bail!("local_upload_unsupported_platform")
    }
}
pub(super) fn existing_lock(
    directory: &PrivateDirectory,
    name: &str,
    identity: &str,
) -> Result<File> {
    let file = directory
        .open_single_link_regular_file(OsStr::new(name))
        .map_err(|_| anyhow::anyhow!("local_upload_lock_missing"))?;
    ensure!(
        file_identity(&file)? == identity,
        "local_upload_lock_changed"
    );
    Ok(file)
}
pub(super) fn try_lock(file: &File) -> Result<bool> {
    match FileExt::try_lock_exclusive(file) {
        Ok(()) => Ok(true),
        Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock
                || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
        {
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}
impl Operation<'_> {
    pub fn manifest(&self) -> Result<Option<Manifest>> {
        let value = load::<Manifest>(&self.directory, "manifest.json")?;
        if let Some(value) = &value {
            valid_filename(&value.filename)?;
            ensure!(
                value.bytes <= HISTORICAL_LOCAL_UPLOAD_MAX_BYTES && valid_sha(&value.sha256),
                "local_upload_invalid_manifest"
            );
        }
        Ok(value)
    }
    pub fn control(&self) -> Result<Control> {
        let value: Control =
            load(&self.directory, "control.json")?.context("local_upload_recovery_required")?;
        ensure!(
            value.acknowledged <= value.revision,
            "local_upload_invalid_metadata"
        );
        Ok(value)
    }
    pub fn control_lock(&self) -> Result<File> {
        let file = existing_lock(
            &self.directory,
            "control.lock",
            &self.grant.control_identity,
        )?;
        ensure!(try_lock(&file)?, "local_upload_busy");
        Ok(file)
    }
    pub fn progress(&self) -> Result<Progress> {
        Ok(load(&self.directory, "state.json")?.unwrap_or(Progress {
            sequence: self.control()?.sequence,
            stage: Stage::OutcomeUnknown,
            bytes: 0,
            cancel_watermark: 0,
            error: Some("local_upload_recovery_required".into()),
        }))
    }
    pub fn check_sequence(&self, sequence: u64) -> Result<()> {
        ensure!(
            self.control()?.sequence == sequence,
            "local_upload_revision_conflict"
        );
        Ok(())
    }
    pub fn allow(&self) -> Result<()> {
        self.store.verify()?;
        existing_lock(&self.directory, "writer.lock", &self.grant.writer_identity)?;
        ensure!(
            self.directory.directory_identity()? == self.grant.directory_identity
                && self
                    .store
                    .directory
                    .open_child(OsStr::new(&self.grant.operation_id), false)?
                    .directory_identity()?
                    == self.grant.directory_identity,
            "local_upload_owner_changed"
        );
        let control = self.control()?;
        ensure!(
            control.revision <= control.acknowledged,
            "local_upload_cancelled"
        );
        Ok(())
    }
    pub fn checkpoint(&self, value: &mut Progress) -> Result<()> {
        let _lock = self.control_lock()?;
        let mut control = self.control()?;
        control.sequence = control
            .sequence
            .checked_add(1)
            .context("local_upload_sequence_exhausted")?;
        value.sequence = control.sequence;
        save(&self.directory, "control.json", &control)?;
        save(&self.directory, "state.json", value)
    }
    pub fn parts_dir(&self) -> Result<PrivateDirectory> {
        if self.grant.version == 3 {
            let birth = self
                .grant
                .collection_birth
                .as_ref()
                .context("local_upload_collection_missing_birth")?;
            return self
                .directory
                .portable_open_verified_child(OsStr::new("parts"), &birth.parts);
        }
        let directory = self.directory.open_child(OsStr::new("parts"), false)?;
        directory.verify_private_directory()?;
        Ok(directory)
    }
    pub fn native_job(&self) -> Result<Option<HistoricalLocalAttachmentJob>> {
        let Some(authorization) = load::<Authorization>(&self.directory, "authorization.json")?
        else {
            return Ok(None);
        };
        let manifest = self.manifest()?.context("local_upload_recovery_required")?;
        ensure!(
            authorization.assembled.assembly.manifest == hash(&manifest)?
                && authorization.assembled.assembly.bytes == manifest.bytes
                && authorization.assembled.assembly.sha256 == manifest.sha256,
            "local_upload_manifest_changed"
        );
        let Some(local) = HistoryLocalAttachments::open_existing(&self.store.root)? else {
            return Ok(None);
        };
        let job = match local.load(&self.grant.operation_id)? {
            Some(job) => job,
            None => return Ok(None),
        };
        ensure!(
            job.selection == self.grant.frozen.selection
                && job.reference == self.grant.frozen.reference
                && job.revision == self.grant.frozen.revision
                && job.info == self.grant.frozen.info,
            "local_upload_reference_changed"
        );
        let resolved = target(&self.store.root, &job.selection, Some(&job.revision))?;
        let Some(native) = resolved
            .archive()
            .local_attachment_import(&job.operation_id, false)?
        else {
            return Ok(None);
        };
        let expected = match native.expected_receipt(&job.reference) {
            Ok(value) => value,
            Err(error) if error.to_string() == "local_attachment_selection_required" => {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        ensure!(
            expected.bytes == manifest.bytes
                && expected.sha256 == manifest.sha256
                && native.selection_revision(&job.reference)? == authorization.selection_revision,
            "local_upload_authorization_changed"
        );
        let result = local.read(&self.grant.operation_id)?;
        if result.state.stage != HistoricalLocalAttachmentStage::Ready {
            let payload = self
                .directory
                .open_single_link_regular_file(OsStr::new("payload.bin"))?;
            ensure!(
                file_identity(&payload)? == authorization.assembled.identity,
                "local_upload_payload_changed"
            );
        }
        Ok(Some(result))
    }
    pub fn view(&self) -> Result<HistoricalLocalAttachmentUpload> {
        let manifest = self.manifest()?;
        let control = self.control()?;
        let progress = self.progress()?;
        let (received_parts, received_bytes) = self.receipts(manifest.as_ref())?;
        let local_job = self.native_job()?;
        let writer = existing_lock(&self.directory, "writer.lock", &self.grant.writer_identity)?;
        let pending_part = if let Some(manifest) = &manifest {
            received_parts < parts::count(manifest)
                && load::<Part>(
                    &self.parts_dir()?,
                    &format!("part-{received_parts:04}.intent.json"),
                )?
                .is_some()
        } else {
            false
        };
        let stage = if local_job.is_some() {
            Stage::Authorized
        } else if progress.stage == Stage::Authorized
            || ((progress.stage == Stage::Assembling || pending_part)
                && self._writer.is_none()
                && try_lock(&writer)?)
        {
            Stage::OutcomeUnknown
        } else if progress.stage == Stage::Prepared && manifest.is_some() {
            Stage::Receiving
        } else {
            progress.stage
        };
        let ready = local_job
            .as_ref()
            .is_some_and(|job| job.state.stage == HistoricalLocalAttachmentStage::Ready);
        Ok(HistoricalLocalAttachmentUpload {
            operation_id: self.grant.operation_id.clone(),
            selection: self.grant.frozen.selection.clone(),
            sequence: control.sequence,
            stage,
            filename: manifest.as_ref().map(|m| m.filename.clone()),
            bytes: manifest.as_ref().map(|m| m.bytes),
            sha256: manifest.as_ref().map(|m| m.sha256.clone()),
            received_bytes,
            received_parts,
            part_bytes: HISTORICAL_LOCAL_UPLOAD_PART_BYTES,
            // Transfer and native copy have separate cancellation watermarks. A confirmed
            // transfer resume must allow an explicit, sequence-checked native copy resume.
            cancel_requested: !ready && control.revision > control.acknowledged,
            cancel_revision: control.revision,
            failure_code: if local_job.is_some() {
                None
            } else if stage == Stage::OutcomeUnknown {
                progress
                    .error
                    .or(Some("local_upload_outcome_unknown".into()))
            } else {
                progress.error
            },
            local_job,
        })
    }
}
