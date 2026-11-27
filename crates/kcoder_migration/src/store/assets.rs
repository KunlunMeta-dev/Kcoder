//! Work assets share the journal's single-item commit and recovery boundaries.
use super::*;
use crate::assets::{AssetResolution, AssetTarget};

#[cfg(test)]
thread_local! {static FAIL_AFTER_ASSET_PUBLICATION: std::cell::Cell<bool> = const {std::cell::Cell::new(false)};}

impl MigrationStore {
    pub fn prepare_asset(
        &self,
        job_id: &str,
        expected_sequence: u64,
        target: &AssetTarget,
        resolution: &AssetResolution,
    ) -> Result<MigrationJob> {
        self.update(job_id, expected_sequence, |job| {
            ensure!(
                job.status == JobStatus::Ready
                    && job.provider_plans.is_empty()
                    && job.mcp_plans.is_empty()
                    && job.asset_plans.is_empty(),
                "migration_invalid_transition"
            );
            ensure!(
                job.selected_item_ids == [resolution.item_id.clone()],
                "migration_asset_selection_required"
            );
            let binding = job
                .asset_binding
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_asset_source_required"))?;
            let item = job
                .inventory
                .items
                .iter_mut()
                .find(|item| item.preview.id == resolution.item_id)
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
            let mut plan = target.prepare(item, binding, resolution)?;
            plan.bind_memory_job(job_id)?;
            *item = plan.item().clone();
            job.asset_plans.push(plan);
            Ok(true)
        })
    }
    pub fn apply_asset(
        &self,
        job_id: &str,
        expected_sequence: u64,
        plan_id: &str,
        target: &AssetTarget,
    ) -> Result<MigrationJob> {
        let _lock = self.write_lock()?;
        let mut job = self.load(job_id)?;
        let plan = job
            .asset_plans
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
        ensure!(
            matches!(
                status,
                ItemStatus::Staged | ItemStatus::Committing | ItemStatus::CommitUnknown
            ),
            "migration_invalid_transition"
        );
        let source_blocked = job.asset_binding.as_ref().is_none_or(|binding| {
            plan.item()
                .asset
                .as_ref()
                .is_none_or(|candidate| binding.read(&candidate.entry).is_err())
        });
        let cancelled = job.status == JobStatus::CancelRequested;
        if status == ItemStatus::Staged {
            ensure!(!source_blocked, "migration_source_changed");
            ensure!(!cancelled, "migration_cancel_pending");
            job.status = JobStatus::Applying;
            job.inventory.items[index].preview.status = ItemStatus::Committing;
            advance(&mut job)?;
            self.save(&job)?;
        }
        let publication = match target.publish(&plan, cancelled, source_blocked) {
            Ok(publication) => publication,
            Err(error) => {
                job.inventory.items[index].preview.status = ItemStatus::CommitUnknown;
                let settled = error.to_string() == "migration_cancelled_unsettled_publication";
                if settled {
                    job.status = JobStatus::Cancelled;
                }
                advance(&mut job)?;
                self.save(&job)?;
                if settled {
                    return Ok(job);
                }
                return Err(error);
            }
        };
        #[cfg(test)]
        if FAIL_AFTER_ASSET_PUBLICATION.with(|fail| fail.replace(false)) {
            anyhow::bail!("migration_injected_lost_asset_receipt");
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
        } else {
            JobStatus::Completed
        };
        advance(&mut job)?;
        self.save(&job)?;
        Ok(job)
    }
    pub fn rollback_asset(
        &self,
        job_id: &str,
        expected_sequence: u64,
        plan_id: &str,
        target: &AssetTarget,
    ) -> Result<MigrationJob> {
        let _lock = self.write_lock()?;
        let mut job = self.load(job_id)?;
        let plan = job
            .asset_plans
            .iter()
            .find(|plan| plan.id() == plan_id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_plan"))?
            .clone();
        target.check_binding(&plan)?;
        if job.status == JobStatus::RolledBack {
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
            receipt.ownership_confirmed || plan.native_reference(),
            "migration_rollback_ownership_unknown"
        );
        let index = job
            .inventory
            .items
            .iter()
            .position(|item| item.preview.id == plan.item().preview.id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        job.status = JobStatus::RollingBack;
        advance(&mut job)?;
        self.save(&job)?;
        if let Err(error) = self
            .require_unreferenced(job_id, plan.id())
            .and_then(|_| target.rollback(&plan))
        {
            job.status = JobStatus::RollbackConflict;
            job.inventory.items[index].preview.status = ItemStatus::RollbackConflict;
            advance(&mut job)?;
            self.save(&job)?;
            return Err(error);
        }
        job.status = JobStatus::RolledBack;
        job.inventory.items[index].preview.status = ItemStatus::RolledBack;
        advance(&mut job)?;
        self.save(&job)?;
        Ok(job)
    }
}
fn advance(job: &mut MigrationJob) -> Result<()> {
    job.sequence = job
        .sequence
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("migration_sequence_exhausted"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{asset_sources::AssetBundleBinding, assets::AssetResolution};
    use kcoder_config::imported_context::{ImportedContextScope, ImportedContextStore};
    use kcoder_types::migration::{MigrationCategory as Category, MigrationSourceKind as Kind};

    fn staged(
        root: &Path,
        category: Category,
        source: &str,
        enable: bool,
    ) -> (
        MigrationStore,
        MigrationJob,
        AssetTarget,
        std::path::PathBuf,
    ) {
        let source_root = root.join("source");
        let profile = root.join("profile");
        std::fs::create_dir(&source_root).unwrap();
        std::fs::create_dir(&profile).unwrap();
        let path = if category == Category::Skill {
            let path = source_root.join("sample");
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("SKILL.md"), source).unwrap();
            source_root.clone()
        } else {
            let path = source_root.join("CLAUDE.md");
            std::fs::write(&path, source).unwrap();
            path
        };
        let binding = AssetBundleBinding::capture(
            &path,
            Kind::ClaudeCode,
            category,
            ImportedContextScope::Global,
            category == Category::Skill,
        )
        .unwrap();
        let store = MigrationStore::open_or_create(&profile).unwrap();
        let job = store.create_asset_scan(binding).unwrap();
        let item_id = job.inventory.items[0].preview.id.clone();
        let job = store
            .select(&job.job_id, job.sequence, std::slice::from_ref(&item_id))
            .unwrap();
        let target = AssetTarget::open(&profile).unwrap();
        let job = store
            .prepare_asset(
                &job.job_id,
                job.sequence,
                &target,
                &AssetResolution {
                    agent_adaptation: None,
                    item_id,
                    target_name: "sample".into(),
                    enable_after_import: enable,
                    memory_scope: (category == Category::Memory)
                        .then_some(ImportedContextScope::Global),
                },
            )
            .unwrap();
        (store, job, target, profile)
    }
    #[test]
    fn skill_lost_receipt_reconciles_native_ownership_and_archives_only_import() {
        let root = tempfile::tempdir().unwrap();
        let (store, job, target, profile) = staged(
            root.path(),
            Category::Skill,
            "---\nname: external\ndescription: Fixture\n---\nUse $ARGUMENTS.\n",
            false,
        );
        let id = job.asset_plans[0].id();
        FAIL_AFTER_ASSET_PUBLICATION.with(|fail| fail.set(true));
        assert!(
            store
                .apply_asset(&job.job_id, job.sequence, id, &target)
                .is_err()
        );
        let store = MigrationStore::open_existing(&profile).unwrap();
        let pending = store.read(&job.job_id).unwrap();
        let committed = store
            .apply_asset(&job.job_id, pending.sequence, id, &target)
            .unwrap();
        assert!(committed.receipts[0].ownership_confirmed);
        let skill =
            kcoder_skills::parse_skill_file(&profile.join("skills/sample/SKILL.md")).unwrap();
        assert!(!skill.activation.unwrap().default_enabled);
        assert_eq!(
            store
                .apply_asset(&job.job_id, job.sequence, id, &target)
                .unwrap(),
            committed
        );
        store
            .rollback_asset(&job.job_id, committed.sequence, id, &target)
            .unwrap();
        assert!(!profile.join("skills/sample").exists());
        assert!(root.path().join("source/sample/SKILL.md").is_file());
    }
    #[test]
    fn context_receipt_is_private_memory_inactive_and_user_changes_block_undo() {
        let root = tempfile::tempdir().unwrap();
        let (store, job, target, profile) = staged(
            root.path(),
            Category::Memory,
            "PRIVATE_MEMORY_CONTENT",
            false,
        );
        assert!(
            !serde_json::to_string(&job.inventory)
                .unwrap()
                .contains("PRIVATE_MEMORY_CONTENT")
        );
        let id = job.asset_plans[0].id();
        let committed = store
            .apply_asset(&job.job_id, job.sequence, id, &target)
            .unwrap();
        let contexts = ImportedContextStore::open(&profile).unwrap();
        let record = contexts.list().unwrap().remove(0);
        assert!(!record.enabled);
        assert!(
            kcoder_config::imported_context::imported_context_prompt(&profile, root.path(), true)
                .unwrap()
                .is_none()
        );
        contexts
            .memory_control(&kcoder_config::imported_context::ImportedMemoryControl {
                request_id: "review-old-memory-fixture".into(),
                id: record.id.clone(),
                owner_operation_id: record.operation_id.clone(),
                expected_revision: kcoder_config::imported_context::imported_context_revision(
                    &record,
                )
                .unwrap(),
                enabled: true,
                confirm_unverified_notes: true,
            })
            .unwrap();
        assert!(
            store
                .rollback_asset(&job.job_id, committed.sequence, id, &target)
                .is_err()
        );
        assert_eq!(
            store.read(&job.job_id).unwrap().status,
            JobStatus::RollbackConflict
        );
        assert!(contexts.list().unwrap()[0].enabled);
    }
    #[test]
    fn source_changed_after_plan_is_not_published() {
        let root = tempfile::tempdir().unwrap();
        let (store, job, target, profile) = staged(
            root.path(),
            Category::Instructions,
            "Original constraints",
            true,
        );
        std::fs::write(root.path().join("source/CLAUDE.md"), "Changed constraints").unwrap();
        assert_eq!(
            store
                .apply_asset(&job.job_id, job.sequence, job.asset_plans[0].id(), &target)
                .unwrap_err()
                .to_string(),
            "migration_source_changed"
        );
        assert!(
            ImportedContextStore::open(&profile)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn skill_edit_after_import_blocks_archive() {
        let root = tempfile::tempdir().unwrap();
        let (store, job, target, profile) = staged(
            root.path(),
            Category::Skill,
            "---\nname: sample\n---\nOriginal",
            false,
        );
        let id = job.asset_plans[0].id();
        let committed = store
            .apply_asset(&job.job_id, job.sequence, id, &target)
            .unwrap();
        std::fs::write(profile.join("skills/sample/notes.md"), "User notes").unwrap();
        assert!(
            store
                .rollback_asset(&job.job_id, committed.sequence, id, &target)
                .is_err()
        );
        assert!(profile.join("skills/sample/notes.md").is_file());
    }
}
