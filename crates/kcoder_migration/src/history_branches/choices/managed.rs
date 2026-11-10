//! Accepted choices are immutable producers; changing the latest pointer never loses their pins.
use super::*;
use kcoder_state::external_history::lifecycle::{
    ArchiveReferenceKind, ArchiveReferenceOwner, ArchiveReferenceReceipt,
};
use sha2::{Digest, Sha256};
const MAX_RECORD: usize = 128 * 1024;
const MAX_CHOICES: usize = 4096;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    owner: String,
    job: String,
    archive: String,
    operation: String,
    choice: HistoricalBranchChoice,
    binding: String,
    retired: bool,
    receipt: Option<ArchiveReferenceReceipt>,
}
fn digest(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn bound(owner: &str, job: &str, archive: &str, choice: &HistoricalBranchChoice) -> Result<String> {
    digest(&("historical-choice/1", owner, job, archive, choice))
}
fn read_record(directory: &PrivateDirectory, operation: &str) -> Result<Option<Record>> {
    ensure!(
        operation
            .strip_prefix("choice-")
            .is_some_and(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit())),
        "history_branch_choice_invalid_operation"
    );
    let bytes =
        match directory.open_single_link_regular_file(OsStr::new(&format!("{operation}.json"))) {
            Ok(file) => {
                ensure!(
                    file.metadata()?.len() <= MAX_RECORD as u64,
                    "history_branch_choices_budget_exceeded"
                );
                let mut bytes = Vec::new();
                file.take(MAX_RECORD as u64 + 1).read_to_end(&mut bytes)?;
                ensure!(
                    bytes.len() <= MAX_RECORD,
                    "history_branch_choices_budget_exceeded"
                );
                bytes
            }
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
    let value: Record = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("history_branch_choices_invalid"))?;
    ensure!(
        value.version == 1
            && value.operation == operation
            && value.binding == bound(&value.owner, &value.job, &value.archive, &value.choice)?
            && operation == format!("choice-{}", value.binding),
        "history_branch_choices_changed"
    );
    if let Some(receipt) = &value.receipt {
        ensure!(
            receipt.matches_owner(
                ArchiveReferenceKind::BranchChoice,
                operation,
                &value.binding
            ),
            "history_branch_choices_changed"
        );
    }
    Ok(Some(value))
}
fn write_record(directory: &PrivateDirectory, record: &Record, replace: bool) -> Result<()> {
    let bytes = serde_json::to_vec(record)?;
    ensure!(
        bytes.len() <= MAX_RECORD,
        "history_branch_choices_budget_exceeded"
    );
    if replace {
        directory.atomic_replace(OsStr::new(&format!("{}.json", record.operation)), &bytes)
    } else {
        directory
            .atomic_publish_from_reader(
                OsStr::new(&format!("{}.json", record.operation)),
                &mut &bytes[..],
                false,
                || Ok(None),
            )
            .map(|_| ())
    }
}
impl HistoryBranchStore {
    pub(super) fn remember_managed(
        &self,
        directory: &PrivateDirectory,
        job: &str,
        archive: &str,
        choice: &HistoricalBranchChoice,
    ) -> Result<Option<String>> {
        let view = self.archives.branch(&choice.view_id, false)?;
        ensure!(
            view.recipe()
                .sources
                .first()
                .is_some_and(|source| source.archive_id == archive),
            "history_branch_root_mismatch"
        );
        let guards = view
            .recipe()
            .sources
            .iter()
            .map(|source| {
                self.archives
                    .reader(&source.archive_id)
                    .map(|reader| reader.lifecycle_guard())
            })
            .collect::<Result<Vec<_>>>()?;
        let guards = guards
            .into_iter()
            .filter(|guard| guard.is_managed())
            .collect::<Vec<_>>();
        if guards.is_empty() {
            return Ok(None);
        }
        let owner = self.archives.scope_fingerprint()?;
        let binding = bound(&owner, job, archive, choice)?;
        let operation = format!("choice-{binding}");
        let mut record = if let Some(record) = read_record(directory, &operation)? {
            ensure!(
                record.owner == owner
                    && record.job == job
                    && record.archive == archive
                    && record.choice == *choice
                    && !record.retired,
                "history_branch_choices_changed"
            );
            record
        } else {
            let mut count = 0;
            directory.visit_entry_names_bounded(4 * MAX_CHOICES + 8, |name| {
                if name
                    .to_str()
                    .is_some_and(|name| name.starts_with("choice-") && name.ends_with(".json"))
                {
                    count += 1;
                }
                Ok(())
            })?;
            ensure!(
                count < MAX_CHOICES,
                "history_branch_choices_count_budget_exceeded"
            );
            let record = Record {
                version: 1,
                owner,
                job: job.into(),
                archive: archive.into(),
                operation: operation.clone(),
                choice: choice.clone(),
                binding,
                retired: false,
                receipt: None,
            };
            write_record(directory, &record, false)?;
            record
        };
        if let Some(receipt) = &record.receipt {
            self.archives.verify_archive_reference(receipt)?;
        } else {
            let owner = ArchiveReferenceOwner::new(
                ArchiveReferenceKind::BranchChoice,
                &operation,
                &record.binding,
            )?;
            record.receipt = Some(match self.archives.archive_reference_for_owner(&owner)? {
                Some(receipt) => receipt,
                None => self.archives.retain_archive_reference(owner, &guards)?,
            });
            write_record(directory, &record, true)?;
        }
        Ok(Some(operation))
    }
    pub(super) fn verify_managed_choice(
        &self,
        directory: &PrivateDirectory,
        job: &str,
        value: &Choice,
    ) -> Result<()> {
        let operation = value
            .operation
            .as_deref()
            .context("history_branch_choices_changed")?;
        let record =
            read_record(directory, operation)?.context("history_branch_choices_changed")?;
        ensure!(
            !record.retired
                && record.owner == value.owner
                && record.job == job
                && record.archive == value.root_archive
                && record.choice == value.choice,
            "history_branch_choices_changed"
        );
        self.archives.verify_archive_reference(
            record
                .receipt
                .as_ref()
                .context("history_branch_choices_recovery_required")?,
        )
    }
    /// Explicitly retire this source job's accepted choices, including an original
    /// pending pin after a lost receipt. Other jobs' choices and view data are retained.
    pub fn retire_choices(&self, job: &str) -> Result<usize> {
        let _fences = self.jobs.reference_cleanup_fence(job)?;
        let Some(directory) = self.choices(false)? else {
            return Ok(0);
        };
        let _catalog = directory
            .try_exclusive_lock(OsStr::new("choices.lock"))?
            .context("history_branch_choices_busy")?;
        let mut operations = Vec::new();
        directory.visit_entry_names_bounded(4 * MAX_CHOICES + 8, |name| {
            if let Some(operation) = name.to_str().and_then(|name| name.strip_suffix(".json"))
                && operation.starts_with("choice-")
            {
                operations.push(operation.to_string());
            }
            Ok(())
        })?;
        ensure!(
            operations.len() <= MAX_CHOICES,
            "history_branch_choices_count_budget_exceeded"
        );
        operations.sort();
        let owner = self.archives.scope_fingerprint()?;
        let mut retired = 0;
        for operation in operations {
            let mut record =
                read_record(&directory, &operation)?.context("history_branch_choices_changed")?;
            ensure!(record.owner == owner, "history_branch_choices_changed");
            if record.job != job {
                continue;
            }
            if record.receipt.is_none() {
                record.receipt =
                    self.archives
                        .archive_reference_for_owner(&ArchiveReferenceOwner::new(
                            ArchiveReferenceKind::BranchChoice,
                            &operation,
                            &record.binding,
                        )?)?;
            }
            record.retired = true;
            write_record(&directory, &record, true)?;
            if let Some(receipt) = &record.receipt {
                self.archives.release_archive_reference(receipt)?;
            }
            retired += 1;
        }
        let pointer = format!("{job}.json");
        match directory.open_single_link_regular_file(OsStr::new(&pointer)) {
            Ok(file) => {
                ensure!(
                    file.metadata()?.len() <= MAX_RECORD as u64,
                    "history_branch_choices_budget_exceeded"
                );
                let mut bytes = Vec::new();
                file.take(MAX_RECORD as u64 + 1).read_to_end(&mut bytes)?;
                let mut value: Choice = serde_json::from_slice(&bytes)
                    .map_err(|_| anyhow::anyhow!("history_branch_choices_invalid"))?;
                ensure!(value.owner == owner, "history_branch_choices_changed");
                value.retired = true;
                directory.atomic_replace(OsStr::new(&pointer), &serde_json::to_vec(&value)?)?;
            }
            Err(error) if missing(&error) => {}
            Err(error) => return Err(error),
        }
        Ok(retired)
    }
}
