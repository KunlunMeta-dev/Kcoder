//! Durable bounded browser bytes for one native, preselected historical reference.
use super::*;
use fs2::FileExt;
use kcoder_types::local_attachment_upload::*;
use std::{fs::File, io::Cursor};
pub mod collection;
mod finish;
mod parts;
mod references;
mod storage;
use storage::*;

pub struct HistoryLocalAttachmentUploads {
    root: PathBuf,
    directory: PrivateDirectory,
    profile_identity: String,
    owner: String,
}
impl HistoryLocalAttachmentUploads {
    pub fn open(profile: &Path) -> Result<Self> {
        Self::open_at(profile, true)?.context("local_upload_missing")
    }
    pub fn open_existing(profile: &Path) -> Result<Option<Self>> {
        Self::open_at(profile, false)
    }
    fn open_at(profile: &Path, create: bool) -> Result<Option<Self>> {
        let root = PrivateDirectory::open_existing(profile)?;
        root.verify_trusted_config_directory()?;
        let parent = match root.open_child(OsStr::new("migrations"), create) {
            Ok(value) => value,
            Err(error) if !create && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        parent.verify_private_directory()?;
        let directory = match parent.open_child(OsStr::new("local-attachment-uploads"), create) {
            Ok(value) => value,
            Err(error) if !create && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        Ok(Some(Self {
            root: profile.into(),
            profile_identity: root.directory_identity()?,
            owner: hash(&(root.directory_identity()?, directory.directory_identity()?))?,
            directory,
        }))
    }
    fn verify(&self) -> Result<()> {
        ensure!(
            PrivateDirectory::open_existing(&self.root)?.directory_identity()?
                == self.profile_identity
                && PrivateDirectory::open_existing(
                    &self.root.join("migrations/local-attachment-uploads")
                )?
                .directory_identity()?
                    == self.directory.directory_identity()?,
            "local_upload_owner_changed"
        );
        self.directory.verify_private_directory()
    }
    fn operation(&self, operation_id: &str, write: bool) -> Result<Operation<'_>> {
        let operation = self.operation_inner(operation_id, write)?;
        operation.verify_source_reference()?;
        operation.ensure_storage_live()?;
        Ok(operation)
    }
    fn operation_inner(&self, operation_id: &str, write: bool) -> Result<Operation<'_>> {
        self.verify()?;
        id(operation_id)?;
        let directory = self.directory.open_child(OsStr::new(operation_id), false)?;
        directory.verify_private_directory()?;
        let grant: Grant =
            load(&directory, "grant.json")?.context("local_upload_recovery_required")?;
        ensure!(
            matches!(grant.version, 1..=3)
                && grant.owner == self.owner
                && grant.operation_id == operation_id
                && grant.directory_identity == directory.directory_identity()?
                && grant.frozen.profile_identity == self.profile_identity,
            "local_upload_owner_changed"
        );
        let writer = existing_lock(&directory, "writer.lock", &grant.writer_identity)?;
        let writer = if write {
            ensure!(try_lock(&writer)?, "local_upload_busy");
            Some(writer)
        } else {
            None
        };
        let operation = Operation {
            store: self,
            directory,
            grant,
            _writer: writer,
        };
        if operation.grant.version == 3 {
            operation.collection_birth()?;
        } else {
            ensure!(
                operation.grant.collection_birth.is_none(),
                "local_upload_owner_changed"
            );
        }
        Ok(operation)
    }
    pub fn prepare(
        &self,
        operation_id: &str,
        selection: &HistoricalAttachmentSelection,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalLocalAttachmentUpload> {
        id(operation_id)?;
        self.verify()?;
        let request = HistoryLocalAttachments::prepare_selection(&self.root, selection, check)?;
        let frozen = Frozen::from_request(&request);
        let _catalog = self
            .directory
            .try_exclusive_lock(OsStr::new("catalog.lock"))?
            .context("local_upload_busy")?;
        match self.operation_inner(operation_id, true) {
            Ok(op) => {
                ensure!(op.grant.frozen == frozen, "local_upload_request_changed");
                op.pin_source_reference(&request)?;
                return op.view();
            }
            Err(error) if missing(&error) => {}
            Err(error) => return Err(error),
        }
        let ids = self.ids()?;
        ensure!(
            !ids.iter().any(|id| id == operation_id),
            "local_upload_recovery_required"
        );
        ensure!(
            ids.len() < HISTORICAL_LOCAL_UPLOAD_MAX_JOBS,
            "local_upload_job_budget_exceeded"
        );
        let directory = self
            .directory
            .create_private_child(OsStr::new(operation_id))?;
        directory.verify_private_directory()?;
        let writer = directory
            .try_exclusive_lock(OsStr::new("writer.lock"))?
            .context("local_upload_busy")?;
        let control_lock = directory
            .try_exclusive_lock(OsStr::new("control.lock"))?
            .context("local_upload_busy")?;
        let parts = directory.create_private_child(OsStr::new("parts"))?;
        let managed = request._source.archive().lifecycle_guard().is_managed();
        let collection_capable = managed && cfg!(any(target_os = "linux", windows));
        let collection_birth = if collection_capable {
            for name in ["collection-control.lock", "collection-writer.lock"] {
                directory
                    .try_exclusive_lock(OsStr::new(name))?
                    .context("local_upload_busy")?;
            }
            Some(collection::Birth {
                directory: directory.portable_retention_identity()?,
                parts: parts.portable_retention_identity()?,
                writer: directory.portable_regular_identity(OsStr::new("writer.lock"))?,
                control: directory.portable_regular_identity(OsStr::new("control.lock"))?,
                catalog: self
                    .directory
                    .portable_regular_identity(OsStr::new("catalog.lock"))?,
                collection_control: directory
                    .portable_regular_identity(OsStr::new("collection-control.lock"))?,
                collection_writer: directory
                    .portable_regular_identity(OsStr::new("collection-writer.lock"))?,
            })
        } else {
            None
        };
        let grant = Grant {
            version: if collection_capable {
                3
            } else if managed {
                2
            } else {
                1
            },
            owner: self.owner.clone(),
            operation_id: operation_id.into(),
            directory_identity: directory.directory_identity()?,
            writer_identity: file_identity(&writer)?,
            control_identity: file_identity(&control_lock)?,
            frozen,
            collection_birth,
        };
        directory
            .open_child(OsStr::new("parts"), true)?
            .verify_private_directory()?;
        save(&directory, "control.json", &Control::default())?;
        save(&directory, "state.json", &Progress::default())?;
        exact(&directory, "grant.json", &grant)?;
        drop(control_lock);
        let operation = Operation {
            store: self,
            directory,
            grant,
            _writer: Some(writer),
        };
        operation.pin_source_reference(&request)?;
        operation.view()
    }
    fn ids(&self) -> Result<Vec<String>> {
        self.verify()?;
        let mut ids = Vec::new();
        self.directory
            .visit_entry_names_bounded(HISTORICAL_LOCAL_UPLOAD_MAX_JOBS + 2, |name| {
                if let Some(value) = name.to_str()
                    && uuid::Uuid::parse_str(value).is_ok()
                {
                    id(value)?;
                    ids.push(value.into());
                }
                Ok(())
            })?;
        ensure!(
            ids.len() <= HISTORICAL_LOCAL_UPLOAD_MAX_JOBS,
            "local_upload_job_budget_exceeded"
        );
        ids.sort();
        Ok(ids)
    }
    pub fn running(&self, operation_id: &str) -> Result<bool> {
        let op = self.operation(operation_id, false)?;
        let writer = existing_lock(&op.directory, "writer.lock", &op.grant.writer_identity)?;
        Ok(!try_lock(&writer)?)
    }
    pub fn read(&self, operation_id: &str) -> Result<HistoricalLocalAttachmentUpload> {
        self.operation(operation_id, false)?.view()
    }
    pub fn list(
        &self,
        selection: &HistoricalAttachmentSelection,
        cursor: Option<&str>,
    ) -> Result<HistoricalLocalAttachmentUploadPage> {
        if let Some(cursor) = cursor {
            id(cursor)?;
        }
        let mut selected = Vec::new();
        let mut metadata = 0u64;
        for id in self.ids()? {
            let op = self.operation_inner(&id, false)?;
            if op.is_retired()? || op.storage_retired()? {
                continue;
            }
            op.verify_source_reference()?;
            metadata = metadata
                .checked_add(serde_json::to_vec(&op.grant)?.len() as u64)
                .context("local_upload_metadata_budget_exceeded")?;
            ensure!(
                metadata <= 16 * 1024 * 1024,
                "local_upload_metadata_budget_exceeded"
            );
            if op.grant.frozen.selection == *selection
                && cursor.is_none_or(|cursor| id.as_str() > cursor)
            {
                selected.push(id);
            }
        }
        let next_cursor = (selected.len() > 10).then(|| selected[9].clone());
        let items = selected
            .into_iter()
            .take(10)
            .map(|id| self.read(&id))
            .collect::<Result<_>>()?;
        Ok(HistoricalLocalAttachmentUploadPage { items, next_cursor })
    }
    pub fn begin(
        &self,
        operation_id: &str,
        sequence: u64,
        filename: &str,
        bytes: u64,
        sha256: &str,
    ) -> Result<HistoricalLocalAttachmentUpload> {
        self.verify()?;
        valid_filename(filename)?;
        ensure!(
            bytes <= HISTORICAL_LOCAL_UPLOAD_MAX_BYTES && valid_sha(sha256),
            "local_upload_invalid_manifest"
        );
        let manifest = Manifest {
            filename: filename.into(),
            bytes,
            sha256: sha256.into(),
        };
        let _catalog = self
            .directory
            .try_exclusive_lock(OsStr::new("catalog.lock"))?
            .context("local_upload_busy")?;
        let op = self.operation(operation_id, true)?;
        if let Some(existing) = op.manifest()? {
            ensure!(existing == manifest, "local_upload_manifest_changed");
            return op.view();
        }
        op.check_sequence(sequence)?;
        op.allow()?;
        let mut reserved = bytes
            .checked_mul(2)
            .context("local_upload_staging_budget_exceeded")?;
        for id in self.ids()? {
            if id == operation_id {
                continue;
            }
            let other_operation = self.operation_inner(&id, false)?;
            if let Some(other) = other_operation.manifest()? {
                let charge = (other.bytes * 2)
                    .checked_sub(other_operation.collection_refund()?)
                    .context("local_upload_collection_budget_changed")?;
                reserved = reserved
                    .checked_add(charge)
                    .context("local_upload_staging_budget_exceeded")?;
            }
        }
        ensure!(
            reserved <= HISTORICAL_LOCAL_UPLOAD_MAX_STAGING_BYTES,
            "local_upload_staging_budget_exceeded"
        );
        exact(&op.directory, "manifest.json", &manifest)?;
        let mut progress = op.progress()?;
        progress.stage = Stage::Receiving;
        progress.error = None;
        op.checkpoint(&mut progress)?;
        op.view()
    }
    pub fn cancel(&self, operation_id: &str) -> Result<HistoricalLocalAttachmentUpload> {
        let op = self.operation(operation_id, false)?;
        {
            let _lock = op.control_lock()?;
            let mut control = op.control()?;
            control.revision = control
                .revision
                .checked_add(1)
                .context("local_upload_sequence_exhausted")?;
            control.sequence = control
                .sequence
                .checked_add(1)
                .context("local_upload_sequence_exhausted")?;
            save(&op.directory, "control.json", &control)?;
        }
        if let Some(local) = op.native_job()? {
            if local.state.stage != HistoricalLocalAttachmentStage::Ready {
                HistoryLocalAttachments::open_existing(&self.root)?
                    .context("local_upload_recovery_required")?
                    .cancel(operation_id)?;
            }
        } else {
            let writer = existing_lock(&op.directory, "writer.lock", &op.grant.writer_identity)?;
            if try_lock(&writer)? {
                let mut progress = op.progress()?;
                progress.cancel_watermark = op.control()?.revision;
                if load::<Authorization>(&op.directory, "authorization.json")?.is_some() {
                    progress.stage = Stage::OutcomeUnknown;
                    progress.error = Some("local_upload_authorization_unknown".into());
                } else if !matches!(progress.stage, Stage::Assembling | Stage::OutcomeUnknown) {
                    progress.stage = Stage::Cancelled;
                    progress.error = Some("local_upload_cancelled".into());
                }
                op.checkpoint(&mut progress)?;
            }
        }
        op.view()
    }
    pub fn resume(
        &self,
        operation_id: &str,
        sequence: u64,
    ) -> Result<HistoricalLocalAttachmentUpload> {
        let op = self.operation(operation_id, true)?;
        op.check_sequence(sequence)?;
        let native = op.native_job()?;
        let mut progress = op.progress()?;
        if native
            .as_ref()
            .is_some_and(|job| job.state.stage == HistoricalLocalAttachmentStage::Ready)
        {
            return op.view();
        }
        if let Some(native) = &native {
            ensure!(
                native.state.stage != HistoricalLocalAttachmentStage::Copying,
                "local_upload_busy"
            );
        } else {
            ensure!(
                load::<Authorization>(&op.directory, "authorization.json")?.is_none(),
                "local_upload_recovery_required"
            );
            ensure!(
                matches!(
                    progress.stage,
                    Stage::Cancelled | Stage::Failed | Stage::OutcomeUnknown
                ) || op.control()?.revision > op.control()?.acknowledged,
                "local_upload_not_resumable"
            );
        }
        {
            let _lock = op.control_lock()?;
            let mut control = op.control()?;
            ensure!(
                control.sequence == sequence,
                "local_upload_revision_conflict"
            );
            // The exclusive runner is held and this explicit request names the current cancel version.
            progress.cancel_watermark = control.revision;
            control.acknowledged = control.revision;
            save(&op.directory, "control.json", &control)?;
        }
        progress.stage = if native.is_some() {
            Stage::Authorized
        } else if op.manifest()?.is_some() {
            Stage::Receiving
        } else {
            Stage::Prepared
        };
        progress.error = None;
        op.checkpoint(&mut progress)?;
        op.view()
    }
}
