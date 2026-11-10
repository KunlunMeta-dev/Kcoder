//! Durable per-profile migration facts. Native asset mutations remain domain-owned.
use crate::MigrationInventory;
use crate::providers::{ProviderPlan, ProviderResolution, ProviderTarget};
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::migration::{MigrationItemStatus as ItemStatus, MigrationJobStatus as JobStatus};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, ffi::OsStr, io::Read, path::Path};

const SCHEMA_VERSION: u32 = 1;
const MAX_JOURNAL_BYTES: u64 = 16 * 1024 * 1024;
mod assets;
mod atomic_credentials;
mod batch;
mod batch_credentials;
mod batch_mcp_credentials;
mod credential_sources;
mod credentials;
mod definitions;
mod history_parent;
mod mcp;
mod mcp_credentials;
mod private_credentials;
mod project;
pub(crate) use history_parent::HistoryResourceParent;
mod received;
mod records;
mod reuse;
mod templates;
pub use batch::BatchTargets;
pub use batch::creation::{
    BatchCaptureInput, BatchCreateIntent, BatchCreationBinding, BatchCreationObservation,
    BatchCreationStage, BatchCreationWorkerState,
};
pub use credentials::{CredentialResolution, CredentialTargets};
pub use definitions::DefinitionSnapshot;
pub use records::MigrationRecord;
pub use templates::provider_item_id as template_provider_item_id;

