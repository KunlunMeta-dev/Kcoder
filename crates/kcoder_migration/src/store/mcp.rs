//! MCP uses the same journal ownership and revision rules as other migration assets.
use super::*;
use crate::mcp::{McpResolution, McpTarget};

#[cfg(test)]
thread_local! { static FAIL_AFTER_MCP_PUBLICATION: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

impl MigrationStore {
    pub fn prepare_mcp(
        &self,
        job_id: &str,
        expected_sequence: u64,
        target: &McpTarget,
        resolution: &McpResolution,
    ) -> Result<MigrationJob> {
        self.update(job_id, expected_sequence, |job| {
            ensure!(
                job.status == JobStatus::Ready
                    && job.provider_plans.is_empty()
                    && job.mcp_plans.is_empty(),
                "migration_invalid_transition"
            );
            ensure!(
                job.selected_item_ids == [resolution.item_id.clone()],
                "migration_mcp_selection_required"
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
            if let Some(project) = job
                .source_binding
                .as_ref()
                .and_then(|binding| binding.project_root())
                && let Some(candidate) = item.mcp.as_mut()
            {
                candidate.config.policy.workspace = Some(project.to_string_lossy().into_owned());
            }
            let plan = target.prepare(item, resolution)?;
            *item = plan.item().clone();
            job.mcp_plans.push(plan);
            Ok(true)
        })
    }
    pub fn apply_mcp(
        &self,
        job_id: &str,
        expected_sequence: u64,
        plan_id: &str,
        target: &McpTarget,
    ) -> Result<MigrationJob> {
        let _lock = self.write_lock()?;
        let mut job = self.load(job_id)?;
        let plan = job
            .mcp_plans
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
        let source_blocked = job
            .source_binding
            .as_ref()
            .is_some_and(|binding| binding.read().is_err());
        let cancelled = job.status == JobStatus::CancelRequested;
        if status == ItemStatus::Staged {
            ensure!(!source_blocked, "migration_source_changed");
            ensure!(!cancelled, "migration_cancel_pending");
            job.status = JobStatus::Applying;
            job.inventory.items[index].preview.status = ItemStatus::Committing;
            bump(&mut job)?;
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
                bump(&mut job)?;
                self.save(&job)?;
                if settled {
                    return Ok(job);
                }
                return Err(error);
            }
        };
        #[cfg(test)]
        if FAIL_AFTER_MCP_PUBLICATION.with(|fail| fail.replace(false)) {
            anyhow::bail!("migration_injected_lost_mcp_receipt");
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
        bump(&mut job)?;
        self.save(&job)?;
        Ok(job)
    }
    pub fn rollback_mcp(
        &self,
        job_id: &str,
        expected_sequence: u64,
        plan_id: &str,
        target: &McpTarget,
    ) -> Result<MigrationJob> {
        let _lock = self.write_lock()?;
        let mut job = self.load(job_id)?;
        let plan = job
            .mcp_plans
            .iter()
            .find(|plan| plan.id() == plan_id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_plan"))?
            .clone();
        target.check_binding(&plan)?;
        ensure!(
            !job.mcp_credential_plans
                .iter()
                .any(|key| key.item_id == plan.item().preview.id
                    && key.phase != crate::credentials::CredentialPhase::Undone),
            "migration_mcp_private_values_depend_on_import"
        );
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
            receipt.ownership_confirmed,
            "migration_rollback_ownership_unknown"
        );
        let index = job
            .inventory
            .items
            .iter()
            .position(|item| item.preview.id == plan.item().preview.id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        job.status = JobStatus::RollingBack;
        bump(&mut job)?;
        self.save(&job)?;
        if let Err(error) = self
            .require_unreferenced(job_id, plan.id())
            .and_then(|_| target.rollback(&plan))
        {
            if matches!(
                error.to_string().as_str(),
                "migration_target_changed" | "migration_result_referenced"
            ) {
                job.status = JobStatus::RollbackConflict;
                job.inventory.items[index].preview.status = ItemStatus::RollbackConflict;
            }
            bump(&mut job)?;
            self.save(&job)?;
            return Err(error);
        }
        job.status = JobStatus::RolledBack;
        job.inventory.items[index].preview.status = ItemStatus::RolledBack;
        bump(&mut job)?;
        self.save(&job)?;
        Ok(job)
    }
}
fn bump(job: &mut MigrationJob) -> Result<()> {
    job.sequence = job
        .sequence
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("migration_sequence_exhausted"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn staged(root: &Path) -> (MigrationStore, MigrationJob, McpTarget) {
        let store = MigrationStore::open_or_create(root).unwrap();
        let inventory=crate::parse_codex_config("[mcp_servers.documents]\ncommand='never-run-fixture'\nargs=['--mode','read']\nenabled_tools=['read','write']\ndisabled_tools=['write']\n").unwrap();
        let id = inventory
            .items
            .iter()
            .find(|item| item.mcp.is_some())
            .unwrap()
            .preview
            .id
            .clone();
        let job = store.create_scan("fixture", inventory).unwrap();
        let job = store
            .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
            .unwrap();
        let target = McpTarget::open(root).unwrap();
        let job = store
            .prepare_mcp(
                &job.job_id,
                job.sequence,
                &target,
                &McpResolution {
                    item_id: id,
                    target_name: "documents".into(),
                    cwd: None,
                    enable_after_import: false,
                },
            )
            .unwrap();
        (store, job, target)
    }
    #[test]
    fn native_mcp_commit_is_disabled_idempotent_and_conservatively_reversible() {
        let root = tempfile::tempdir().unwrap();
        let original = serde_json::json!({"mcp_disabled_servers":["before","documents","after"]});
        std::fs::write(root.path().join("settings.json"), original.to_string()).unwrap();
        let (store, job, target) = staged(root.path());
        let id = job.mcp_plans[0].id().to_owned();
        let committed = store
            .apply_mcp(&job.job_id, job.sequence, &id, &target)
            .unwrap();
        let path = root.path().join("settings.json");
        let document = kcoder_config::read_settings_file(&path).unwrap();
        assert_eq!(
            document["mcp_servers"][0]["policy"]["enabled_tools"],
            serde_json::json!(["read", "write"])
        );
        assert_eq!(
            document["mcp_disabled_servers"],
            original["mcp_disabled_servers"]
        );
        assert_eq!(
            store
                .apply_mcp(&job.job_id, job.sequence, &id, &target)
                .unwrap(),
            committed
        );
        store
            .rollback_mcp(&job.job_id, committed.sequence, &id, &target)
            .unwrap();
        assert_eq!(kcoder_config::read_settings_file(&path).unwrap(), original);
    }
    #[test]
    fn a_lost_mcp_receipt_is_reconciled_but_does_not_grant_deletion_authority() {
        let root = tempfile::tempdir().unwrap();
        let (store, job, target) = staged(root.path());
        let id = job.mcp_plans[0].id().to_owned();
        FAIL_AFTER_MCP_PUBLICATION.with(|fail| fail.set(true));
        assert!(
            store
                .apply_mcp(&job.job_id, job.sequence, &id, &target)
                .is_err()
        );
        let store = MigrationStore::open_existing(root.path()).unwrap();
        let pending = store.read(&job.job_id).unwrap();
        let committed = store
            .apply_mcp(&job.job_id, pending.sequence, &id, &target)
            .unwrap();
        assert!(!committed.receipts[0].ownership_confirmed);
        assert_eq!(
            store
                .rollback_mcp(&job.job_id, committed.sequence, &id, &target)
                .unwrap_err()
                .to_string(),
            "migration_rollback_ownership_unknown"
        );
    }
}
