use super::canonical_package_revision;
use super::hash::{load_package, package_file_map, validate_package};
use super::journal::{
    CommitRecord, JOURNAL_SCHEMA, JournalMove, TransactionJournal, TransactionPhase, append_commit,
    find_operation, sha256, write_journal,
};
use super::layout::{StoreLayout, validate_managed_file, validate_skill_name};
use super::lock::{DEFAULT_LOCK_TIMEOUT, StoreLock};
use super::metadata::{load_state, prepare_metadata};
use super::replace::{atomic_write, create_private_dir, remove_tree, rename_and_sync};
use super::{
    ExpectedSkillRevision, NamedSkillRevision, SkillCommitReceipt, SkillCommitRequest,
    SkillMutation, SkillMutationActor, SkillOperationKind, SkillPackage, SkillRevision,
    SkillStoreCommitStatus, SkillStoreDiagnostic, SkillStoreError,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use uuid::Uuid;

#[doc(hidden)]
pub trait SkillStoreFaultInjector: Send + Sync {
    fn check(&self, point: &'static str) -> Result<(), SkillStoreError>;
}

pub struct SkillStoreSnapshot {
    root: PathBuf,
    _lock: StoreLock,
}

impl SkillStoreSnapshot {
    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[derive(Debug)]
struct NoFaults;

impl SkillStoreFaultInjector for NoFaults {
    fn check(&self, _point: &'static str) -> Result<(), SkillStoreError> {
        Ok(())
    }
}

#[derive(Clone)]
pub struct SkillStore {
    pub(crate) layout: StoreLayout,
    pub(crate) lock_timeout: Duration,
    faults: Arc<dyn SkillStoreFaultInjector>,
}

impl std::fmt::Debug for SkillStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SkillStore")
            .field("root", &self.layout.root)
            .field("lock_timeout", &self.lock_timeout)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct PlannedMove {
    name: String,
    live: PathBuf,
    before_revision: Option<SkillRevision>,
    after: Option<SkillPackage>,
    after_revision: Option<SkillRevision>,
}

impl SkillStore {
    pub fn open(root: &Path) -> Result<Self, SkillStoreError> {
        Ok(Self {
            layout: StoreLayout::new(root)?,
            lock_timeout: DEFAULT_LOCK_TIMEOUT,
            faults: Arc::new(NoFaults),
        })
    }

    pub fn root(&self) -> &Path {
        &self.layout.root
    }

    #[doc(hidden)]
    pub fn with_lock_timeout(mut self, timeout: Duration) -> Self {
        self.lock_timeout = timeout;
        self
    }

    #[doc(hidden)]
    pub fn with_fault_injector(mut self, faults: Arc<dyn SkillStoreFaultInjector>) -> Self {
        self.faults = faults;
        self
    }

    pub fn recover(&self) -> Result<Vec<SkillStoreDiagnostic>, SkillStoreError> {
        create_private_dir(&self.layout.root)?;
        let _lock = StoreLock::exclusive(&self.layout, self.lock_timeout)?;
        let diagnostics = super::recovery::recover_locked(self)?;
        for diagnostic in &diagnostics {
            tracing::warn!(
                target: "kcoder_skill_store",
                root = %self.layout.root.display(),
                diagnostic = ?diagnostic,
                "skill store recovery diagnostic"
            );
        }
        Ok(diagnostics)
    }

    pub fn inspect(&self) -> Result<super::SkillStoreInspection, SkillStoreError> {
        super::recovery::inspect(self)
    }

    pub fn record_reload_status(
        &self,
        transaction_id: &str,
        reloaded: bool,
    ) -> Result<(), SkillStoreError> {
        if !transaction_id.starts_with("skill-txn-") || transaction_id.len() > 128 {
            return Err(SkillStoreError::InvalidOperationId(
                transaction_id.to_string(),
            ));
        }
        create_private_dir(&self.layout.root)?;
        let _lock = StoreLock::exclusive(&self.layout, self.lock_timeout)?;
        let path = self.layout.root.join(super::layout::RELOAD_PENDING_FILE);
        if reloaded {
            if path.exists() {
                fs::remove_file(&path).map_err(|error| {
                    SkillStoreError::io("clearing skill registry reload marker", error)
                })?;
                super::replace::sync_directory(&self.layout.root)?;
            }
            return Ok(());
        }
        let bytes = serde_json::to_vec_pretty(&serde_json::json!({
            "schema": "kcoder.skill-reload-pending/1",
            "transaction_id": transaction_id,
            "recorded_at": chrono::Utc::now(),
        }))
        .map_err(|error| {
            SkillStoreError::serialization("serializing skill reload marker", error)
        })?;
        atomic_write(&path, &bytes, transaction_id)
    }

    pub fn snapshot(&self) -> Result<SkillStoreSnapshot, SkillStoreError> {
        create_private_dir(&self.layout.root)?;
        loop {
            if super::recovery::needs_recovery(self)? {
                let _lock = StoreLock::exclusive(&self.layout, self.lock_timeout)?;
                for diagnostic in super::recovery::recover_locked(self)? {
                    tracing::warn!(
                        target: "kcoder_skill_store",
                        root = %self.layout.root.display(),
                        diagnostic = ?diagnostic,
                        "fresh registry snapshot observed skill store diagnostic"
                    );
                }
                continue;
            }
            let lock = StoreLock::shared(&self.layout, self.lock_timeout)?;
            if super::recovery::needs_recovery(self)? {
                drop(lock);
                continue;
            }
            return Ok(SkillStoreSnapshot {
                root: self.layout.root.clone(),
                _lock: lock,
            });
        }
    }

    pub fn current_revision(&self, name: &str) -> Result<Option<SkillRevision>, SkillStoreError> {
        validate_skill_name(name)?;
        let _snapshot = self.snapshot()?;
        revision_at(&self.layout.root.join(name), name)
    }

    pub fn read_package(&self, name: &str) -> Result<Option<SkillPackage>, SkillStoreError> {
        validate_skill_name(name)?;
        let _snapshot = self.snapshot()?;
        let path = self.layout.root.join(name);
        if !path.exists() {
            return Ok(None);
        }
        load_package(&path, name).map(Some)
    }

    pub fn commit(
        &self,
        request: SkillCommitRequest,
    ) -> Result<SkillCommitReceipt, SkillStoreError> {
        let started_at = Instant::now();
        validate_operation_id(&request.operation_id)?;
        create_private_dir(&self.layout.root)?;
        create_private_dir(&self.layout.transactions())?;
        let lock_started_at = Instant::now();
        let _root_lock = StoreLock::exclusive(&self.layout, self.lock_timeout)?;
        let lock_wait = lock_started_at.elapsed();
        super::recovery::recover_locked(self)?;
        if let Some(receipt) = find_operation(&self.layout, &request.operation_id)? {
            tracing::info!(
                target: "kcoder_skill_store",
                transaction_id = %receipt.transaction_id,
                operation_id = %receipt.operation_id,
                generation = receipt.generation,
                status = "idempotent_retry",
                lock_wait_ms = lock_wait.as_millis(),
                elapsed_ms = started_at.elapsed().as_millis(),
                "skill transaction returned its durable receipt"
            );
            return Ok(receipt);
        }
        super::metadata::check_preconditions(&self.layout, &request.preconditions)?;

        let state = load_state(&self.layout)?;
        let mut moves = self.plan_mutations(&request)?;
        moves.sort_by(|left, right| left.live.cmp(&right.live));
        reject_duplicate_paths(&moves)?;

        let before = logical_revisions(&moves, false);
        let after = logical_revisions(&moves, true);
        let content_changed = moves
            .iter()
            .any(|item| item.before_revision != item.after_revision);
        let metadata_changed = request.metadata != Default::default();
        let status = if content_changed || metadata_changed {
            SkillStoreCommitStatus::Committed
        } else {
            SkillStoreCommitStatus::NoChange
        };
        let generation_after = if status == SkillStoreCommitStatus::Committed {
            state.generation.checked_add(1).ok_or_else(|| {
                SkillStoreError::JournalCorrupt("skill generation overflow".to_string())
            })?
        } else {
            state.generation
        };

        let transaction_id = format!("skill-txn-{}", Uuid::new_v4());
        let transaction_dir = self.layout.transaction(&transaction_id);
        create_private_dir(&transaction_dir)?;
        self.hit("transaction_directory_created")?;

        let mut journal_moves = Vec::new();
        for (index, item) in moves.iter().enumerate() {
            let staged = if let Some(package) = &item.after {
                self.hit("before_staging_package")?;
                let relative = PathBuf::from(".transactions")
                    .join(&transaction_id)
                    .join("staged")
                    .join(index.to_string());
                let absolute = self.layout.root.join(&relative);
                super::replace::write_package(&absolute, package)?;
                self.hit("staged_package_written")?;
                let staged_package = load_package(&absolute, &package.name)?;
                let revision = validate_package(&staged_package)?;
                if Some(&revision) != item.after_revision.as_ref() {
                    return Err(SkillStoreError::JournalCorrupt(format!(
                        "staged revision mismatch for '{}'",
                        item.name
                    )));
                }
                Some(relative)
            } else {
                None
            };
            journal_moves.push(JournalMove {
                name: item.name.clone(),
                live: item.live.clone(),
                staged,
                before_image: item.before_revision.as_ref().map(|_| {
                    PathBuf::from(".transactions")
                        .join(&transaction_id)
                        .join("before")
                        .join("content")
                        .join(index.to_string())
                }),
                before_revision: item.before_revision.clone(),
                after_revision: item.after_revision.clone(),
                published: false,
            });
        }

        let _usage_lock = if request.metadata.usage.is_empty() {
            None
        } else {
            Some(StoreLock::usage(&self.layout, self.lock_timeout)?)
        };
        let metadata_files = if status == SkillStoreCommitStatus::Committed {
            prepare_metadata(
                &self.layout,
                &transaction_dir,
                &transaction_id,
                generation_after,
                &request.actor,
                &after,
                &request.metadata,
            )?
        } else {
            Vec::new()
        };
        self.hit("after_images_prepared")?;

        let mut journal = TransactionJournal {
            schema: JOURNAL_SCHEMA.to_string(),
            transaction_id: transaction_id.clone(),
            operation_id: request.operation_id.clone(),
            phase: TransactionPhase::Prepared,
            generation_before: state.generation,
            generation_after,
            operation: request.operation.clone(),
            actor: request.actor.clone(),
            before: before.clone(),
            after: after.clone(),
            changed_paths: journal_moves
                .iter()
                .filter(|item| item.before_revision != item.after_revision)
                .map(|item| item.live.clone())
                .chain(metadata_files.iter().map(|item| item.live.clone()))
                .collect(),
            moves: journal_moves,
            metadata_files,
        };
        self.hit("before_journal_prepared")?;
        write_journal(&transaction_dir, &journal)?;
        self.hit("journal_prepared")?;
        journal.transition(TransactionPhase::Prepared, TransactionPhase::Publishing)?;
        self.hit("before_journal_publishing")?;
        write_journal(&transaction_dir, &journal)?;
        self.hit("journal_publishing")?;

        for index in 0..journal.moves.len() {
            publish_content_move(
                &self.layout,
                &mut journal,
                index,
                Some(&|| self.hit("live_moved_to_before")),
            )?;
            self.hit("staged_moved_to_live")?;
            write_journal(&transaction_dir, &journal)?;
            self.hit("content_move_published")?;
        }
        journal.transition(
            TransactionPhase::Publishing,
            TransactionPhase::ContentPublished,
        )?;
        write_journal(&transaction_dir, &journal)?;
        self.hit("content_published")?;

        for index in 0..journal.metadata_files.len() {
            self.hit("before_metadata_publish")?;
            publish_metadata_file(&self.layout, &mut journal, index, &transaction_id)?;
            write_journal(&transaction_dir, &journal)?;
            self.hit("metadata_file_published")?;
        }
        journal.transition(
            TransactionPhase::ContentPublished,
            TransactionPhase::MetadataPublished,
        )?;
        write_journal(&transaction_dir, &journal)?;
        self.hit("metadata_published")?;

        let record = CommitRecord::from_journal(&journal, status);
        self.hit("before_commit_append")?;
        append_commit(&self.layout, &record)?;
        self.hit("after_commit_append")?;
        journal.transition(
            TransactionPhase::MetadataPublished,
            TransactionPhase::Committed,
        )?;
        self.hit("before_journal_committed")?;
        write_journal(&transaction_dir, &journal)?;
        self.hit("journal_committed")?;

        journal.transition(TransactionPhase::Committed, TransactionPhase::Cleaned)?;
        write_journal(&transaction_dir, &journal)?;
        if self.hit("before_cleanup").is_ok() {
            let _ = remove_tree(&transaction_dir);
        }
        let receipt = record.receipt();
        tracing::info!(
            target: "kcoder_skill_store",
            transaction_id = %receipt.transaction_id,
            operation_id = %receipt.operation_id,
            generation = receipt.generation,
            actor_kind = request.actor.kind(),
            status = ?receipt.status,
            changed_path_count = receipt.changed_paths.len(),
            lock_wait_ms = lock_wait.as_millis(),
            elapsed_ms = started_at.elapsed().as_millis(),
            "skill transaction reached its durable commit point"
        );
        Ok(receipt)
    }

    pub(crate) fn hit(&self, point: &'static str) -> Result<(), SkillStoreError> {
        self.faults.check(point)
    }

    fn plan_mutations(
        &self,
        request: &SkillCommitRequest,
    ) -> Result<Vec<PlannedMove>, SkillStoreError> {
        let mut planned = Vec::new();
        for mutation in &request.mutations {
            match mutation {
                SkillMutation::PutPackage { package, expected } => {
                    validate_package(package)?;
                    ensure_expected_allowed(expected, &request.actor, &request.operation)?;
                    let live = PathBuf::from(&package.name);
                    let before_revision =
                        if matches!(expected, ExpectedSkillRevision::Unconditional) {
                            revision_at_unvalidated(&self.layout.root.join(&live), &package.name)?
                        } else {
                            revision_at(&self.layout.root.join(&live), &package.name)?
                        };
                    check_expected(&package.name, expected, before_revision.as_ref())?;
                    let after_revision = Some(validate_package(package)?);
                    planned.push(PlannedMove {
                        name: package.name.clone(),
                        live,
                        before_revision,
                        after: Some(package.clone()),
                        after_revision,
                    });
                }
                SkillMutation::PatchFile {
                    name,
                    expected,
                    relative_path,
                    expected_file_sha256,
                    replacement,
                    executable,
                } => {
                    let mut package = required_package(&self.layout, name)?;
                    let before_revision = validate_package(&package)?;
                    check_expected(
                        name,
                        &ExpectedSkillRevision::Exact(expected.clone()),
                        Some(&before_revision),
                    )?;
                    let canonical = validate_managed_file(relative_path)?;
                    let mut files = package_file_map(package)?;
                    let file = files.get_mut(&canonical).ok_or_else(|| {
                        SkillStoreError::InvalidPackage(format!(
                            "file '{canonical}' does not exist in skill '{name}'"
                        ))
                    })?;
                    let actual_file_hash = sha256(&file.content);
                    if actual_file_hash != *expected_file_sha256 {
                        return Err(SkillStoreError::Conflict {
                            name: format!("{name}/{canonical}"),
                            expected: expected_file_sha256.clone(),
                            actual: actual_file_hash,
                        });
                    }
                    file.content = replacement.clone();
                    file.executable = *executable;
                    package = SkillPackage {
                        name: name.clone(),
                        files: files.into_values().collect(),
                    };
                    let after_revision = validate_package(&package)?;
                    planned.push(PlannedMove {
                        name: name.clone(),
                        live: PathBuf::from(name),
                        before_revision: Some(before_revision),
                        after: Some(package),
                        after_revision: Some(after_revision),
                    });
                }
                SkillMutation::PatchText {
                    name,
                    expected,
                    relative_path,
                    old_string,
                    new_string,
                    replace_all,
                } => {
                    ensure_expected_allowed(expected, &request.actor, &request.operation)?;
                    if old_string.is_empty() {
                        return Err(SkillStoreError::InvalidPackage(
                            "old_string cannot be empty".to_string(),
                        ));
                    }
                    let package = required_package(&self.layout, name)?;
                    let before_revision = validate_package(&package)?;
                    check_expected(name, expected, Some(&before_revision))?;
                    let canonical = validate_managed_file(relative_path)?;
                    let mut files = package_file_map(package)?;
                    let file = files.get_mut(&canonical).ok_or_else(|| {
                        SkillStoreError::InvalidPackage(format!(
                            "file '{canonical}' does not exist in skill '{name}'"
                        ))
                    })?;
                    let text = std::str::from_utf8(&file.content).map_err(|_| {
                        SkillStoreError::InvalidPackage(format!(
                            "file '{canonical}' is not UTF-8 text"
                        ))
                    })?;
                    let matches = text.matches(old_string).count();
                    if matches == 0 || (!replace_all && matches != 1) {
                        return Err(SkillStoreError::Conflict {
                            name: format!("{name}/{canonical}"),
                            expected: if *replace_all {
                                "at least one exact match".to_string()
                            } else {
                                "exactly one exact match".to_string()
                            },
                            actual: format!("{matches} matches"),
                        });
                    }
                    file.content = if *replace_all {
                        text.replace(old_string, new_string).into_bytes()
                    } else {
                        text.replacen(old_string, new_string, 1).into_bytes()
                    };
                    let package = SkillPackage {
                        name: name.clone(),
                        files: files.into_values().collect(),
                    };
                    let after_revision = validate_package(&package)?;
                    planned.push(PlannedMove {
                        name: name.clone(),
                        live: PathBuf::from(name),
                        before_revision: Some(before_revision),
                        after: Some(package),
                        after_revision: Some(after_revision),
                    });
                }
                SkillMutation::RemoveFile {
                    name,
                    expected,
                    relative_path,
                } => {
                    let package = required_package(&self.layout, name)?;
                    let before_revision = validate_package(&package)?;
                    check_expected(
                        name,
                        &ExpectedSkillRevision::Exact(expected.clone()),
                        Some(&before_revision),
                    )?;
                    let canonical = validate_managed_file(relative_path)?;
                    if canonical == "SKILL.md" {
                        return Err(SkillStoreError::InvalidPackage(
                            "remove_file cannot remove SKILL.md; archive the skill instead"
                                .to_string(),
                        ));
                    }
                    let mut files = package_file_map(package)?;
                    if files.remove(&canonical).is_none() {
                        return Err(SkillStoreError::InvalidPackage(format!(
                            "file '{canonical}' does not exist in skill '{name}'"
                        )));
                    }
                    let package = SkillPackage {
                        name: name.clone(),
                        files: files.into_values().collect(),
                    };
                    let after_revision = validate_package(&package)?;
                    planned.push(PlannedMove {
                        name: name.clone(),
                        live: PathBuf::from(name),
                        before_revision: Some(before_revision),
                        after: Some(package),
                        after_revision: Some(after_revision),
                    });
                }
                SkillMutation::Archive {
                    name,
                    expected,
                    archive_name,
                } => {
                    validate_skill_name(archive_name)?;
                    let package = required_package(&self.layout, name)?;
                    let revision = validate_package(&package)?;
                    check_expected(
                        name,
                        &ExpectedSkillRevision::Exact(expected.clone()),
                        Some(&revision),
                    )?;
                    let archive = self.layout.archive().join(archive_name);
                    if archive.exists() {
                        return Err(SkillStoreError::Conflict {
                            name: archive_name.clone(),
                            expected: "absent archive".to_string(),
                            actual: revision_display(revision_at(&archive, name)?.as_ref()),
                        });
                    }
                    planned.push(PlannedMove {
                        name: name.clone(),
                        live: PathBuf::from(name),
                        before_revision: Some(revision.clone()),
                        after: None,
                        after_revision: None,
                    });
                    planned.push(PlannedMove {
                        name: name.clone(),
                        live: PathBuf::from(".archive").join(archive_name),
                        before_revision: None,
                        after: Some(package),
                        after_revision: Some(revision),
                    });
                }
                SkillMutation::Restore {
                    name,
                    archive_name,
                    expected_archive_revision,
                    expected_live,
                } => {
                    validate_skill_name(name)?;
                    validate_skill_name(archive_name)?;
                    let archive_path = self.layout.archive().join(archive_name);
                    let package = load_package(&archive_path, name).map_err(|error| {
                        if !archive_path.exists() {
                            SkillStoreError::InvalidPackage(format!(
                                "archived skill '{archive_name}' does not exist"
                            ))
                        } else {
                            error
                        }
                    })?;
                    let archive_revision = validate_package(&package)?;
                    check_expected(
                        archive_name,
                        &ExpectedSkillRevision::Exact(expected_archive_revision.clone()),
                        Some(&archive_revision),
                    )?;
                    ensure_expected_allowed(expected_live, &request.actor, &request.operation)?;
                    let live_revision = revision_at(&self.layout.root.join(name), name)?;
                    check_expected(name, expected_live, live_revision.as_ref())?;
                    planned.push(PlannedMove {
                        name: name.clone(),
                        live: PathBuf::from(".archive").join(archive_name),
                        before_revision: Some(archive_revision.clone()),
                        after: None,
                        after_revision: None,
                    });
                    planned.push(PlannedMove {
                        name: name.clone(),
                        live: PathBuf::from(name),
                        before_revision: live_revision,
                        after: Some(package),
                        after_revision: Some(archive_revision),
                    });
                }
                SkillMutation::Consolidate {
                    sources,
                    destination,
                    expected_destination,
                } => {
                    if sources.len() < 2 {
                        return Err(SkillStoreError::InvalidPackage(
                            "consolidate requires at least two source skills".to_string(),
                        ));
                    }
                    validate_package(destination)?;
                    ensure_expected_allowed(
                        expected_destination,
                        &request.actor,
                        &request.operation,
                    )?;
                    let destination_before =
                        revision_at(&self.layout.root.join(&destination.name), &destination.name)?;
                    check_expected(
                        &destination.name,
                        expected_destination,
                        destination_before.as_ref(),
                    )?;
                    for (name, expected) in sources {
                        let package = required_package(&self.layout, name)?;
                        let revision = validate_package(&package)?;
                        check_expected(
                            name,
                            &ExpectedSkillRevision::Exact(expected.clone()),
                            Some(&revision),
                        )?;
                        let archive = self.layout.archive().join(name);
                        if archive.exists() {
                            return Err(SkillStoreError::Conflict {
                                name: name.clone(),
                                expected: "absent archive".to_string(),
                                actual: revision_display(revision_at(&archive, name)?.as_ref()),
                            });
                        }
                        planned.push(PlannedMove {
                            name: name.clone(),
                            live: PathBuf::from(name),
                            before_revision: Some(revision.clone()),
                            after: None,
                            after_revision: None,
                        });
                        planned.push(PlannedMove {
                            name: name.clone(),
                            live: PathBuf::from(".archive").join(name),
                            before_revision: None,
                            after: Some(package),
                            after_revision: Some(revision),
                        });
                    }
                    planned.push(PlannedMove {
                        name: destination.name.clone(),
                        live: PathBuf::from(&destination.name),
                        before_revision: destination_before,
                        after: Some(destination.clone()),
                        after_revision: Some(validate_package(destination)?),
                    });
                }
            }
        }
        Ok(planned)
    }
}

fn required_package(layout: &StoreLayout, name: &str) -> Result<SkillPackage, SkillStoreError> {
    validate_skill_name(name)?;
    let path = layout.root.join(name);
    if !path.exists() {
        return Err(SkillStoreError::Conflict {
            name: name.to_string(),
            expected: "present".to_string(),
            actual: "absent".to_string(),
        });
    }
    load_package(&path, name)
}

fn revision_at(path: &Path, name: &str) -> Result<Option<SkillRevision>, SkillStoreError> {
    if !path.exists() {
        return Ok(None);
    }
    let package = load_package(path, name)?;
    validate_package(&package).map(Some)
}

fn revision_at_unvalidated(
    path: &Path,
    name: &str,
) -> Result<Option<SkillRevision>, SkillStoreError> {
    if !path.exists() {
        return Ok(None);
    }
    canonical_package_revision(&load_package(path, name)?).map(Some)
}

pub(crate) fn revision_at_relative(
    layout: &StoreLayout,
    path: &Path,
    name: &str,
) -> Result<Option<SkillRevision>, SkillStoreError> {
    revision_at_unvalidated(&layout.root.join(path), name)
}

fn check_expected(
    name: &str,
    expected: &ExpectedSkillRevision,
    actual: Option<&SkillRevision>,
) -> Result<(), SkillStoreError> {
    let matches = match expected {
        ExpectedSkillRevision::Absent => actual.is_none(),
        ExpectedSkillRevision::Exact(expected) => actual == Some(expected),
        ExpectedSkillRevision::Unconditional => true,
    };
    if matches {
        Ok(())
    } else {
        tracing::warn!(
            target: "kcoder_skill_store",
            skill = name,
            expected_revision = %match expected {
                ExpectedSkillRevision::Absent => "absent",
                ExpectedSkillRevision::Exact(revision) => revision.as_str(),
                ExpectedSkillRevision::Unconditional => "unconditional",
            },
            actual_revision = %revision_display(actual),
            "skill transaction CAS conflict"
        );
        Err(SkillStoreError::Conflict {
            name: name.to_string(),
            expected: match expected {
                ExpectedSkillRevision::Absent => "absent".to_string(),
                ExpectedSkillRevision::Exact(revision) => revision.0.clone(),
                ExpectedSkillRevision::Unconditional => "unconditional".to_string(),
            },
            actual: revision_display(actual),
        })
    }
}

fn ensure_expected_allowed(
    expected: &ExpectedSkillRevision,
    actor: &SkillMutationActor,
    operation: &SkillOperationKind,
) -> Result<(), SkillStoreError> {
    if !matches!(expected, ExpectedSkillRevision::Unconditional) {
        return Ok(());
    }
    let allowed = match actor {
        SkillMutationActor::BuiltinInstaller { .. } => {
            matches!(operation, SkillOperationKind::BuiltinMaterialize)
        }
        SkillMutationActor::SpecInit { force_update, .. } => {
            *force_update && matches!(operation, SkillOperationKind::SpecSync)
        }
        SkillMutationActor::SkillHub { .. } => {
            matches!(
                operation,
                SkillOperationKind::Install
                    | SkillOperationKind::Uninstall
                    | SkillOperationKind::BundledSync
            )
        }
        SkillMutationActor::ForegroundAgent { .. } => matches!(
            operation,
            SkillOperationKind::Install
                | SkillOperationKind::Uninstall
                | SkillOperationKind::BundledSync
                | SkillOperationKind::SpecSync
        ),
        SkillMutationActor::System { component, .. } => matches!(
            (component.as_str(), operation),
            ("builtin_installer", SkillOperationKind::BuiltinMaterialize)
                | ("bundled_sync", SkillOperationKind::BundledSync)
        ),
        SkillMutationActor::BackgroundReview { .. } | SkillMutationActor::AutoCurator { .. } => {
            false
        }
    };
    if allowed {
        Ok(())
    } else {
        Err(SkillStoreError::PolicyRejected(format!(
            "actor '{}' cannot use unconditional revision for {:?}",
            actor.kind(),
            operation
        )))
    }
}

fn reject_duplicate_paths(moves: &[PlannedMove]) -> Result<(), SkillStoreError> {
    let mut paths = BTreeSet::new();
    for item in moves {
        if !paths.insert(item.live.clone()) {
            return Err(SkillStoreError::InvalidPackage(format!(
                "transaction mutates '{}' more than once",
                item.live.display()
            )));
        }
    }
    Ok(())
}

fn logical_revisions(moves: &[PlannedMove], after: bool) -> Vec<NamedSkillRevision> {
    let mut revisions = BTreeMap::new();
    for item in moves {
        if item.live.components().count() != 1 {
            continue;
        }
        revisions.insert(
            item.name.clone(),
            if after {
                item.after_revision.clone()
            } else {
                item.before_revision.clone()
            },
        );
    }
    revisions
        .into_iter()
        .map(|(name, revision)| NamedSkillRevision { name, revision })
        .collect()
}

fn revision_display(revision: Option<&SkillRevision>) -> String {
    revision
        .map(|revision| revision.0.clone())
        .unwrap_or_else(|| "absent".to_string())
}

fn validate_operation_id(operation_id: &str) -> Result<(), SkillStoreError> {
    if operation_id.is_empty()
        || operation_id.len() > 256
        || operation_id.chars().any(|value| value.is_control())
    {
        return Err(SkillStoreError::InvalidOperationId(
            operation_id.chars().take(80).collect(),
        ));
    }
    Ok(())
}

pub(crate) fn publish_content_move(
    layout: &StoreLayout,
    journal: &mut TransactionJournal,
    index: usize,
    after_before_move: Option<&dyn Fn() -> Result<(), SkillStoreError>>,
) -> Result<(), SkillStoreError> {
    let item = journal.moves.get(index).cloned().ok_or_else(|| {
        SkillStoreError::JournalCorrupt(format!("missing content move index {index}"))
    })?;
    if item.published {
        return Ok(());
    }
    let live = layout.root.join(&item.live);
    if let Some(after) = &item.after_revision
        && revision_at_unvalidated(&live, &item.name)?.as_ref() == Some(after)
    {
        journal.moves[index].published = true;
        return Ok(());
    }
    if let Some(before) = &item.before_revision {
        if revision_at_unvalidated(&live, &item.name)?.as_ref() == Some(before) {
            let before_path = item.before_image.as_ref().ok_or_else(|| {
                SkillStoreError::JournalCorrupt("missing before-image path".to_string())
            })?;
            let before_absolute = layout.root.join(before_path);
            if !before_absolute.exists() {
                rename_and_sync(&live, &before_absolute)?;
                if let Some(hook) = after_before_move {
                    hook()?;
                }
            }
        } else if live.exists() {
            return Err(SkillStoreError::RecoveryRequired {
                transaction_id: journal.transaction_id.clone(),
                reason: format!(
                    "live path '{}' no longer matches before revision",
                    item.live.display()
                ),
            });
        }
    } else if live.exists() {
        return Err(SkillStoreError::RecoveryRequired {
            transaction_id: journal.transaction_id.clone(),
            reason: format!("expected absent live path '{}'", item.live.display()),
        });
    }

    match (&item.staged, &item.after_revision) {
        (Some(staged), Some(expected)) => {
            let staged_absolute = layout.root.join(staged);
            if revision_at_unvalidated(&staged_absolute, &item.name)?.as_ref() != Some(expected) {
                return Err(SkillStoreError::RecoveryRequired {
                    transaction_id: journal.transaction_id.clone(),
                    reason: format!("staged path '{}' is missing or corrupt", staged.display()),
                });
            }
            rename_and_sync(&staged_absolute, &live)?;
        }
        (None, None) => {}
        _ => {
            return Err(SkillStoreError::JournalCorrupt(format!(
                "content move '{}' has inconsistent staged and after fields",
                item.live.display()
            )));
        }
    }
    journal.moves[index].published = true;
    Ok(())
}

pub(crate) fn publish_metadata_file(
    layout: &StoreLayout,
    journal: &mut TransactionJournal,
    index: usize,
    transaction_id: &str,
) -> Result<(), SkillStoreError> {
    let item = journal.metadata_files.get(index).cloned().ok_or_else(|| {
        SkillStoreError::JournalCorrupt(format!("missing metadata move index {index}"))
    })?;
    if item.published {
        return Ok(());
    }
    let live = layout.root.join(&item.live);
    if file_hash(&live)?.as_deref() == Some(&item.after_sha256) {
        journal.metadata_files[index].published = true;
        return Ok(());
    }
    let staged = layout.root.join(&item.staged);
    let bytes = fs::read(&staged).map_err(|error| {
        SkillStoreError::io(
            format!("reading staged metadata {}", staged.display()),
            error,
        )
    })?;
    if sha256(&bytes) != item.after_sha256 {
        return Err(SkillStoreError::RecoveryRequired {
            transaction_id: journal.transaction_id.clone(),
            reason: format!("staged metadata '{}' is corrupt", item.staged.display()),
        });
    }
    atomic_write(&live, &bytes, transaction_id)?;
    journal.metadata_files[index].published = true;
    Ok(())
}

pub(crate) fn file_hash(path: &Path) -> Result<Option<String>, SkillStoreError> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path)
        .map_err(|error| SkillStoreError::io(format!("reading {}", path.display()), error))?;
    Ok(Some(sha256(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SkillPackageFile;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tempfile::TempDir;

    struct FailOnce {
        point: &'static str,
        fired: AtomicBool,
    }

    struct FailNth {
        point: &'static str,
        nth: usize,
        calls: AtomicUsize,
    }

    impl SkillStoreFaultInjector for FailNth {
        fn check(&self, point: &'static str) -> Result<(), SkillStoreError> {
            if point == self.point && self.calls.fetch_add(1, Ordering::SeqCst) + 1 == self.nth {
                return Err(SkillStoreError::io(
                    format!("injected failure at {point} call {}", self.nth),
                    std::io::Error::other("injected failure"),
                ));
            }
            Ok(())
        }
    }

    impl SkillStoreFaultInjector for FailOnce {
        fn check(&self, point: &'static str) -> Result<(), SkillStoreError> {
            if point == self.point && !self.fired.swap(true, Ordering::SeqCst) {
                return Err(SkillStoreError::io(
                    format!("injected failure at {point}"),
                    std::io::Error::other("injected failure"),
                ));
            }
            Ok(())
        }
    }

    fn failing_store(root: &Path, point: &'static str) -> SkillStore {
        SkillStore::open(root)
            .unwrap()
            .with_fault_injector(Arc::new(FailOnce {
                point,
                fired: AtomicBool::new(false),
            }))
    }

    fn package(name: &str, body: &str) -> SkillPackage {
        SkillPackage {
            name: name.to_string(),
            files: vec![SkillPackageFile {
                relative_path: PathBuf::from("SKILL.md"),
                content: format!("---\nname: {name}\ndescription: Demo skill\n---\n\n{body}\n")
                    .into_bytes(),
                executable: false,
            }],
        }
    }

    fn actor() -> SkillMutationActor {
        SkillMutationActor::ForegroundAgent {
            session_id: "session".to_string(),
            tool_call_id: "tool".to_string(),
        }
    }

    fn request(operation_id: &str, mutation: SkillMutation) -> SkillCommitRequest {
        SkillCommitRequest {
            operation_id: operation_id.to_string(),
            actor: actor(),
            operation: SkillOperationKind::Create,
            preconditions: Vec::new(),
            mutations: vec![mutation],
            metadata: Default::default(),
        }
    }

    #[test]
    fn put_package_obeys_cas_and_operation_id_is_idempotent() {
        let temp = TempDir::new().unwrap();
        let store = SkillStore::open(&temp.path().join("skills")).unwrap();
        let mutation = SkillMutation::PutPackage {
            package: package("demo", "first"),
            expected: ExpectedSkillRevision::Absent,
        };
        let first = store
            .commit(request("create-demo", mutation.clone()))
            .unwrap();
        let retry = store
            .commit(request("create-demo", mutation.clone()))
            .unwrap();
        assert_eq!(first, retry);
        let error = store
            .commit(request("create-demo-again", mutation))
            .unwrap_err();
        assert!(matches!(error, SkillStoreError::Conflict { .. }));
    }

    #[test]
    fn unconditional_overwrite_is_limited_to_explicit_force_actors() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let store = SkillStore::open(&root).unwrap();
        store
            .commit(request(
                "force-base",
                SkillMutation::PutPackage {
                    package: package("demo", "before"),
                    expected: ExpectedSkillRevision::Absent,
                },
            ))
            .unwrap();
        let rejected = store
            .commit(SkillCommitRequest {
                operation_id: "force-rejected".to_string(),
                actor: actor(),
                operation: SkillOperationKind::Edit,
                preconditions: Vec::new(),
                mutations: vec![SkillMutation::PutPackage {
                    package: package("demo", "rejected"),
                    expected: ExpectedSkillRevision::Unconditional,
                }],
                metadata: Default::default(),
            })
            .unwrap_err();
        assert!(matches!(rejected, SkillStoreError::PolicyRejected(_)));
        assert!(
            fs::read_to_string(root.join("demo/SKILL.md"))
                .unwrap()
                .contains("before")
        );

        let receipt = store
            .commit(SkillCommitRequest {
                operation_id: "force-hub".to_string(),
                actor: SkillMutationActor::SkillHub {
                    session_id: "session".to_string(),
                    source_kind: "inline".to_string(),
                },
                operation: SkillOperationKind::Install,
                preconditions: Vec::new(),
                mutations: vec![SkillMutation::PutPackage {
                    package: package("demo", "forced"),
                    expected: ExpectedSkillRevision::Unconditional,
                }],
                metadata: Default::default(),
            })
            .unwrap();
        assert!(receipt.before[0].revision.is_some());
        assert!(receipt.after[0].revision.is_some());
        assert_ne!(receipt.before[0].revision, receipt.after[0].revision);
    }

    #[test]
    fn metadata_policy_precondition_is_rechecked_under_root_lock() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let store = SkillStore::open(&root).unwrap();
        store
            .commit(request(
                "policy-base",
                SkillMutation::PutPackage {
                    package: package("demo", "before"),
                    expected: ExpectedSkillRevision::Absent,
                },
            ))
            .unwrap();
        let mut pinned = super::super::SkillMetadataPatch::default();
        pinned.update.insert("pinned".to_string(), json!(true));
        store
            .commit(SkillCommitRequest {
                operation_id: "policy-pin".to_string(),
                actor: actor(),
                operation: SkillOperationKind::MetadataOnly,
                preconditions: Vec::new(),
                mutations: Vec::new(),
                metadata: super::super::SkillMetadataDelta {
                    usage: BTreeMap::from([("demo".to_string(), pinned)]),
                    ..Default::default()
                },
            })
            .unwrap();
        let revision = store.current_revision("demo").unwrap().unwrap();
        let rejected = store
            .commit(SkillCommitRequest {
                operation_id: "policy-edit".to_string(),
                actor: actor(),
                operation: SkillOperationKind::Edit,
                preconditions: vec![super::super::SkillMetadataPrecondition {
                    store: super::super::SkillMetadataStore::Usage,
                    skill: "demo".to_string(),
                    field: "pinned".to_string(),
                    predicate: super::super::SkillMetadataPredicate::MissingOrEquals,
                    value: json!(false),
                }],
                mutations: vec![SkillMutation::PutPackage {
                    package: package("demo", "after"),
                    expected: ExpectedSkillRevision::Exact(revision),
                }],
                metadata: Default::default(),
            })
            .unwrap_err();
        assert!(matches!(rejected, SkillStoreError::PolicyRejected(_)));
        assert!(
            fs::read_to_string(root.join("demo/SKILL.md"))
                .unwrap()
                .contains("before")
        );
    }

    #[test]
    fn usage_delta_merges_counter_update_that_arrives_while_waiting_for_usage_lock() {
        use fs2::FileExt;
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(".usage.json"),
            br#"{"version":1,"skills":{"demo":{"name":"demo","view_count":1,"state":"active"}}}"#,
        )
        .unwrap();
        let lock_path = root.join(".usage.json.lock");
        let usage_lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        usage_lock.lock_exclusive().unwrap();

        let worker_root = root.clone();
        let worker = std::thread::spawn(move || {
            let mut patch = super::super::SkillMetadataPatch::default();
            patch.update.insert("state".to_string(), json!("stale"));
            SkillStore::open(&worker_root)
                .unwrap()
                .commit(SkillCommitRequest {
                    operation_id: "usage-lock-merge".to_string(),
                    actor: actor(),
                    operation: SkillOperationKind::MetadataOnly,
                    preconditions: Vec::new(),
                    mutations: Vec::new(),
                    metadata: super::super::SkillMetadataDelta {
                        usage: BTreeMap::from([("demo".to_string(), patch)]),
                        ..Default::default()
                    },
                })
                .unwrap();
        });
        while fs::read_dir(root.join(".transactions"))
            .ok()
            .and_then(|mut entries| entries.next())
            .is_none()
        {
            std::thread::yield_now();
        }
        fs::write(
            root.join(".usage.json"),
            br#"{"version":1,"skills":{"demo":{"name":"demo","view_count":9,"state":"active"}}}"#,
        )
        .unwrap();
        usage_lock.unlock().unwrap();
        worker.join().unwrap();

        let usage: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(".usage.json")).unwrap()).unwrap();
        assert_eq!(usage["skills"]["demo"]["view_count"], 9);
        assert_eq!(usage["skills"]["demo"]["state"], "stale");
    }

    #[test]
    fn recovery_preserves_usage_counter_written_after_crashed_transaction() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let normal = SkillStore::open(&root).unwrap();
        normal
            .commit(request(
                "usage-recovery-base",
                SkillMutation::PutPackage {
                    package: package("demo", "before"),
                    expected: ExpectedSkillRevision::Absent,
                },
            ))
            .unwrap();
        fs::write(
            root.join(".usage.json"),
            br#"{"version":1,"skills":{"demo":{"name":"demo","view_count":1,"state":"active"}}}"#,
        )
        .unwrap();
        let revision = normal.current_revision("demo").unwrap().unwrap();
        let mut usage = super::super::SkillMetadataPatch::default();
        usage.update.insert("state".to_string(), json!("stale"));
        let failing = failing_store(&root, "content_published");
        assert!(
            failing
                .commit(SkillCommitRequest {
                    operation_id: "usage-recovery-update".to_string(),
                    actor: actor(),
                    operation: SkillOperationKind::Patch,
                    preconditions: Vec::new(),
                    mutations: vec![SkillMutation::PatchText {
                        name: "demo".to_string(),
                        expected: ExpectedSkillRevision::Exact(revision),
                        relative_path: PathBuf::from("SKILL.md"),
                        old_string: "before".to_string(),
                        new_string: "after".to_string(),
                        replace_all: false,
                    }],
                    metadata: super::super::SkillMetadataDelta {
                        usage: BTreeMap::from([("demo".to_string(), usage)]),
                        ..Default::default()
                    },
                })
                .is_err()
        );
        fs::write(
            root.join(".usage.json"),
            br#"{"version":1,"skills":{"demo":{"name":"demo","view_count":9,"state":"active"}}}"#,
        )
        .unwrap();
        normal.recover().unwrap();
        let usage: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(".usage.json")).unwrap()).unwrap();
        assert_eq!(usage["skills"]["demo"]["view_count"], 9);
        assert_eq!(usage["skills"]["demo"]["state"], "stale");
    }

    #[test]
    fn exact_text_patch_is_evaluated_against_locked_content() {
        let temp = TempDir::new().unwrap();
        let store = SkillStore::open(&temp.path().join("skills")).unwrap();
        store
            .commit(request(
                "create-demo",
                SkillMutation::PutPackage {
                    package: package("demo", "one value"),
                    expected: ExpectedSkillRevision::Absent,
                },
            ))
            .unwrap();
        let revision = store.current_revision("demo").unwrap().unwrap();
        let receipt = store
            .commit(SkillCommitRequest {
                operation_id: "patch-demo".to_string(),
                actor: actor(),
                operation: SkillOperationKind::Patch,
                preconditions: Vec::new(),
                mutations: vec![SkillMutation::PatchText {
                    name: "demo".to_string(),
                    expected: ExpectedSkillRevision::Exact(revision),
                    relative_path: PathBuf::from("SKILL.md"),
                    old_string: "one value".to_string(),
                    new_string: "two values".to_string(),
                    replace_all: false,
                }],
                metadata: Default::default(),
            })
            .unwrap();
        assert_eq!(receipt.status, SkillStoreCommitStatus::Committed);
        assert!(
            fs::read_to_string(temp.path().join("skills/demo/SKILL.md"))
                .unwrap()
                .contains("two values")
        );
    }

    #[test]
    fn content_and_metadata_commit_together() {
        let temp = TempDir::new().unwrap();
        let store = SkillStore::open(&temp.path().join("skills")).unwrap();
        let mut provenance = super::super::SkillMetadataPatch::default();
        provenance
            .create
            .insert("origin".to_string(), json!("agent_created"));
        let receipt = store
            .commit(SkillCommitRequest {
                operation_id: "create-with-metadata".to_string(),
                actor: actor(),
                operation: SkillOperationKind::Create,
                preconditions: Vec::new(),
                mutations: vec![SkillMutation::PutPackage {
                    package: package("demo", "content"),
                    expected: ExpectedSkillRevision::Absent,
                }],
                metadata: super::super::SkillMetadataDelta {
                    provenance: BTreeMap::from([("demo".to_string(), provenance)]),
                    ..Default::default()
                },
            })
            .unwrap();
        let metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.path().join("skills/.provenance.json")).unwrap())
                .unwrap();
        assert_eq!(
            metadata["skills"]["demo"]["last_transaction_id"],
            receipt.transaction_id
        );
        assert_eq!(
            metadata["skills"]["demo"]["revision_sha256"],
            receipt.after[0].revision.as_ref().unwrap().0
        );
    }

    #[test]
    fn recovery_rolls_forward_after_publishing_intent() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let store = failing_store(&root, "journal_publishing");
        let mutation = SkillMutation::PutPackage {
            package: package("demo", "recover me"),
            expected: ExpectedSkillRevision::Absent,
        };
        assert!(
            store
                .commit(request("recover-publishing", mutation))
                .is_err()
        );

        let reopened = SkillStore::open(&root).unwrap();
        let first = reopened.recover().unwrap();
        let second = reopened.recover().unwrap();
        assert!(
            first
                .iter()
                .any(|diagnostic| matches!(diagnostic, SkillStoreDiagnostic::Recovered { .. }))
        );
        assert!(second.is_empty());
        assert!(
            fs::read_to_string(root.join("demo/SKILL.md"))
                .unwrap()
                .contains("recover me")
        );
    }

    #[test]
    fn commit_record_wins_when_journal_commit_marker_failed() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let store = failing_store(&root, "after_commit_append");
        let mutation = SkillMutation::PutPackage {
            package: package("demo", "durable"),
            expected: ExpectedSkillRevision::Absent,
        };
        let request = request("commit-wins", mutation);
        assert!(store.commit(request.clone()).is_err());

        let reopened = SkillStore::open(&root).unwrap();
        let recovered = reopened.recover().unwrap();
        assert!(
            recovered
                .iter()
                .any(|diagnostic| matches!(diagnostic, SkillStoreDiagnostic::Recovered { .. }))
        );
        let receipt = reopened.commit(request).unwrap();
        assert_eq!(receipt.operation_id, "commit-wins");
        assert_eq!(receipt.status, SkillStoreCommitStatus::Committed);
    }

    #[test]
    fn reload_pending_retry_returns_receipt_without_replaying_mutation() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let store = SkillStore::open(&root).unwrap();
        let request = request(
            "reload-pending-idempotent",
            SkillMutation::PutPackage {
                package: package("demo", "once"),
                expected: ExpectedSkillRevision::Absent,
            },
        );
        let first = store.commit(request.clone()).unwrap();
        store
            .record_reload_status(&first.transaction_id, false)
            .unwrap();
        let retry = SkillStore::open(&root).unwrap().commit(request).unwrap();
        assert_eq!(first, retry);
        assert_eq!(
            fs::read_to_string(root.join(".commits.jsonl"))
                .unwrap()
                .lines()
                .count(),
            1
        );
    }

    #[test]
    fn prepared_transaction_aborts_without_publishing() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let store = failing_store(&root, "journal_prepared");
        let mutation = SkillMutation::PutPackage {
            package: package("demo", "not yet"),
            expected: ExpectedSkillRevision::Absent,
        };
        assert!(store.commit(request("prepared-abort", mutation)).is_err());
        assert!(!root.join("demo").exists());

        let reopened = SkillStore::open(&root).unwrap();
        reopened.recover().unwrap();
        assert!(!root.join("demo").exists());
        assert!(
            fs::read_dir(root.join(".transactions"))
                .unwrap()
                .next()
                .is_none()
        );
    }

    #[test]
    fn valid_external_edit_is_reported_as_drift_and_remains_loadable() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let store = SkillStore::open(&root).unwrap();
        store
            .commit(request(
                "external-drift-base",
                SkillMutation::PutPackage {
                    package: package("demo", "before"),
                    expected: ExpectedSkillRevision::Absent,
                },
            ))
            .unwrap();
        fs::write(
            root.join("demo/SKILL.md"),
            package("demo", "external")
                .files
                .into_iter()
                .next()
                .unwrap()
                .content,
        )
        .unwrap();

        let diagnostics = store.recover().unwrap();
        assert!(diagnostics.iter().any(|diagnostic| {
            matches!(diagnostic, SkillStoreDiagnostic::ExternalDrift { skill } if skill == "demo")
        }));
        assert!(store.current_revision("demo").unwrap().is_some());
    }

    #[test]
    fn recovery_repairs_only_an_unterminated_tail_with_commit_ready_journal() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let store = failing_store(&root, "metadata_published");
        let mutation = SkillMutation::PutPackage {
            package: package("demo", "tail repair"),
            expected: ExpectedSkillRevision::Absent,
        };
        assert!(store.commit(request("tail-repair", mutation)).is_err());
        use std::io::Write as _;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(root.join(".commits.jsonl"))
            .unwrap()
            .write_all(b"{truncated")
            .unwrap();

        let reopened = SkillStore::open(&root).unwrap();
        reopened.recover().unwrap();
        assert!(
            std::fs::read_to_string(root.join(".commits.jsonl"))
                .unwrap()
                .ends_with('\n')
        );
        assert!(
            reopened
                .commit(request(
                    "tail-repair",
                    SkillMutation::PutPackage {
                        package: package("demo", "tail repair"),
                        expected: ExpectedSkillRevision::Absent,
                    },
                ))
                .is_ok()
        );
    }

    #[test]
    fn complete_corrupt_commit_record_fails_closed() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let store = SkillStore::open(&root).unwrap();
        store
            .commit(request(
                "corrupt-base",
                SkillMutation::PutPackage {
                    package: package("demo", "base"),
                    expected: ExpectedSkillRevision::Absent,
                },
            ))
            .unwrap();
        use std::io::Write as _;
        std::fs::OpenOptions::new()
            .append(true)
            .open(root.join(".commits.jsonl"))
            .unwrap()
            .write_all(b"{corrupt}\n")
            .unwrap();
        assert!(matches!(
            store.recover(),
            Err(SkillStoreError::JournalCorrupt(_))
        ));
    }

    #[test]
    fn recovery_rolls_back_when_after_image_is_lost_after_live_move() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let normal = SkillStore::open(&root).unwrap();
        normal
            .commit(request(
                "rollback-base",
                SkillMutation::PutPackage {
                    package: package("demo", "original"),
                    expected: ExpectedSkillRevision::Absent,
                },
            ))
            .unwrap();
        let revision = normal.current_revision("demo").unwrap().unwrap();
        let failing = failing_store(&root, "live_moved_to_before");
        assert!(
            failing
                .commit(SkillCommitRequest {
                    operation_id: "rollback-update".to_string(),
                    actor: actor(),
                    operation: SkillOperationKind::Patch,
                    preconditions: Vec::new(),
                    mutations: vec![SkillMutation::PatchText {
                        name: "demo".to_string(),
                        expected: ExpectedSkillRevision::Exact(revision),
                        relative_path: PathBuf::from("SKILL.md"),
                        old_string: "original".to_string(),
                        new_string: "replacement".to_string(),
                        replace_all: false,
                    }],
                    metadata: Default::default(),
                })
                .is_err()
        );
        let transaction = fs::read_dir(root.join(".transactions"))
            .unwrap()
            .map(Result::unwrap)
            .find(|entry| entry.path().join("journal.json").is_file())
            .unwrap()
            .path();
        fs::remove_dir_all(transaction.join("staged")).unwrap();

        let recovered = normal.recover().unwrap();
        assert!(
            recovered
                .iter()
                .any(|diagnostic| matches!(diagnostic, SkillStoreDiagnostic::Recovered { .. }))
        );
        let content = fs::read_to_string(root.join("demo/SKILL.md")).unwrap();
        assert!(content.contains("original"));
        assert!(!content.contains("replacement"));
    }

    #[test]
    fn recovery_recognizes_after_image_when_crash_precedes_progress_journal() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let store = failing_store(&root, "staged_moved_to_live");
        assert!(
            store
                .commit(request(
                    "after-before-progress",
                    SkillMutation::PutPackage {
                        package: package("demo", "published"),
                        expected: ExpectedSkillRevision::Absent,
                    },
                ))
                .is_err()
        );
        let reopened = SkillStore::open(&root).unwrap();
        reopened.recover().unwrap();
        assert!(
            fs::read_to_string(root.join("demo/SKILL.md"))
                .unwrap()
                .contains("published")
        );
        assert!(reopened.recover().unwrap().is_empty());
    }

    #[test]
    fn multi_skill_consolidate_recovers_to_complete_after_state() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let normal = SkillStore::open(&root).unwrap();
        for name in ["alpha", "beta"] {
            normal
                .commit(request(
                    &format!("create-{name}"),
                    SkillMutation::PutPackage {
                        package: package(name, name),
                        expected: ExpectedSkillRevision::Absent,
                    },
                ))
                .unwrap();
        }
        let alpha = normal.current_revision("alpha").unwrap().unwrap();
        let beta = normal.current_revision("beta").unwrap().unwrap();
        let failing = failing_store(&root, "staged_moved_to_live");
        assert!(
            failing
                .commit(SkillCommitRequest {
                    operation_id: "consolidate-crash".to_string(),
                    actor: actor(),
                    operation: SkillOperationKind::Consolidate,
                    preconditions: Vec::new(),
                    mutations: vec![SkillMutation::Consolidate {
                        sources: vec![("alpha".to_string(), alpha), ("beta".to_string(), beta),],
                        destination: package("umbrella", "combined"),
                        expected_destination: ExpectedSkillRevision::Absent,
                    }],
                    metadata: Default::default(),
                })
                .is_err()
        );
        normal.recover().unwrap();
        assert!(!root.join("alpha").exists());
        assert!(!root.join("beta").exists());
        assert!(root.join(".archive/alpha/SKILL.md").is_file());
        assert!(root.join(".archive/beta/SKILL.md").is_file());
        assert!(root.join("umbrella/SKILL.md").is_file());
        assert!(normal.recover().unwrap().is_empty());
    }

    #[test]
    fn metadata_after_images_recover_with_the_content_transaction() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let store = failing_store(&root, "content_published");
        let mut provenance = super::super::SkillMetadataPatch::default();
        provenance
            .create
            .insert("origin".to_string(), json!("agent_created"));
        let request = SkillCommitRequest {
            operation_id: "metadata-recovery".to_string(),
            actor: actor(),
            operation: SkillOperationKind::Create,
            preconditions: Vec::new(),
            mutations: vec![SkillMutation::PutPackage {
                package: package("demo", "metadata"),
                expected: ExpectedSkillRevision::Absent,
            }],
            metadata: super::super::SkillMetadataDelta {
                provenance: BTreeMap::from([("demo".to_string(), provenance)]),
                ..Default::default()
            },
        };
        assert!(store.commit(request.clone()).is_err());
        let reopened = SkillStore::open(&root).unwrap();
        reopened.recover().unwrap();
        let receipt = reopened.commit(request).unwrap();
        let metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(".provenance.json")).unwrap()).unwrap();
        assert_eq!(
            metadata["skills"]["demo"]["last_transaction_id"],
            receipt.transaction_id
        );
        assert_eq!(
            metadata["skills"]["demo"]["revision_sha256"],
            receipt.after[0].revision.as_ref().unwrap().0
        );
    }

    #[test]
    fn fresh_registry_load_recovers_before_scanning() {
        let workspace = TempDir::new().unwrap();
        let root = workspace.path().join(".kcoder/skills");
        let store = failing_store(&root, "journal_publishing");
        assert!(
            store
                .commit(request(
                    "registry-recovery",
                    SkillMutation::PutPackage {
                        package: package("demo", "registry recovery"),
                        expected: ExpectedSkillRevision::Absent,
                    },
                ))
                .is_err()
        );
        let registry = crate::SkillRegistry::load_project_only(workspace.path()).unwrap();
        assert!(registry.get("demo").is_some());
        assert!(
            fs::read_dir(root.join(".transactions"))
                .unwrap()
                .next()
                .is_none()
        );
    }

    #[test]
    fn cleanup_failure_keeps_a_recoverable_committed_transaction() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let store = failing_store(&root, "before_cleanup");
        let receipt = store
            .commit(request(
                "cleanup-recovery",
                SkillMutation::PutPackage {
                    package: package("demo", "cleanup"),
                    expected: ExpectedSkillRevision::Absent,
                },
            ))
            .unwrap();
        assert!(
            root.join(".transactions")
                .join(&receipt.transaction_id)
                .exists()
        );
        let diagnostics = SkillStore::open(&root).unwrap().recover().unwrap();
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| matches!(diagnostic, SkillStoreDiagnostic::Recovered { .. }))
        );
        assert!(
            !root
                .join(".transactions")
                .join(receipt.transaction_id)
                .exists()
        );
    }

    #[test]
    fn fault_matrix_recovers_to_deterministic_before_or_after_state() {
        let cases = [
            ("before_staging_package", false),
            ("staged_package_written", false),
            ("after_images_prepared", false),
            ("before_journal_prepared", false),
            ("journal_prepared", false),
            ("before_journal_publishing", false),
            ("journal_publishing", true),
            ("live_moved_to_before", true),
            ("staged_moved_to_live", true),
            ("content_move_published", true),
            ("content_published", true),
            ("before_metadata_publish", true),
            ("metadata_file_published", true),
            ("metadata_published", true),
            ("before_commit_append", true),
            ("after_commit_append", true),
            ("before_journal_committed", true),
            ("journal_committed", true),
        ];
        for (point, expect_after) in cases {
            let temp = TempDir::new().unwrap();
            let root = temp.path().join("skills");
            let normal = SkillStore::open(&root).unwrap();
            normal
                .commit(request(
                    &format!("fault-base-{point}"),
                    SkillMutation::PutPackage {
                        package: package("demo", "before"),
                        expected: ExpectedSkillRevision::Absent,
                    },
                ))
                .unwrap();
            let revision = normal.current_revision("demo").unwrap().unwrap();
            let mut provenance = super::super::SkillMetadataPatch::default();
            provenance
                .create
                .insert("origin".to_string(), json!("agent_created"));
            let mut usage = super::super::SkillMetadataPatch::default();
            usage.update.insert("state".to_string(), json!("stale"));
            let failing = failing_store(&root, point);
            let outcome = failing.commit(SkillCommitRequest {
                operation_id: format!("fault-update-{point}"),
                actor: actor(),
                operation: SkillOperationKind::Patch,
                preconditions: Vec::new(),
                mutations: vec![SkillMutation::PatchText {
                    name: "demo".to_string(),
                    expected: ExpectedSkillRevision::Exact(revision),
                    relative_path: PathBuf::from("SKILL.md"),
                    old_string: "before".to_string(),
                    new_string: "after".to_string(),
                    replace_all: false,
                }],
                metadata: super::super::SkillMetadataDelta {
                    provenance: BTreeMap::from([("demo".to_string(), provenance)]),
                    usage: BTreeMap::from([("demo".to_string(), usage)]),
                    bundled_manifest: Some(b"manifest".to_vec()),
                    ..Default::default()
                },
            });
            assert!(outcome.is_err(), "failpoint {point} did not fire");

            let reopened = SkillStore::open(&root).unwrap();
            reopened.recover().unwrap();
            let first = fs::read_to_string(root.join("demo/SKILL.md")).unwrap();
            reopened.recover().unwrap();
            let second = fs::read_to_string(root.join("demo/SKILL.md")).unwrap();
            assert_eq!(first, second, "recovery was not idempotent at {point}");
            assert_eq!(
                first.contains("after"),
                expect_after,
                "unexpected recovered state at {point}"
            );
            if expect_after {
                assert!(root.join(".provenance.json").is_file(), "{point}");
                assert!(root.join(".usage.json").is_file(), "{point}");
                assert!(root.join(".bundled_manifest").is_file(), "{point}");
            }
        }
    }

    #[test]
    fn every_metadata_after_image_position_is_recoverable() {
        for nth in 1..=4 {
            let temp = TempDir::new().unwrap();
            let root = temp.path().join("skills");
            let store = SkillStore::open(&root)
                .unwrap()
                .with_fault_injector(Arc::new(FailNth {
                    point: "before_metadata_publish",
                    nth,
                    calls: AtomicUsize::new(0),
                }));
            let mut provenance = super::super::SkillMetadataPatch::default();
            provenance
                .update
                .insert("origin".to_string(), json!("agent_created"));
            let mut usage = super::super::SkillMetadataPatch::default();
            usage.update.insert("state".to_string(), json!("active"));
            assert!(
                store
                    .commit(SkillCommitRequest {
                        operation_id: format!("metadata-position-{nth}"),
                        actor: actor(),
                        operation: SkillOperationKind::Create,
                        preconditions: Vec::new(),
                        mutations: vec![SkillMutation::PutPackage {
                            package: package("demo", "metadata positions"),
                            expected: ExpectedSkillRevision::Absent,
                        }],
                        metadata: super::super::SkillMetadataDelta {
                            provenance: BTreeMap::from([("demo".to_string(), provenance)]),
                            usage: BTreeMap::from([("demo".to_string(), usage)]),
                            bundled_manifest: Some(b"manifest".to_vec()),
                            ..Default::default()
                        },
                    })
                    .is_err(),
                "metadata failpoint {nth} did not fire"
            );
            let reopened = SkillStore::open(&root).unwrap();
            reopened.recover().unwrap();
            reopened.recover().unwrap();
            assert!(root.join("demo/SKILL.md").is_file());
            assert!(root.join(".bundled_manifest").is_file());
            assert!(root.join(".provenance.json").is_file());
            assert!(root.join(".usage.json").is_file());
            assert!(root.join(".store-state.json").is_file());
        }
    }
}
