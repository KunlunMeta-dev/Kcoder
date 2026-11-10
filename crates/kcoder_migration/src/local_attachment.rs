//! User-authorized supplementation of authenticated local attachment references.
use crate::{
    history_attachments::{HistoryAttachmentView, HistorySelectedAttachment},
    history_branches::HistoryBranchStore,
    history_jobs::HistoryJobStore,
    history_tool_attachments::HistoryToolAttachments,
};
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_state::external_history::{ExternalHistoryReader, local_attachment::SelectedLocalFile};
use kcoder_types::{historical_attachment::*, local_attachment::*};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
};
mod references;
pub mod upload;
mod upload_dependency;
const META: u64 = 32 * 1024;
const MAX_JOBS: usize = 4096;
pub(crate) struct LocalReference<'a> {
    pub archive: &'a ExternalHistoryReader,
    pub fingerprint: String,
    pub info: HistoricalAttachmentInfo,
    pub revision: String,
}
enum Target {
    Raw(Box<HistoryAttachmentView>),
    Selected(Box<HistorySelectedAttachment>),
    Tool(Box<HistoryToolAttachments>),
}
impl Target {
    fn archive(&self) -> &ExternalHistoryReader {
        match self {
            Self::Raw(view) => view.archive(),
            Self::Selected(view) => view.local_archive(),
            Self::Tool(view) => view.local_archive(),
        }
    }
    fn reference(
        &self,
        selection: &HistoricalAttachmentSelection,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<LocalReference<'_>> {
        let mut reference = match self {
            Self::Raw(view) => view.local_reference(
                selection.position,
                selection.block_index,
                None,
                |_, bytes| check(bytes),
            )?,
            Self::Selected(view) => view.local_reference(|_, bytes| check(bytes))?,
            Self::Tool(view) => view.local_reference(
                selection
                    .tool_item_index
                    .context("local_attachment_select_tool_item")?,
                |_, bytes| check(bytes),
            )?,
        };
        reference.fingerprint = hash(&(
            "scoped-local-attachment/1",
            selection,
            reference.fingerprint,
        ))?;
        Ok(reference)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    version: u8,
    owner: String,
    operation_id: String,
    selection: HistoricalAttachmentSelection,
    reference: String,
    info: HistoricalAttachmentInfo,
    revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_reference: Option<kcoder_state::external_history::lifecycle::ArchiveReferenceReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retired: Option<String>,
}
/// Native authority captured before a host starts its explicit file picker or upload.
/// It cannot be reconstructed from an RPC payload or a path recorded in the source history.
pub struct LocalAttachmentRequest {
    _source: Target,
    profile_identity: String,
    selection: HistoricalAttachmentSelection,
    reference: String,
    info: HistoricalAttachmentInfo,
    revision: String,
}
impl LocalAttachmentRequest {
    pub fn selection(&self) -> &HistoricalAttachmentSelection {
        &self.selection
    }
    pub fn info(&self) -> &HistoricalAttachmentInfo {
        &self.info
    }
}
pub struct HistoryLocalAttachments {
    root: PathBuf,
    directory: PrivateDirectory,
    owner: String,
    profile_identity: String,
}
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|error| {
        error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}
fn id(value: &str) -> Result<()> {
    ensure!(
        uuid::Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value),
        "local_attachment_invalid_operation"
    );
    Ok(())
}
fn target(
    profile: &Path,
    selection: &HistoricalAttachmentSelection,
    revision: Option<&str>,
) -> Result<Target> {
    let jobs =
        HistoryJobStore::open_existing(profile)?.context("local_attachment_archive_missing")?;
    let revision = match revision {
        Some(revision) => revision.to_owned(),
        None => jobs.normalization_revision(&selection.job_id)?,
    };
    let tool = if let Some(view) = &selection.view_id {
        HistoryBranchStore::open(profile)?.tool_attachments(
            &selection.job_id,
            view,
            selection.position,
            selection.block_index,
        )
    } else {
        HistoryToolAttachments::open_with_revision(
            jobs.archive_reader(&selection.job_id)?,
            selection.position,
            selection.block_index,
            None,
            &revision,
        )
    };
    match tool {
        Ok(tool) => {
            ensure!(
                selection.tool_item_index.is_some(),
                "local_attachment_select_tool_item"
            );
            return Ok(Target::Tool(Box::new(tool)));
        }
        Err(error) if error.to_string() == "history_tool_attachments_not_a_result" => {}
        Err(error) => return Err(error),
    }
    ensure!(
        selection.tool_item_index.is_none(),
        "local_attachment_not_a_tool_item"
    );
    if let Some(view) = &selection.view_id {
        Ok(Target::Selected(Box::new(
            HistoryBranchStore::open(profile)?.attachment(
                &selection.job_id,
                view,
                selection.position,
                selection.block_index,
            )?,
        )))
    } else {
        Ok(Target::Raw(Box::new(
            HistoryAttachmentView::open_with_revision(
                jobs.archive_reader(&selection.job_id)?,
                &revision,
            )?,
        )))
    }
}
impl HistoryLocalAttachments {
    pub fn prepare_selection(
        profile: &Path,
        selection: &HistoricalAttachmentSelection,
        check: impl FnMut(u64) -> bool,
    ) -> Result<LocalAttachmentRequest> {
        let profile_root = PrivateDirectory::open_existing(profile)?;
        profile_root.verify_trusted_config_directory()?;
        let profile_identity = profile_root.directory_identity()?;
        let resolved = target(profile, selection, None)?;
        let reference = resolved.reference(selection, check)?;
        ensure!(
            PrivateDirectory::open_existing(profile)?.directory_identity()? == profile_identity,
            "local_attachment_owner_changed"
        );
        let reference = (reference.fingerprint, reference.info, reference.revision);
        Ok(LocalAttachmentRequest {
            _source: resolved,
            profile_identity,
            selection: selection.clone(),
            reference: reference.0,
            info: reference.1,
            revision: reference.2,
        })
    }
    pub fn inspect_reference(
        profile: &Path,
        selection: &HistoricalAttachmentSelection,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalAttachmentInfo> {
        Ok(Self::prepare_selection(profile, selection, check)?.info)
    }
    pub fn open(profile: &Path) -> Result<Self> {
        Self::open_at(profile, true)?.context("local_attachment_jobs_missing")
    }
    pub fn open_existing(profile: &Path) -> Result<Option<Self>> {
        Self::open_at(profile, false)
    }
    fn open_at(profile: &Path, create: bool) -> Result<Option<Self>> {
        let root = PrivateDirectory::open_existing(profile)?;
        root.verify_trusted_config_directory()?;
        let migration = match root.open_child(OsStr::new("migrations"), create) {
            Ok(value) => value,
            Err(error) if !create && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        migration.verify_private_directory()?;
        let directory = match migration.open_child(OsStr::new("history-local-attachments"), create)
        {
            Ok(value) => value,
            Err(error) if !create && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        Ok(Some(Self {
            root: profile.into(),
            owner: hash(&(root.directory_identity()?, directory.directory_identity()?))?,
            profile_identity: root.directory_identity()?,
            directory,
        }))
    }
    fn load(&self, key: &str) -> Result<Option<Job>> {
        self.verify_owner()?;
        id(key)?;
        let file = match self
            .directory
            .open_regular_file_snapshot(OsStr::new(&format!("{key}.json")))
        {
            Ok(file) => file,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        ensure!(
            file.metadata()?.len() <= META,
            "local_attachment_metadata_budget_exceeded"
        );
        let mut bytes = Vec::new();
        file.take(META + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= META,
            "local_attachment_metadata_budget_exceeded"
        );
        let job: Job = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("local_attachment_invalid_metadata"))?;
        ensure!(
            matches!(job.version, 1 | 2)
                && job.owner == self.owner
                && job.operation_id == key
                && (job.version == 2 || job.source_reference.is_none() && job.retired.is_none()),
            "local_attachment_owner_changed"
        );
        Ok(Some(job))
    }
    fn job(&self, key: &str) -> Result<Job> {
        let job = self.load(key)?.context("local_attachment_job_not_found")?;
        ensure!(job.retired.is_none(), "local_attachment_job_retired");
        self.verify_source_reference(&job)?;
        Ok(job)
    }
    fn verify_owner(&self) -> Result<()> {
        ensure!(
            PrivateDirectory::open_existing(&self.root)?.directory_identity()?
                == self.profile_identity,
            "local_attachment_owner_changed"
        );
        let current = PrivateDirectory::open_existing(
            &self.root.join("migrations/history-local-attachments"),
        )?;
        ensure!(
            current.directory_identity()? == self.directory.directory_identity()?,
            "local_attachment_owner_changed"
        );
        Ok(())
    }
    fn verify(job: &Job, reference: &LocalReference<'_>) -> Result<()> {
        ensure!(
            job.reference == reference.fingerprint
                && job.info == reference.info
                && job.revision == reference.revision,
            "local_attachment_reference_changed"
        );
        Ok(())
    }
    fn view(job: &Job, state: HistoricalLocalAttachmentState) -> HistoricalLocalAttachmentJob {
        let mut info = job.info.clone();
        info.receipt = state.receipt.clone();
        if state.stage == HistoricalLocalAttachmentStage::Ready {
            info.issue = None;
        }
        HistoricalLocalAttachmentJob {
            selection: job.selection.clone(),
            state,
            info,
            historical_content_verified: false,
        }
    }
    pub fn authorize(
        &self,
        key: &str,
        request: &LocalAttachmentRequest,
        selected: &SelectedLocalFile,
    ) -> Result<HistoricalLocalAttachmentJob> {
        self.authorize_with_cancel(key, request, selected, |_| true)
    }
    pub fn authorize_with_cancel(
        &self,
        key: &str,
        request: &LocalAttachmentRequest,
        selected: &SelectedLocalFile,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalLocalAttachmentJob> {
        id(key)?;
        self.verify_owner()?;
        ensure!(
            request.profile_identity == self.profile_identity,
            "local_attachment_owner_changed"
        );
        let selection = &request.selection;
        let resolved = target(&self.root, selection, Some(&request.revision))?;
        let reference = resolved.reference(selection, check)?;
        ensure!(
            request.reference == reference.fingerprint
                && request.revision == reference.revision
                && request.info == reference.info,
            "local_attachment_reference_changed"
        );
        let _catalog = self
            .directory
            .try_exclusive_lock(OsStr::new("catalog.lock"))?
            .context("local_attachment_busy")?;
        let mut job = if let Some(job) = self.load(key)? {
            ensure!(job.retired.is_none(), "local_attachment_job_retired");
            ensure!(
                job.selection == *selection,
                "local_attachment_request_changed"
            );
            Self::verify(&job, &reference)?;
            job
        } else {
            let mut count = 0;
            self.directory
                .visit_entry_names_bounded(MAX_JOBS + 2, |name| {
                    if name.to_str().is_some_and(|name| name.ends_with(".json")) {
                        count += 1;
                    }
                    Ok(())
                })?;
            ensure!(count < MAX_JOBS, "local_attachment_job_budget_exceeded");
            let job = Job {
                version: if resolved.archive().lifecycle_guard().is_managed() {
                    2
                } else {
                    1
                },
                owner: self.owner.clone(),
                operation_id: key.into(),
                selection: selection.clone(),
                reference: reference.fingerprint.clone(),
                info: reference.info.clone(),
                revision: reference.revision.clone(),
                source_reference: None,
                retired: None,
            };
            let bytes = serde_json::to_vec(&job)?;
            ensure!(
                bytes.len() as u64 <= META,
                "local_attachment_metadata_budget_exceeded"
            );
            self.directory
                .atomic_replace(OsStr::new(&format!("{key}.json")), &bytes)?;
            job
        };
        self.pin_source_reference(&mut job, reference.archive)?;
        let native = reference
            .archive
            .local_attachment_import(key, true)?
            .context("local_attachment_store_missing")?;
        Ok(Self::view(
            &job,
            native.authorize(&job.reference, selected)?,
        ))
    }
    pub fn read(&self, key: &str) -> Result<HistoricalLocalAttachmentJob> {
        self.read_with_cancel(key, |_| true)
    }
    pub fn read_with_cancel(
        &self,
        key: &str,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalLocalAttachmentJob> {
        let job = self.job(key)?;
        let resolved = target(&self.root, &job.selection, Some(&job.revision))?;
        let reference = resolved.reference(&job.selection, check)?;
        Self::verify(&job, &reference)?;
        let state = match reference.archive.local_attachment_import(key, false)? {
            Some(native) => native.view(&job.reference)?,
            None => HistoricalLocalAttachmentState {
                operation_id: key.into(),
                sequence: 0,
                stage: HistoricalLocalAttachmentStage::SelectionRequired,
                processed_bytes: 0,
                receipt: None,
                failure_code: Some("local_attachment_selection_required".into()),
                cancel_requested: false,
                cancel_revision: 0,
            },
        };
        Ok(Self::view(&job, state))
    }
    pub fn run(
        &self,
        key: &str,
        sequence: u64,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalLocalAttachmentJob> {
        let job = self.job(key)?;
        self.run_cached(key, job, sequence, check)
    }
    fn run_cached(
        &self,
        key: &str,
        job: Job,
        sequence: u64,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalLocalAttachmentJob> {
        let resolved = target(&self.root, &job.selection, Some(&job.revision))?;
        let reference = resolved.reference(&job.selection, &mut check)?;
        Self::verify(&job, &reference)?;
        let native = reference
            .archive
            .local_attachment_import(key, true)?
            .context("local_attachment_store_missing")?;
        // A retirement may have committed after the initial job snapshot but before
        // this native writer was acquired. Never run from that stale cached authority.
        let current = self.job(key)?;
        Self::verify(&current, &reference)?;
        Ok(Self::view(
            &current,
            native.run(&current.reference, sequence, check)?,
        ))
    }
    pub fn cancel(&self, key: &str) -> Result<HistoricalLocalAttachmentJob> {
        let job = self.job(key)?;
        let resolved = target(&self.root, &job.selection, Some(&job.revision))?;
        // Cancellation uses the already owned operation; it need not scan a potentially large source.
        let native = resolved
            .archive()
            .local_attachment_import(key, false)?
            .context("local_attachment_store_missing")?;
        Ok(Self::view(&job, native.cancel(&job.reference)?))
    }
    pub fn chunk(
        &self,
        key: &str,
        selection: &HistoricalAttachmentSelection,
        expected: &HistoricalAttachmentReceipt,
        offset: u64,
        limit: usize,
    ) -> Result<Vec<u8>> {
        let job = self.job(key)?;
        ensure!(
            job.selection == *selection,
            "local_attachment_request_changed"
        );
        let resolved = target(&self.root, selection, Some(&job.revision))?;
        let reference = resolved.reference(selection, |_| true)?;
        Self::verify(&job, &reference)?;
        reference
            .archive
            .local_attachment_import(key, false)?
            .context("local_attachment_store_missing")?
            .read_chunk(&job.reference, expected, offset, limit)
    }
}

#[cfg(test)]
mod test_fixture;