#[cfg(test)]
thread_local! {
    static FAIL_AFTER_PROVIDER_PUBLICATION: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAIL_AFTER_PROVIDER_ROLLBACK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemCommitReceipt {
    pub item_id: String,
    pub operation_id: String,
    pub target_id: String,
    pub target_revision: String,
    #[serde(default)]
    pub ownership_confirmed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationJob {
    pub schema_version: u32,
    pub job_id: String,
    pub source_id: String,
    pub sequence: u64,
    pub status: JobStatus,
    pub inventory: MigrationInventory,
    pub selected_item_ids: Vec<String>,
    pub receipts: Vec<ItemCommitReceipt>,
    #[serde(default)]
    pub provider_plans: Vec<ProviderPlan>,
    #[serde(default)]
    pub mcp_plans: Vec<crate::mcp::McpPlan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_binding: Option<crate::discovery::ConfigurationBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_binding: Option<crate::asset_sources::AssetBundleBinding>,
    #[serde(default)]
    pub asset_plans: Vec<crate::assets::AssetPlan>,
    #[serde(default)]
    pub batch: Option<crate::batch::BatchState>,
    #[serde(default)]
    pub created_at_ms: u64,
    #[serde(default)]
    pub credential_plans: Vec<crate::credentials::CredentialPlan>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_credential_plans: Vec<crate::mcp_credentials::McpCredentialPlan>,
}

pub struct MigrationStore {
    directory: PrivateDirectory,
    profile: std::path::PathBuf,
}

impl MigrationJob {
    pub fn has_unconfirmed_credentials(&self) -> bool {
        self.credential_plans
            .iter()
            .map(|plan| plan.phase)
            .chain(self.mcp_credential_plans.iter().map(|plan| plan.phase))
            .any(|phase| {
                matches!(
                    phase,
                    crate::credentials::CredentialPhase::Applying
                        | crate::credentials::CredentialPhase::Unknown
                        | crate::credentials::CredentialPhase::Undoing
                )
            })
    }
}

impl MigrationStore {
    pub fn open_or_create(profile: &Path) -> Result<Self> {
        let parent = PrivateDirectory::open_existing(profile)?;
        parent.verify_trusted_config_directory()?;
        let directory = match parent.open_child(OsStr::new("migrations"), false) {
            Ok(directory) => directory,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                parent.create_private_child(OsStr::new("migrations"))?
            }
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        Ok(Self {
            directory,
            profile: profile.canonicalize()?,
        })
    }

    pub fn open_existing(profile: &Path) -> Result<Self> {
        let parent = PrivateDirectory::open_existing(profile)?;
        parent.verify_trusted_config_directory()?;
        let directory = parent.open_child(OsStr::new("migrations"), false)?;
        directory.verify_private_directory()?;
        Ok(Self {
            directory,
            profile: profile.canonicalize()?,
        })
    }

    pub fn create_scan(
        &self,
        source_id: &str,
        inventory: MigrationInventory,
    ) -> Result<MigrationJob> {
        self.create_scan_with_binding(source_id, inventory, None, None, None)
    }

    fn create_scan_with_binding(
        &self,
        source_id: &str,
        inventory: MigrationInventory,
        source_binding: Option<crate::discovery::ConfigurationBinding>,
        asset_binding: Option<crate::asset_sources::AssetBundleBinding>,
        batch: Option<crate::batch::BatchState>,
    ) -> Result<MigrationJob> {
        let job = Self::new_scan(
            &format!("mig-{}", uuid::Uuid::new_v4().simple()),
            source_id,
            inventory,
            source_binding,
            asset_binding,
            batch,
        )?;
        let _lock = self.write_lock()?;
        self.save(&job)?;
        Ok(job)
    }
    fn new_scan(
        job_id: &str,
        source_id: &str,
        inventory: MigrationInventory,
        source_binding: Option<crate::discovery::ConfigurationBinding>,
        asset_binding: Option<crate::asset_sources::AssetBundleBinding>,
        batch: Option<crate::batch::BatchState>,
    ) -> Result<MigrationJob> {
        job_file(job_id)?;
        ensure!(
            opaque_reference(source_id),
            "migration_invalid_source_reference"
        );
        validate_inventory(&inventory)?;
        ensure!(
            inventory.items.iter().all(|item| matches!(
                item.preview.status,
                ItemStatus::Discovered | ItemStatus::RequiresAction
            )),
            "migration_invalid_initial_status"
        );
        let job = MigrationJob {
            schema_version: SCHEMA_VERSION,
            job_id: job_id.into(),
            source_id: source_id.into(),
            sequence: 1,
            status: JobStatus::Ready,
            inventory,
            selected_item_ids: Vec::new(),
            receipts: Vec::new(),
            provider_plans: Vec::new(),
            mcp_plans: Vec::new(),
            source_binding,
            asset_binding,
            asset_plans: Vec::new(),
            batch,
            created_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis()
                .try_into()?,
            credential_plans: Vec::new(),
            mcp_credential_plans: Vec::new(),
        };
        Ok(job)
    }

    pub fn create_bound_scan(
        &self,
        binding: crate::discovery::ConfigurationBinding,
    ) -> Result<MigrationJob> {
        let inventory = binding.inventory()?;
        self.create_scan_with_binding(
            &format!("src-{}", uuid::Uuid::new_v4().simple()),
            inventory,
            Some(binding),
            None,
            None,
        )
    }

    pub fn create_asset_scan(
        &self,
        binding: crate::asset_sources::AssetBundleBinding,
    ) -> Result<MigrationJob> {
        binding.verify_batch_parent(&self.directory)?;
        let (binding, inventory) = binding.freeze()?;
        self.create_scan_with_binding(
            &format!("src-{}", uuid::Uuid::new_v4().simple()),
            inventory,
            None,
            Some(binding),
            None,
        )
    }

    pub fn read(&self, job_id: &str) -> Result<MigrationJob> {
        let _lock = self.journal_lock(false)?;
        self.load(job_id)
    }

    /// Stage one selected Provider against a target revision, without publishing settings.
    pub fn prepare_provider(
        &self,
        job_id: &str,
        expected_sequence: u64,
        target: &ProviderTarget,
        resolution: &ProviderResolution,
    ) -> Result<MigrationJob> {
        self.update(job_id, expected_sequence, |job| {
            ensure!(
                job.status == JobStatus::Ready
                    && job.provider_plans.is_empty()
                    && job.batch.is_none(),
                "migration_invalid_transition"
            );
            ensure!(
                job.selected_item_ids == [resolution.item_id.clone()],
                "migration_provider_selection_required"
            );
            ensure!(
                !job.inventory
                    .issues
                    .iter()
                    .any(|issue| issue.blocks_import()),
                "migration_source_requires_resolution"
            );
            let item = job
                .inventory
                .items
                .iter_mut()
                .find(|item| item.preview.id == resolution.item_id)
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
            let plan = target.prepare(item, resolution)?;
            *item = plan.item().clone();
            job.provider_plans.push(plan);
            Ok(true)
        })
    }

    /// Publish only the exact staged plan. An interrupted write remains reconcilable.
    pub fn apply_provider(
        &self,
        job_id: &str,
        expected_sequence: u64,
        plan_id: &str,
        target: &ProviderTarget,
    ) -> Result<MigrationJob> {
        let _lock = self.write_lock()?;
        let mut job = self.load(job_id)?;
        ensure!(job.batch.is_none(), "migration_batch_operation_required");
        let plan = job
            .provider_plans
            .iter()
            .find(|plan| plan.id() == plan_id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_plan"))?
            .clone();
        target.check_binding(&plan)?;
        if job
            .receipts
            .iter()
            .any(|receipt| receipt.operation_id == plan_id)
        {
            return Ok(job);
        }
        ensure!(
            job.sequence == expected_sequence,
            "migration_revision_conflict"
        );
        ensure!(
            matches!(
                job.status,
                JobStatus::Ready | JobStatus::Applying | JobStatus::CancelRequested
            ),
            "migration_invalid_transition"
        );
        let index = job
            .inventory
            .items
            .iter()
            .position(|item| item.preview.id == plan.item().preview.id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        let status = job.inventory.items[index].preview.status;
        let source_blocked = job
            .source_binding
            .as_ref()
            .is_some_and(|binding| binding.validate_provider_item(plan.item()).is_err());
        if status == ItemStatus::Staged {
            ensure!(!source_blocked, "migration_source_changed");
        }
        ensure!(
            matches!(
                status,
                ItemStatus::Staged | ItemStatus::Committing | ItemStatus::CommitUnknown
            ),
            "migration_invalid_transition"
        );
        let cancelled = job.status == JobStatus::CancelRequested;
        if status == ItemStatus::Staged {
            ensure!(!cancelled, "migration_cancel_pending");
            job.status = JobStatus::Applying;
            job.inventory.items[index].preview.status = ItemStatus::Committing;
            job.sequence = job
                .sequence
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("migration_sequence_exhausted"))?;
            self.save(&job)?;
        }
        let publication = match target.publish(&plan, cancelled, source_blocked) {
            Ok(publication) => publication,
            Err(error) => {
                job.inventory.items[index].preview.status = ItemStatus::CommitUnknown;
                let cancel_settled =
                    error.to_string() == "migration_cancelled_unsettled_publication";
                if cancel_settled {
                    job.status = JobStatus::Cancelled;
                }
                job.sequence = job
                    .sequence
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("migration_sequence_exhausted"))?;
                self.save(&job)?;
                if cancel_settled {
                    return Ok(job);
                }
                return Err(error);
            }
        };
        #[cfg(test)]
        if FAIL_AFTER_PROVIDER_PUBLICATION.with(|fail| fail.replace(false)) {
            anyhow::bail!("migration_injected_lost_publication_receipt");
        }
        job.receipts.push(ItemCommitReceipt {
            item_id: plan.item().preview.id.clone(),
            operation_id: plan_id.into(),
            target_id: publication.target_id,
            target_revision: publication.target_revision,
            ownership_confirmed: publication.ownership_confirmed,
        });
        job.inventory.items[index].preview.status = ItemStatus::Committed;
        job.status = if cancelled {
            JobStatus::Cancelled
        } else if job.inventory.items[index]
            .preview
            .issues
            .iter()
            .any(|issue| {
                issue.severity == kcoder_types::migration::MigrationIssueSeverity::Blocking
            })
        {
            JobStatus::CompletedWithIssues
        } else {
            JobStatus::Completed
        };
        job.sequence = job
            .sequence
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("migration_sequence_exhausted"))?;
        self.save(&job)?;
        Ok(job)
    }

    pub fn rollback_provider(
        &self,
        job_id: &str,
        expected_sequence: u64,
        plan_id: &str,
        target: &ProviderTarget,
    ) -> Result<MigrationJob> {
        let _lock = self.write_lock()?;
        let mut job = self.load(job_id)?;
        let plan = job
            .provider_plans
            .iter()
            .find(|plan| plan.id() == plan_id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_plan"))?
            .clone();
        target.check_binding(&plan)?;
        let index = job
            .inventory
            .items
            .iter()
            .position(|item| item.preview.id == plan.item().preview.id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        if job.status == JobStatus::RolledBack
            && job.inventory.items[index].preview.status == ItemStatus::RolledBack
        {
            return Ok(job);
        }
        ensure!(
            job.sequence == expected_sequence,
            "migration_revision_conflict"
        );
        ensure!(
            matches!(
                job.status,
                JobStatus::Completed
                    | JobStatus::CompletedWithIssues
                    | JobStatus::Cancelled
                    | JobStatus::RollingBack
                    | JobStatus::RollbackConflict
            ),
            "migration_invalid_transition"
        );
        let receipt = job
            .receipts
            .iter()
            .find(|receipt| receipt.operation_id == plan_id)
            .ok_or_else(|| anyhow::anyhow!("migration_commit_receipt_required"))?;
        ensure!(
            receipt.ownership_confirmed,
            "migration_rollback_ownership_unknown"
        );
        job.status = JobStatus::RollingBack;
        job.sequence = job
            .sequence
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("migration_sequence_exhausted"))?;
        self.save(&job)?;
        if let Err(error) = self
            .require_unreferenced(job_id, plan.id())
            .and_then(|_| target.rollback(&plan))
        {
            if matches!(
                error.to_string().as_str(),
                "migration_target_changed"
                    | "migration_result_referenced"
                    | "migration_provider_credentials_depend_on_import"
            ) {
                job.status = JobStatus::RollbackConflict;
                job.inventory.items[index].preview.status = ItemStatus::RollbackConflict;
            }
            job.sequence = job
                .sequence
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("migration_sequence_exhausted"))?;
            self.save(&job)?;
            return Err(error);
        }
        #[cfg(test)]
        if FAIL_AFTER_PROVIDER_ROLLBACK.with(|fail| fail.replace(false)) {
            anyhow::bail!("migration_injected_lost_rollback_receipt");
        }
        job.status = JobStatus::RolledBack;
        job.inventory.items[index].preview.status = ItemStatus::RolledBack;
        job.sequence = job
            .sequence
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("migration_sequence_exhausted"))?;
        self.save(&job)?;
        Ok(job)
    }

    pub fn select(
        &self,
        job_id: &str,
        expected_sequence: u64,
        ids: &[String],
    ) -> Result<MigrationJob> {
        self.update(job_id, expected_sequence, |job| {
            ensure!(job.batch.is_none(), "migration_batch_operation_required");
            ensure!(
                job.status == JobStatus::Ready,
                "migration_invalid_transition"
            );
            let requested = ids.iter().collect::<BTreeSet<_>>();
            ensure!(
                requested.len() == ids.len(),
                "migration_duplicate_selection"
            );
            ensure!(
                ids.iter().all(|id| job
                    .inventory
                    .items
                    .iter()
                    .any(|item| &item.preview.id == id)),
                "migration_unknown_item"
            );
            if job.selected_item_ids == ids {
                return Ok(false);
            }
            ensure!(
                job.inventory.items.iter().all(|item| matches!(
                    item.preview.status,
                    ItemStatus::Discovered | ItemStatus::RequiresAction | ItemStatus::Selected
                )),
                "migration_invalid_transition"
            );
            for item in &mut job.inventory.items {
                if requested.contains(&item.preview.id)
                    && item.preview.status != ItemStatus::RequiresAction
                {
                    item.preview.status = ItemStatus::Selected;
                } else if item.preview.status == ItemStatus::Selected {
                    item.preview.status = if item.preview.issues.iter().any(|issue| {
                        issue.severity == kcoder_types::migration::MigrationIssueSeverity::Blocking
                    }) {
                        ItemStatus::RequiresAction
                    } else {
                        ItemStatus::Discovered
                    };
                }
            }
            job.selected_item_ids = ids.to_vec();
            Ok(true)
        })
    }

    /// The coordinator supplies observations; this method never performs a tool or asset write.
    pub fn transition_item(
        &self,
        job_id: &str,
        expected_sequence: u64,
        item_id: &str,
        next: ItemStatus,
    ) -> Result<MigrationJob> {
        self.update(job_id, expected_sequence, |job| {
            ensure!(
                matches!(
                    job.status,
                    JobStatus::Ready | JobStatus::Applying | JobStatus::CancelRequested
                ),
                "migration_invalid_transition"
            );
            let item = job
                .inventory
                .items
                .iter_mut()
                .find(|item| item.preview.id == item_id)
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
            let current = item.preview.status;
            if current == next {
                return Ok(false);
            }
            ensure!(
                matches!(
                    (current, next),
                    (
                        ItemStatus::Selected,
                        ItemStatus::Staged
                            | ItemStatus::RequiresAction
                            | ItemStatus::Failed
                            | ItemStatus::Skipped
                    ) | (
                        ItemStatus::Staged,
                        ItemStatus::Committing | ItemStatus::Failed | ItemStatus::Skipped
                    ) | (ItemStatus::Committing, ItemStatus::CommitUnknown)
                ),
                "migration_invalid_transition"
            );
            if next == ItemStatus::Staged || next == ItemStatus::Committing {
                ensure!(
                    job.status != JobStatus::CancelRequested,
                    "migration_cancel_pending"
                );
                ensure!(
                    !item
                        .preview
                        .issues
                        .iter()
                        .any(|issue| issue.blocks_import()),
                    "migration_item_requires_resolution"
                );
                job.status = JobStatus::Applying;
            }
            item.preview.status = next;
            Ok(true)
        })
    }

    /// A domain receipt reconciles a write, including a previous unknown result.
    pub fn record_commit(
        &self,
        job_id: &str,
        expected_sequence: u64,
        receipt: ItemCommitReceipt,
    ) -> Result<MigrationJob> {
        ensure!(
            [
                &receipt.item_id,
                &receipt.operation_id,
                &receipt.target_id,
                &receipt.target_revision
            ]
            .iter()
            .all(|value| opaque_reference(value)),
            "migration_invalid_receipt"
        );
        self.update(job_id, expected_sequence, |job| {
            if let Some(previous) = job.receipts.iter().find(|value| {
                value.item_id == receipt.item_id || value.operation_id == receipt.operation_id
            }) {
                ensure!(previous == &receipt, "migration_receipt_conflict");
                return Ok(false);
            }
            ensure!(
                matches!(job.status, JobStatus::Applying | JobStatus::CancelRequested),
                "migration_invalid_transition"
            );
            let item = job
                .inventory
                .items
                .iter_mut()
                .find(|item| item.preview.id == receipt.item_id)
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
            ensure!(
                matches!(
                    item.preview.status,
                    ItemStatus::Committing | ItemStatus::CommitUnknown
                ),
                "migration_invalid_transition"
            );
            item.preview.status = ItemStatus::Committed;
            job.receipts.push(receipt);
            Ok(true)
        })
    }

    pub fn cancel(&self, job_id: &str, expected_sequence: u64) -> Result<MigrationJob> {
        self.update(job_id, expected_sequence, |job| {
            self.ensure_no_pending_received_preparation(job)?;
            Self::request_cancel(job)
        })
    }

    fn request_cancel(job: &mut MigrationJob) -> Result<bool> {
        if job.status == JobStatus::Cancelled {
            return Ok(false);
        }
        ensure!(
            matches!(
                job.status,
                JobStatus::Ready | JobStatus::Applying | JobStatus::CancelRequested
            ) || job.status == JobStatus::CompletedWithIssues && job.has_unconfirmed_credentials(),
            "migration_invalid_transition"
        );
        let unsettled = job.has_unconfirmed_credentials()
            || job.inventory.items.iter().any(|item| {
                matches!(
                    item.preview.status,
                    ItemStatus::Committing | ItemStatus::CommitUnknown
                )
            });
        let next = if unsettled {
            JobStatus::CancelRequested
        } else {
            JobStatus::Cancelled
        };
        if next == job.status {
            return Ok(false);
        }
        job.status = next;
        Ok(true)
    }

    fn update(
        &self,
        job_id: &str,
        expected_sequence: u64,
        change: impl FnOnce(&mut MigrationJob) -> Result<bool>,
    ) -> Result<MigrationJob> {
        let _lock = self.write_lock()?;
        let mut job = self.load(job_id)?;
        let previous_sequence = job.sequence;
        if !change(&mut job)? {
            return Ok(job);
        }
        ensure!(
            previous_sequence == expected_sequence,
            "migration_revision_conflict"
        );
        job.sequence = previous_sequence
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("migration_sequence_exhausted"))?;
        self.save(&job)?;
        Ok(job)
    }

    fn write_lock(&self) -> Result<std::fs::File> {
        self.journal_lock(true)
    }

    fn journal_lock(&self, exclusive: bool) -> Result<std::fs::File> {
        for attempt in 0..64 {
            let lease = if exclusive {
                self.directory.try_exclusive_lock(OsStr::new(".lock"))?
            } else {
                self.directory.try_shared_lock(OsStr::new(".lock"))?
            };
            if let Some(lease) = lease {
                return Ok(lease);
            }
            if attempt < 63 {
                // Wait only for the short journal lease; never replay a mutation or publication.
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        Err(crate::contention::busy(if exclusive {
            crate::contention::LeaseKind::JournalWrite
        } else {
            crate::contention::LeaseKind::JournalRead
        }))
    }

    fn load(&self, job_id: &str) -> Result<MigrationJob> {
        let name = job_file(job_id)?;
        let file = self
            .directory
            .open_single_link_regular_file(OsStr::new(&name))
            .map_err(|_| anyhow::anyhow!("migration_job_unavailable"))?;
        ensure!(
            file.metadata()?.len() <= MAX_JOURNAL_BYTES,
            "migration_journal_budget_exceeded"
        );
        let mut bytes = Vec::new();
        file.take(MAX_JOURNAL_BYTES + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= MAX_JOURNAL_BYTES,
            "migration_journal_budget_exceeded"
        );
        let job: MigrationJob = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("migration_invalid_journal"))?;
        ensure!(
            job.schema_version == SCHEMA_VERSION && job.job_id == job_id,
            "migration_invalid_journal"
        );
        validate_inventory(&job.inventory)?;
        ensure!(
            job.credential_plans.len() + job.mcp_credential_plans.len() <= 128,
            "migration_credential_budget_exceeded"
        );
        if let Some(binding) = &job.asset_binding {
            binding.verify_batch_parent(&self.directory)?;
        }
        if let Some(batch) = &job.batch {
            batch.validate()?;
            for source in &batch.sources {
                match source {
                    crate::batch::BatchSource::TransferredConfiguration(binding) => {
                        binding.verify_batch_parent(&self.directory)?
                    }
                    crate::batch::BatchSource::Assets(binding) => {
                        binding.verify_batch_parent(&self.directory)?
                    }
                    crate::batch::BatchSource::History(binding) => {
                        binding.selection().verify_batch_parent(&self.directory)?
                    }
                    _ => {}
                }
            }
            let mut ids = BTreeSet::new();
            ensure!(
                batch.credential_plan_ids.iter().all(|id| ids.insert(id)
                    && (job.credential_plans.iter().any(|plan| &plan.plan_id == id)
                        || job
                            .mcp_credential_plans
                            .iter()
                            .any(|plan| &plan.plan_id == id))),
                "migration_invalid_journal"
            );
        }
        batch::creation::verify_created_job(self, &job)?;
        Ok(job)
    }

    fn save(&self, job: &MigrationJob) -> Result<()> {
        let name = job_file(&job.job_id)?;
        let bytes = serde_json::to_vec(job)?;
        ensure!(
            bytes.len() as u64 <= MAX_JOURNAL_BYTES,
            "migration_journal_budget_exceeded"
        );
        self.directory.atomic_replace(OsStr::new(&name), &bytes)
    }
}

