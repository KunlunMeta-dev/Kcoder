//! Durable extraction receipts and revision-safe cancellation for native history coordinates.
use crate::{
    history_attachments::{HistoryAttachmentView, HistorySelectedAttachment},
    history_branches::HistoryBranchStore,
    history_jobs::HistoryJobStore,
    history_tool_attachments::HistoryToolAttachments,
};
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::historical_tool_attachments::*;
use kcoder_types::{external_history::EXTERNAL_HISTORY_MAX_BYTES, historical_attachment::*};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
const META: u64 = 32 * 1024;
const MAX_JOBS: usize = 4096;
mod references;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    version: u32,
    owner: String,
    selection: HistoricalAttachmentSelection,
    content: String,
    cancel_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_reference: Option<kcoder_state::external_history::lifecycle::ArchiveReferenceReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retirement: Option<u64>,
    view: HistoricalAttachmentJobView,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Control {
    revision: u64,
    acknowledged: u64,
}
pub struct HistoryAttachmentJobs {
    directory: PrivateDirectory,
    profile: PrivateDirectory,
    root: PathBuf,
    owner: String,
}
enum Target {
    Raw {
        view: Box<HistoryAttachmentView>,
        record: u64,
        block: u32,
    },
    Selected(Box<HistorySelectedAttachment>),
    Tool {
        catalog: Box<HistoryToolAttachments>,
        item: Option<u32>,
    },
}
enum Processed {
    Attachment(HistoricalAttachmentInfo),
    Catalog(HistoricalToolAttachmentSummary),
}
impl Target {
    fn identity(&self) -> Result<String> {
        match self {
            Self::Raw {
                view,
                record,
                block,
            } => view.binding_identity(*record, *block, None),
            Self::Selected(v) => v.identity(),
            Self::Tool { catalog, item } => match item {
                Some(index) => catalog.item_identity(*index),
                None => catalog.source_identity(),
            },
        }
    }
    fn receipt(&self) -> Result<Option<HistoricalAttachmentReceipt>> {
        match self {
            Self::Raw {
                view,
                record,
                block,
            } => view.saved_receipt(*record, *block, None),
            Self::Selected(v) => v.receipt(),
            Self::Tool {
                catalog,
                item: Some(index),
            } => catalog.item_receipt(*index),
            Self::Tool { item: None, .. } => Ok(None),
        }
    }
    fn process(
        &self,
        check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<Processed> {
        match self {
            Self::Raw {
                view,
                record,
                block,
            } => view
                .process(
                    *record,
                    *block,
                    None,
                    HISTORICAL_ATTACHMENT_MAX_BYTES,
                    check,
                )
                .map(Processed::Attachment),
            Self::Selected(v) => v
                .process(HISTORICAL_ATTACHMENT_MAX_BYTES, check)
                .map(Processed::Attachment),
            Self::Tool {
                catalog,
                item: Some(index),
            } => catalog
                .extract_item(*index, HISTORICAL_ATTACHMENT_MAX_BYTES, check)
                .map(Processed::Attachment),
            Self::Tool {
                catalog,
                item: None,
            } => catalog.build(check).map(Processed::Catalog),
        }
    }
    fn chunk(&self, offset: u64, limit: usize) -> Result<Vec<u8>> {
        match self {
            Self::Raw {
                view,
                record,
                block,
            } => view.read_chunk(*record, *block, None, offset, limit, |_, _| true),
            Self::Selected(v) => v.read_chunk(offset, limit, |_, _| true),
            Self::Tool {
                catalog,
                item: Some(index),
            } => catalog.read_item_chunk(*index, offset, limit, |_, _| true),
            Self::Tool { item: None, .. } => anyhow::bail!("history_tool_attachments_select_item"),
        }
    }
}
fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|v| {
        v.downcast_ref::<std::io::Error>()
            .is_some_and(|v| v.kind() == std::io::ErrorKind::NotFound)
    })
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn safe(error: &anyhow::Error) -> String {
    let v = error.to_string();
    if (v.starts_with("history_") || v.starts_with("external_history_"))
        && v.len() <= 128
        && v.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
    {
        v
    } else {
        "history_attachment_job_failed".into()
    }
}
impl HistoryAttachmentJobs {
    pub fn open(profile: &Path) -> Result<Self> {
        Self::open_inner(profile, true)?.context("history_attachment_jobs_missing")
    }
    pub fn open_existing(profile: &Path) -> Result<Option<Self>> {
        Self::open_inner(profile, false)
    }
    fn open_inner(root: &Path, create: bool) -> Result<Option<Self>> {
        let profile = PrivateDirectory::open_existing(root)?;
        profile.verify_trusted_config_directory()?;
        let mut directory = match profile.open_child(OsStr::new("migrations"), create) {
            Ok(v) => v,
            Err(e) if !create && missing(&e) => return Ok(None),
            Err(e) => return Err(e),
        };
        directory.verify_private_directory()?;
        directory = match directory.open_child(OsStr::new("history-attachments"), create) {
            Ok(v) => v,
            Err(e) if !create && missing(&e) => return Ok(None),
            Err(e) => return Err(e),
        };
        directory.verify_private_directory()?;
        let owner = hash(&serde_json::to_vec(&(
            profile.directory_identity()?,
            directory.directory_identity()?,
        ))?);
        Ok(Some(Self {
            directory,
            profile,
            root: root.into(),
            owner,
        }))
    }
    fn resolve(&self, selection: &HistoricalAttachmentSelection) -> Result<Target> {
        ensure!(
            PrivateDirectory::open_existing(&self.root)?.directory_identity()?
                == self.profile.directory_identity()?,
            "history_attachment_owner_changed"
        );
        let jobs = HistoryJobStore::open_existing(&self.root)?
            .context("history_attachment_source_missing")?;
        let revision = jobs.normalization_revision(&selection.job_id)?;
        let tool = if let Some(view) = &selection.view_id {
            HistoryBranchStore::open(&self.root)?.tool_attachments(
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
            Ok(catalog) => {
                return Ok(Target::Tool {
                    catalog: Box::new(catalog),
                    item: selection.tool_item_index,
                });
            }
            Err(error) if error.to_string() == "history_tool_attachments_not_a_result" => {}
            Err(error) => return Err(error),
        }
        ensure!(
            selection.tool_item_index.is_none(),
            "history_tool_attachments_not_a_result"
        );
        if let Some(view) = &selection.view_id {
            Ok(Target::Selected(Box::new(
                HistoryBranchStore::open(&self.root)?.attachment(
                    &selection.job_id,
                    view,
                    selection.position,
                    selection.block_index,
                )?,
            )))
        } else {
            Ok(Target::Raw {
                view: Box::new(HistoryAttachmentView::open_with_revision(
                    jobs.archive_reader(&selection.job_id)?,
                    &revision,
                )?),
                record: selection.position,
                block: selection.block_index,
            })
        }
    }
    fn key(&self, selection: &HistoricalAttachmentSelection) -> Result<(String, String, Target)> {
        let target = self.resolve(selection)?;
        let content = target.identity()?;
        let id = hash(&serde_json::to_vec(&(
            "attachment-jobs/1",
            &self.owner,
            selection,
            &content,
        ))?);
        Ok((id, content, target))
    }
    fn optional<T: serde::de::DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        let file = match self.directory.open_regular_file_snapshot(OsStr::new(name)) {
            Ok(v) => v,
            Err(e) if missing(&e) => return Ok(None),
            Err(e) => return Err(e),
        };
        ensure!(
            file.metadata()?.len() <= META,
            "history_attachment_job_budget_exceeded"
        );
        let mut bytes = Vec::new();
        file.take(META + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= META,
            "history_attachment_job_budget_exceeded"
        );
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| anyhow::anyhow!("history_attachment_job_invalid"))
    }
    fn lock(&self, name: &str) -> Result<File> {
        self.directory
            .try_exclusive_lock(OsStr::new(name))?
            .context("history_attachment_job_busy")
    }
    fn save<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        ensure!(
            bytes.len() as u64 <= META,
            "history_attachment_job_budget_exceeded"
        );
        self.directory.atomic_replace(OsStr::new(name), &bytes)
    }
    fn load(
        &self,
        id: &str,
        content: &str,
        selection: &HistoricalAttachmentSelection,
    ) -> Result<Option<Job>> {
        let Some(job) = self.optional::<Job>(&format!("{id}.json"))? else {
            return Ok(None);
        };
        ensure!(
            matches!(job.version, 1 | 2)
                && (job.version == 2 || job.source_reference.is_none() && job.retirement.is_none())
                && hash(&serde_json::to_vec(&(
                    "attachment-jobs/1",
                    &self.owner,
                    selection,
                    content
                ))?) == id
                && job.owner == self.owner
                && job.content == content
                && job.selection == *selection
                && job.view.id == id
                && job.view.processed_bytes <= EXTERNAL_HISTORY_MAX_BYTES,
            "history_attachment_job_changed"
        );
        ensure!(
            !matches!(
                job.view.stage,
                HistoricalAttachmentJobStage::Ready | HistoricalAttachmentJobStage::Unavailable
            ) || job.view.info.is_some(),
            "history_attachment_job_invalid"
        );
        if job.view.stage == HistoricalAttachmentJobStage::Ready {
            ensure!(
                job.view
                    .info
                    .as_ref()
                    .and_then(|v| v.receipt.as_ref())
                    .is_some(),
                "history_attachment_job_invalid"
            );
        }
        if job.view.stage == HistoricalAttachmentJobStage::Catalogued {
            ensure!(
                job.view.catalog.is_some() && job.view.info.is_none(),
                "history_attachment_job_invalid"
            );
        }
        Ok(Some(job))
    }
    fn control(&self, id: &str) -> Result<Control> {
        let value = self
            .optional::<Control>(&format!("{id}.cancel.json"))?
            .unwrap_or_default();
        ensure!(
            value.acknowledged <= value.revision,
            "history_attachment_control_invalid"
        );
        Ok(value)
    }
    fn observe(&self, mut job: Job, target: &Target) -> Result<HistoricalAttachmentJobView> {
        ensure!(job.retirement.is_none(), "history_attachment_job_retired");
        self.verify_source_reference(&job)?;
        if job.view.stage == HistoricalAttachmentJobStage::Ready {
            ensure!(
                target.receipt()? == job.view.info.as_ref().and_then(|v| v.receipt.clone()),
                "history_attachment_receipt_changed"
            );
        }
        if job.view.stage == HistoricalAttachmentJobStage::Catalogued {
            let Target::Tool {
                catalog,
                item: None,
            } = target
            else {
                anyhow::bail!("history_attachment_job_changed")
            };
            ensure!(
                catalog.summary()? == job.view.catalog,
                "history_attachment_receipt_changed"
            );
        }
        let control = self.control(&job.view.id)?;
        job.view.cancel_revision = control.revision;
        job.view.cancel_requested = !matches!(
            job.view.stage,
            HistoricalAttachmentJobStage::Ready
                | HistoricalAttachmentJobStage::Unavailable
                | HistoricalAttachmentJobStage::Catalogued
        ) && control.revision > control.acknowledged;
        Ok(job.view)
    }
    pub fn read(
        &self,
        selection: &HistoricalAttachmentSelection,
    ) -> Result<Option<HistoricalAttachmentJobView>> {
        let (id, content, target) = self.key(selection)?;
        self.load(&id, &content, selection)?
            .map(|job| self.observe(job, &target))
            .transpose()
    }
    pub fn require_tool_result(&self, selection: &HistoricalAttachmentSelection) -> Result<()> {
        ensure!(
            matches!(self.resolve(selection)?, Target::Tool { .. }),
            "history_tool_attachments_not_a_result"
        );
        Ok(())
    }
    pub fn prepare(
        &self,
        selection: &HistoricalAttachmentSelection,
    ) -> Result<HistoricalAttachmentJobView> {
        let (id, content, target) = self.key(selection)?;
        let _catalog = self.lock("catalog.lock")?;
        if let Some(mut job) = self.load(&id, &content, selection)? {
            ensure!(job.retirement.is_none(), "history_attachment_job_retired");
            self.pin_source_reference(&mut job, &target)?;
            return self.observe(job, &target);
        }
        let mut count = 0;
        self.directory
            .visit_entry_names_bounded(MAX_JOBS * 4 + 4, |name| {
                if name
                    .to_str()
                    .is_some_and(|v| v.ends_with(".json") && !v.ends_with(".cancel.json"))
                {
                    count += 1;
                }
                Ok(())
            })?;
        ensure!(
            count < MAX_JOBS,
            "history_attachment_job_count_budget_exceeded"
        );
        let mut job = Job {
            version: if target.archive().lifecycle_guard().is_managed() {
                2
            } else {
                1
            },
            owner: self.owner.clone(),
            selection: selection.clone(),
            content,
            cancel_revision: 0,
            source_reference: None,
            retirement: None,
            view: HistoricalAttachmentJobView {
                id: id.clone(),
                sequence: 0,
                stage: HistoricalAttachmentJobStage::Planned,
                processed_bytes: 0,
                info: None,
                catalog: None,
                failure_code: None,
                cancel_requested: false,
                cancel_revision: 0,
            },
        };
        self.save(&format!("{id}.json"), &job)?;
        self.pin_source_reference(&mut job, &target)?;
        self.observe(job, &target)
    }
    pub fn running(&self, selection: &HistoricalAttachmentSelection) -> Result<bool> {
        let (id, _, _) = self.key(selection)?;
        Ok(self
            .directory
            .try_exclusive_lock(OsStr::new(&format!("{id}.run.lock")))?
            .is_none())
    }
    pub fn cancel(
        &self,
        selection: &HistoricalAttachmentSelection,
    ) -> Result<HistoricalAttachmentJobView> {
        let view = self.prepare(selection)?;
        if matches!(
            view.stage,
            HistoricalAttachmentJobStage::Ready
                | HistoricalAttachmentJobStage::Unavailable
                | HistoricalAttachmentJobStage::Catalogued
        ) {
            return Ok(view);
        }
        let _guard = self.lock(&format!("{}.control.lock", view.id))?;
        let mut control = self.control(&view.id)?;
        control.revision = control
            .revision
            .checked_add(1)
            .context("history_attachment_sequence_exhausted")?;
        self.save(&format!("{}.cancel.json", view.id), &control)?;
        self.read(selection)?
            .context("history_attachment_job_missing")
    }
    fn checkpoint(&self, job: &mut Job) -> Result<()> {
        job.view.sequence = job
            .view
            .sequence
            .checked_add(1)
            .context("history_attachment_sequence_exhausted")?;
        self.save(&format!("{}.json", job.view.id), job)
    }
    pub fn run(
        &self,
        selection: &HistoricalAttachmentSelection,
        resume: Option<u64>,
        mut check: impl FnMut() -> bool,
    ) -> Result<HistoricalAttachmentJobView> {
        let before = self.prepare(selection)?;
        let _runner = self.lock(&format!("{}.run.lock", before.id))?;
        let (id, content, target) = self.key(selection)?;
        let mut job = self
            .load(&id, &content, selection)?
            .context("history_attachment_job_missing")?;
        if matches!(
            job.view.stage,
            HistoricalAttachmentJobStage::Ready
                | HistoricalAttachmentJobStage::Unavailable
                | HistoricalAttachmentJobStage::Catalogued
        ) {
            return self.observe(job, &target);
        }
        let stopped = matches!(
            job.view.stage,
            HistoricalAttachmentJobStage::Cancelled | HistoricalAttachmentJobStage::Failed
        );
        ensure!(
            if stopped {
                resume == Some(job.view.sequence)
            } else {
                resume.is_none()
            },
            "history_attachment_resume_required"
        );
        if stopped {
            let _guard = self.lock(&format!("{id}.control.lock"))?;
            let mut control = self.control(&id)?;
            control.acknowledged = control.acknowledged.max(job.cancel_revision);
            ensure!(
                control.acknowledged <= control.revision,
                "history_attachment_control_invalid"
            );
            self.save(&format!("{id}.cancel.json"), &control)?;
        }
        job.view.stage = HistoricalAttachmentJobStage::Inspecting;
        job.view.processed_bytes = 0;
        job.view.failure_code = None;
        job.view.info = None;
        job.view.catalog = None;
        self.checkpoint(&mut job)?;
        let mut cancelled = false;
        let mut failure = None;
        let result = target.process(|phase, at| {
            match self.control(&id) {
                Ok(control) if control.revision > control.acknowledged => {
                    job.cancel_revision = control.revision;
                    cancelled = true;
                    return false;
                }
                Ok(_) => {}
                Err(e) => {
                    failure = Some(safe(&e));
                    return false;
                }
            }
            if !check() {
                cancelled = true;
                return false;
            }
            let stage = match phase {
                HistoricalAttachmentStage::Inspecting => HistoricalAttachmentJobStage::Inspecting,
                HistoricalAttachmentStage::Extracting => HistoricalAttachmentJobStage::Extracting,
            };
            if job.view.stage != stage || at.saturating_sub(job.view.processed_bytes) >= 1024 * 1024
            {
                job.view.stage = stage;
                job.view.processed_bytes = at;
                if let Err(e) = self.checkpoint(&mut job) {
                    failure = Some(safe(&e));
                    return false;
                }
            }
            true
        });
        match result {
            Ok(Processed::Attachment(info)) => {
                job.view.stage = if info.receipt.is_some() {
                    HistoricalAttachmentJobStage::Ready
                } else {
                    HistoricalAttachmentJobStage::Unavailable
                };
                job.view.processed_bytes = info
                    .receipt
                    .as_ref()
                    .map_or(job.view.processed_bytes, |v| v.bytes);
                job.view.info = Some(info);
            }
            Ok(Processed::Catalog(catalog)) => {
                job.view.stage = HistoricalAttachmentJobStage::Catalogued;
                job.view.catalog = Some(catalog);
            }
            Err(e) => {
                job.view.stage = if cancelled && failure.is_none() {
                    HistoricalAttachmentJobStage::Cancelled
                } else {
                    HistoricalAttachmentJobStage::Failed
                };
                job.view.failure_code = if job.view.stage == HistoricalAttachmentJobStage::Failed {
                    Some(failure.unwrap_or_else(|| safe(&e)))
                } else {
                    None
                };
            }
        }
        self.checkpoint(&mut job)?;
        self.observe(job, &target)
    }
    pub fn tool_items(
        &self,
        selection: &HistoricalAttachmentSelection,
        cursor: u32,
    ) -> Result<HistoricalToolAttachmentPage> {
        let (id, content, target) = self.key(selection)?;
        let job = self
            .load(&id, &content, selection)?
            .context("history_attachment_job_missing")?;
        ensure!(
            job.view.stage == HistoricalAttachmentJobStage::Catalogued,
            "history_tool_attachments_not_ready"
        );
        self.observe(job, &target)?;
        let Target::Tool {
            catalog,
            item: None,
        } = target
        else {
            anyhow::bail!("history_tool_attachments_select_collection")
        };
        catalog.page(cursor)
    }
    pub fn chunk(
        &self,
        selection: &HistoricalAttachmentSelection,
        offset: u64,
        limit: usize,
    ) -> Result<(HistoricalAttachmentReceipt, Vec<u8>)> {
        ensure!(
            (1..=HISTORICAL_ATTACHMENT_CHUNK_BYTES).contains(&limit),
            "history_attachment_invalid_range"
        );
        let (id, content, target) = self.key(selection)?;
        let job = self
            .load(&id, &content, selection)?
            .context("history_attachment_job_missing")?;
        ensure!(
            job.view.stage == HistoricalAttachmentJobStage::Ready,
            "history_attachment_not_ready"
        );
        let view = self.observe(job, &target)?;
        let receipt = view
            .info
            .and_then(|v| v.receipt)
            .context("history_attachment_not_ready")?;
        let bytes = target.chunk(offset, limit)?;
        Ok((receipt, bytes))
    }
}