fn job_file(id: &str) -> Result<String> {
    ensure!(
        id.len() == 36
            && id.starts_with("mig-")
            && id[4..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
        "migration_invalid_job_reference"
    );
    Ok(format!("{id}.json"))
}
fn opaque_reference(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_:.".contains(&byte))
}
fn validate_inventory(inventory: &MigrationInventory) -> Result<()> {
    ensure!(
        inventory.items.len() <= 1024,
        "migration_inventory_budget_exceeded"
    );
    let ids = inventory
        .items
        .iter()
        .map(|item| &item.preview.id)
        .collect::<BTreeSet<_>>();
    ensure!(
        ids.len() == inventory.items.len() && ids.into_iter().all(|id| opaque_reference(id)),
        "migration_invalid_inventory"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::NormalizedItem;
    use kcoder_types::migration::{MigrationCategory, MigrationItemPreview, MigrationSourceKind};

    fn inventory() -> MigrationInventory {
        MigrationInventory {
            source: MigrationSourceKind::Codex,
            adapter_revision: "fixture/v1".into(),
            issues: vec![],
            items: vec![NormalizedItem {
                preview: MigrationItemPreview {
                    id: "item".into(),
                    category: MigrationCategory::Instructions,
                    source_name: "fixture".into(),
                    status: ItemStatus::Discovered,
                    selected_by_default: true,
                    issues: vec![],
                },
                provider: None,
                mcp: None,
                asset: None,
                template: None,
            }],
        }
    }
    fn prepare_committing(store: &MigrationStore) -> MigrationJob {
        let job = store.create_scan("source", inventory()).unwrap();
        let job = store
            .select(&job.job_id, job.sequence, &["item".into()])
            .unwrap();
        let job = store
            .transition_item(&job.job_id, job.sequence, "item", ItemStatus::Staged)
            .unwrap();
        store
            .transition_item(&job.job_id, job.sequence, "item", ItemStatus::Committing)
            .unwrap()
    }
    #[test]
    fn codex_project_providers_and_older_staged_plans_cannot_be_promoted_to_user_settings() {
        use crate::discovery::{DiscoveryRoots, SourceRegistry};
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let profile = root.path().join("profile");
        std::fs::create_dir_all(project.join(".codex")).unwrap();
        std::fs::create_dir(&profile).unwrap();
        let source = "model='fixture'\nmodel_provider='IgnoredProjectProvider'\n[model_providers.IgnoredProjectProvider]\nbase_url='https://example.invalid'\nwire_api='responses'\n[mcp_servers.documents]\ncommand='never-run-this-fixture'\n";
        std::fs::write(project.join(".codex/config.toml"), source).unwrap();
        let mut registry = SourceRegistry::new(DiscoveryRoots {
            home: root.path().into(),
            claude_config_dir: None,
            codex_home: None,
            project: Some(project),
        });
        let found = registry.discover(&[MigrationSourceKind::Codex], true).0;
        let binding = registry
            .selected(
                &found
                    .iter()
                    .find(|source| source.scope == "project")
                    .unwrap()
                    .source_id,
            )
            .unwrap();
        let inventory = binding.inventory().unwrap();
        let provider = inventory
            .items
            .iter()
            .find(|item| item.provider.is_some())
            .unwrap();
        assert!(!provider.preview.selected_by_default);
        assert!(
            provider
                .preview
                .issues
                .iter()
                .any(
                    |issue| issue.field.as_deref() == Some("project_provider_scope")
                        && issue.blocks_import()
                )
        );
        let target = ProviderTarget::open(&profile).unwrap();
        let resolution = ProviderResolution {
            item_id: provider.preview.id.clone(),
            target_name: "Imported".into(),
            endpoint: None,
            model: None,
            limits: Some(crate::providers::ModelLimits {
                context_window_tokens: 64000,
                output_headroom_tokens: 8192,
                max_output_tokens: 8192,
            }),
        };
        assert!(target.prepare(provider, &resolution).is_err());
        let mcp = inventory
            .items
            .iter()
            .find(|item| item.mcp.is_some())
            .unwrap();
        assert!(crate::batch::BatchSource::Configuration(binding.clone()).unchanged(mcp));
        // An older journal may already contain a plan created before scope-aware adaptation.
        let legacy = crate::parse_codex_config(source).unwrap();
        let store = MigrationStore::open_or_create(&profile).unwrap();
        let job = store
            .create_scan_with_binding("fixture", legacy, Some(binding.clone()), None, None)
            .unwrap();
        let job = store
            .select(
                &job.job_id,
                job.sequence,
                std::slice::from_ref(&resolution.item_id),
            )
            .unwrap();
        let job = store
            .prepare_provider(&job.job_id, job.sequence, &target, &resolution)
            .unwrap();
        assert!(
            !crate::batch::BatchSource::Configuration(binding)
                .unchanged(job.provider_plans[0].item())
        );
        assert_eq!(
            store
                .apply_provider(
                    &job.job_id,
                    job.sequence,
                    job.provider_plans[0].id(),
                    &target
                )
                .unwrap_err()
                .to_string(),
            "migration_source_changed"
        );
        assert!(!profile.join("settings.json").exists());
    }
    #[test]
    fn lost_receipt_reconciliation_is_idempotent_across_reopen() {
        let root = tempfile::tempdir().unwrap();
        let store = MigrationStore::open_or_create(root.path()).unwrap();
        let job = prepare_committing(&store);
        let receipt = ItemCommitReceipt {
            item_id: "item".into(),
            operation_id: "operation".into(),
            target_id: "native-item".into(),
            target_revision: "revision".into(),
            ownership_confirmed: false,
        };
        let committed = store
            .record_commit(&job.job_id, job.sequence, receipt.clone())
            .unwrap();
        assert_eq!(
            store
                .record_commit(&job.job_id, job.sequence, receipt.clone())
                .unwrap(),
            committed
        );
        let reopened = MigrationStore::open_existing(root.path()).unwrap();
        assert_eq!(reopened.read(&job.job_id).unwrap(), committed);
        let mut changed = receipt;
        changed.target_revision = "different".into();
        assert!(
            reopened
                .record_commit(&job.job_id, committed.sequence, changed)
                .is_err()
        );
    }
    #[test]
    fn cancellation_does_not_mislabel_an_unknown_write_as_rolled_back() {
        let root = tempfile::tempdir().unwrap();
        let store = MigrationStore::open_or_create(root.path()).unwrap();
        let job = prepare_committing(&store);
        assert_eq!(
            store.read(&job.job_id).unwrap().inventory.items[0]
                .preview
                .status,
            ItemStatus::Committing
        );
        let job = store.cancel(&job.job_id, job.sequence).unwrap();
        assert_eq!(job.status, JobStatus::CancelRequested);
        let job = store
            .transition_item(&job.job_id, job.sequence, "item", ItemStatus::CommitUnknown)
            .unwrap();
        assert_eq!(
            store.cancel(&job.job_id, job.sequence).unwrap().status,
            JobStatus::CancelRequested
        );
        assert!(
            store
                .transition_item(&job.job_id, job.sequence, "item", ItemStatus::Failed)
                .is_err()
        );
    }
    #[test]
    fn stale_writers_and_foreign_paths_cannot_replace_a_job() {
        let root = tempfile::tempdir().unwrap();
        let store = MigrationStore::open_or_create(root.path()).unwrap();
        let job = store.create_scan("source", inventory()).unwrap();
        let selected = store
            .select(&job.job_id, job.sequence, &["item".into()])
            .unwrap();
        assert!(store.cancel(&job.job_id, job.sequence).is_err());
        assert_eq!(store.read(&job.job_id).unwrap(), selected);
        assert!(store.read("../settings").is_err());
        assert!(
            store
                .read("mig-../../aaaaaaaaaaaaaaaaaaaaaaaaaaaa")
                .is_err()
        );
        assert!(
            store
                .create_scan(
                    "source",
                    MigrationInventory {
                        items: vec![inventory().items[0].clone(), inventory().items[0].clone()],
                        ..inventory()
                    }
                )
                .is_err()
        );
    }
    #[test]
    fn unresolved_adapters_cannot_advance_to_native_commit() {
        let root = tempfile::tempdir().unwrap();
        let store = MigrationStore::open_or_create(root.path()).unwrap();
        let inventory = crate::parse_claude_settings("{}").unwrap();
        let id = inventory.items[0].preview.id.clone();
        let job = store.create_scan("source", inventory).unwrap();
        let job = store
            .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
            .unwrap();
        assert_eq!(
            job.inventory.items[0].preview.status,
            ItemStatus::RequiresAction
        );
        assert!(
            store
                .transition_item(&job.job_id, job.sequence, &id, ItemStatus::Staged)
                .is_err()
        );
    }

    fn staged_provider(store: &MigrationStore, target: &ProviderTarget) -> MigrationJob {
        let inventory = crate::parse_claude_settings(
            r#"{
            "model": "office-model",
            "env": {"ANTHROPIC_BASE_URL": "https://gateway.example.invalid",
                "ANTHROPIC_API_KEY": "SYNTHETIC_PRIVATE_CANARY"}
        }"#,
        )
        .unwrap();
        let id = inventory.items[0].preview.id.clone();
        let job = store.create_scan("selected-source", inventory).unwrap();
        let job = store
            .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
            .unwrap();
        store
            .prepare_provider(
                &job.job_id,
                job.sequence,
                target,
                &ProviderResolution {
                    item_id: id,
                    target_name: "ImportedClaude".into(),
                    endpoint: None,
                    model: None,
                    limits: Some(crate::providers::ModelLimits {
                        context_window_tokens: 128000,
                        output_headroom_tokens: 8000,
                        max_output_tokens: 8000,
                    }),
                },
            )
            .unwrap()
    }

    #[test]
    fn native_provider_publication_is_private_idempotent_and_not_claimed_ready() {
        let root = tempfile::tempdir().unwrap();
        let store = MigrationStore::open_or_create(root.path()).unwrap();
        let target = ProviderTarget::open(root.path()).unwrap();
        let job = staged_provider(&store, &target);
        let plan_id = job.provider_plans[0].id().to_owned();
        assert!(!root.path().join("settings.json").exists());
        let committed = store
            .apply_provider(&job.job_id, job.sequence, &plan_id, &target)
            .unwrap();
        assert_eq!(committed.status, JobStatus::CompletedWithIssues);
        assert_eq!(
            committed.inventory.items[0].preview.status,
            ItemStatus::Committed
        );
        assert!(committed.receipts[0].ownership_confirmed);
        let path = root.path().join("settings.json");
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            store
                .apply_provider(&job.job_id, job.sequence, &plan_id, &target)
                .unwrap(),
            committed
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let settings = kcoder_config::read_settings_file(&path).unwrap();
        let resolved = kcoder_config::validate_and_resolve_settings_document(&settings).unwrap();
        // A fresh profile ships no Provider; importing one must not select it.
        assert_eq!(resolved.active_provider, None);
        assert_eq!(
            resolved.providers.keys().collect::<Vec<_>>(),
            ["ImportedClaude"]
        );
        assert!(!resolved.providers["ImportedClaude"].capabilities.tools);
        assert!(
            resolved.providers["ImportedClaude"]
                .credential_env
                .is_empty()
        );
        let saved = serde_json::to_string(&committed).unwrap();
        assert!(!saved.contains("SYNTHETIC_PRIVATE_CANARY"));
        assert!(
            !String::from_utf8(bytes)
                .unwrap()
                .contains("SYNTHETIC_PRIVATE_CANARY")
        );
        assert_eq!(
            MigrationStore::open_existing(root.path())
                .unwrap()
                .read(&job.job_id)
                .unwrap(),
            committed
        );
    }

    #[test]
    fn lost_native_receipt_is_reconciled_after_restart_even_when_cancel_requested() {
        let root = tempfile::tempdir().unwrap();
        let store = MigrationStore::open_or_create(root.path()).unwrap();
        let target = ProviderTarget::open(root.path()).unwrap();
        let job = staged_provider(&store, &target);
        let plan_id = job.provider_plans[0].id().to_owned();
        FAIL_AFTER_PROVIDER_PUBLICATION.with(|fail| fail.set(true));
        assert!(
            store
                .apply_provider(&job.job_id, job.sequence, &plan_id, &target)
                .is_err()
        );
        let path = root.path().join("settings.json");
        let metadata = std::fs::metadata(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let store = MigrationStore::open_existing(root.path()).unwrap();
        let pending = store.read(&job.job_id).unwrap();
        assert_eq!(
            pending.inventory.items[0].preview.status,
            ItemStatus::Committing
        );
        assert!(pending.receipts.is_empty());
        let cancelled = store.cancel(&job.job_id, pending.sequence).unwrap();
        let target = ProviderTarget::open(root.path()).unwrap();
        let reconciled = store
            .apply_provider(&job.job_id, cancelled.sequence, &plan_id, &target)
            .unwrap();
        assert_eq!(reconciled.status, JobStatus::Cancelled);
        assert_eq!(
            reconciled.inventory.items[0].preview.status,
            ItemStatus::Committed
        );
        assert!(!reconciled.receipts[0].ownership_confirmed);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            metadata.modified().unwrap()
        );
    }

    #[test]
    fn cancellation_stops_a_stale_provider_intent_without_erasing_unknown_outcomes() {
        let root = tempfile::tempdir().unwrap();
        let store = MigrationStore::open_or_create(root.path()).unwrap();
        let target = ProviderTarget::open(root.path()).unwrap();
        let staged = staged_provider(&store, &target);
        let id = staged.provider_plans[0].item().preview.id.clone();
        let pending = store
            .transition_item(&staged.job_id, staged.sequence, &id, ItemStatus::Committing)
            .unwrap();
        let cancelled = store.cancel(&staged.job_id, pending.sequence).unwrap();
        let settled = store
            .apply_provider(
                &staged.job_id,
                cancelled.sequence,
                staged.provider_plans[0].id(),
                &target,
            )
            .unwrap();
        assert_eq!(settled.status, JobStatus::Cancelled);
        assert_eq!(
            settled.inventory.items[0].preview.status,
            ItemStatus::CommitUnknown
        );
        assert!(!root.path().join("settings.json").exists());
        assert!(
            store
                .apply_provider(
                    &staged.job_id,
                    settled.sequence,
                    staged.provider_plans[0].id(),
                    &target
                )
                .is_err()
        );
    }

    #[test]
    fn target_edit_after_preview_is_never_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let store = MigrationStore::open_or_create(root.path()).unwrap();
        let target = ProviderTarget::open(root.path()).unwrap();
        let job = staged_provider(&store, &target);
        let plan_id = job.provider_plans[0].id().to_owned();
        let path = root.path().join("settings.json");
        kcoder_config::update_settings_file(&path, |value| {
            value["max_retries"] = serde_json::json!(75);
            Ok(())
        })
        .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            store
                .apply_provider(&job.job_id, job.sequence, &plan_id, &target)
                .unwrap_err()
                .to_string(),
            "migration_target_changed"
        );
        let pending = store.read(&job.job_id).unwrap();
        assert_eq!(
            pending.inventory.items[0].preview.status,
            ItemStatus::CommitUnknown
        );
        assert!(pending.receipts.is_empty());
        assert!(
            store
                .apply_provider(&job.job_id, pending.sequence, &plan_id, &target)
                .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn replacing_a_target_directory_cannot_redirect_a_prepared_plan() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        std::fs::create_dir(&profile).unwrap();
        let store = MigrationStore::open_or_create(&profile).unwrap();
        let target = ProviderTarget::open(&profile).unwrap();
        let job = staged_provider(&store, &target);
        std::fs::rename(&profile, root.path().join("moved")).unwrap();
        std::fs::create_dir(&profile).unwrap();
        let replacement = ProviderTarget::open(&profile).unwrap();
        assert_eq!(
            store
                .apply_provider(
                    &job.job_id,
                    job.sequence,
                    job.provider_plans[0].id(),
                    &replacement
                )
                .unwrap_err()
                .to_string(),
            "migration_wrong_target"
        );
        assert_eq!(store.read(&job.job_id).unwrap(), job);
        assert!(!profile.join("settings.json").exists());
    }

    #[test]
    fn owned_native_publication_can_be_rolled_back_and_reconciled_after_lost_receipt() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        std::fs::write(&path, "{\n// Original preference.\n\"max_retries\": 6\n}").unwrap();
        let original = kcoder_config::read_settings_file(&path).unwrap();
        let store = MigrationStore::open_or_create(root.path()).unwrap();
        let target = ProviderTarget::open(root.path()).unwrap();
        let job = staged_provider(&store, &target);
        let id = job.provider_plans[0].id().to_owned();
        let committed = store
            .apply_provider(&job.job_id, job.sequence, &id, &target)
            .unwrap();
        FAIL_AFTER_PROVIDER_ROLLBACK.with(|fail| fail.set(true));
        assert!(
            store
                .rollback_provider(&job.job_id, committed.sequence, &id, &target)
                .is_err()
        );
        let pending = store.read(&job.job_id).unwrap();
        assert_eq!(pending.status, JobStatus::RollingBack);
        assert_eq!(kcoder_config::read_settings_file(&path).unwrap(), original);
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        let store = MigrationStore::open_existing(root.path()).unwrap();
        let rolled_back = store
            .rollback_provider(&job.job_id, pending.sequence, &id, &target)
            .unwrap();
        assert_eq!(rolled_back.status, JobStatus::RolledBack);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            before
        );
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("Original preference.")
        );
        assert_eq!(
            store
                .rollback_provider(&job.job_id, pending.sequence, &id, &target)
                .unwrap(),
            rolled_back
        );
    }

    #[test]
    fn rollback_preserves_new_user_edits_and_never_deletes_unowned_reconciled_results() {
        for lost_receipt in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let store = MigrationStore::open_or_create(root.path()).unwrap();
            let target = ProviderTarget::open(root.path()).unwrap();
            let job = staged_provider(&store, &target);
            let id = job.provider_plans[0].id().to_owned();
            let committed = if lost_receipt {
                FAIL_AFTER_PROVIDER_PUBLICATION.with(|fail| fail.set(true));
                assert!(
                    store
                        .apply_provider(&job.job_id, job.sequence, &id, &target)
                        .is_err()
                );
                let pending = store.read(&job.job_id).unwrap();
                store
                    .apply_provider(&job.job_id, pending.sequence, &id, &target)
                    .unwrap()
            } else {
                store
                    .apply_provider(&job.job_id, job.sequence, &id, &target)
                    .unwrap()
            };
            let path = root.path().join("settings.json");
            kcoder_config::update_settings_file(&path, |value| {
                value["max_retries"] = serde_json::json!(17);
                Ok(())
            })
            .unwrap();
            let bytes = std::fs::read(&path).unwrap();
            let error = store
                .rollback_provider(&job.job_id, committed.sequence, &id, &target)
                .unwrap_err();
            assert_eq!(
                error.to_string(),
                if lost_receipt {
                    "migration_rollback_ownership_unknown"
                } else {
                    "migration_target_changed"
                }
            );
            let expected = if lost_receipt {
                JobStatus::CompletedWithIssues
            } else {
                JobStatus::RollbackConflict
            };
            assert_eq!(store.read(&job.job_id).unwrap().status, expected);
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    #[cfg(unix)]
    fn existing_shared_journal_directory_is_rejected_without_repair() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("migrations");
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(MigrationStore::open_or_create(root.path()).is_err());
        assert!(MigrationStore::open_existing(root.path()).is_err());
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}
