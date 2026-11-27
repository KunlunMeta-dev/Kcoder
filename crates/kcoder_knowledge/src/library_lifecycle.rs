//! Reversible library trash and owner-scoped permanent cleanup.
use crate::{KnowledgeCatalog, KnowledgeScope, Library, catalog::read_library};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};

const LIBRARY_COLUMNS: &str =
    "id,name,purpose,archived,metadata_revision,deleted_at_ms,purge_pending";
const LIBRARY_DATA_TABLES: &[&str] = &[
    "knowledge_image_import_calls",
    "knowledge_image_imports",
    "knowledge_review_receipts",
    "knowledge_tool_loop_steps",
    "knowledge_page_findings",
    "knowledge_pending_units",
    "knowledge_finding_decisions",
    "knowledge_job_outcomes",
    "knowledge_revision_assessments",
    "knowledge_pipeline_stages",
    "knowledge_automatic_merge_leases",
    "knowledge_stage_cache",
    "knowledge_job_calls",
    "knowledge_job_budgets",
    "knowledge_jobs",
    "knowledge_source_extractions",
    "knowledge_source_lifecycle",
    "knowledge_originals",
    "knowledge_chunks",
    "knowledge_page_revisions",
    "knowledge_pages",
    "knowledge_sources",
    "knowledge_commits",
    "knowledge_fts",
];

impl KnowledgeCatalog {
    pub fn set_trashed(
        &mut self,
        scope: &KnowledgeScope,
        id: &str,
        expected_revision: u64,
        trashed: bool,
    ) -> Result<Library> {
        ensure!(
            expected_revision <= i64::MAX as u64,
            "invalid library revision"
        );
        let now = crate::jobs::now_ms()?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let (current, purged) = read_scoped(&tx, scope, id)?;
        ensure!(!purged, "knowledge library was permanently deleted");
        ensure!(
            current.revision == expected_revision,
            "library revision conflict"
        );

        let deleted_at_ms = if trashed {
            ensure!(
                current.deleted_at_ms.is_none(),
                "knowledge library is already in the trash"
            );
            let changed = tx.execute(
                "UPDATE libraries SET deleted_at_ms=?4,metadata_revision=metadata_revision+1 WHERE id=?1 AND principal=?2 AND target=?3 AND metadata_revision=?5 AND deleted_at_ms IS NULL AND purge_pending=0",
                params![id, scope.principal, scope.target, now, expected_revision as i64],
            )?;
            ensure!(changed == 1, "library revision conflict");
            tx.execute(
                "UPDATE knowledge_jobs SET status='paused',error_code='library_trashed',lease_token=NULL,lease_until_ms=0 WHERE library_id=?1 AND status IN ('queued','running')",
                [id],
            )?;
            tx.execute(
                "UPDATE knowledge_image_imports SET status='cancelled',error_code='library_trashed',lease_token=NULL,lease_until_ms=0,updated_at_ms=?2 WHERE library_id=?1 AND status IN ('accepted','running')",
                params![id, now],
            )?;
            tx.execute(
                "DELETE FROM knowledge_automatic_merge_leases WHERE library_id=?1",
                [id],
            )?;
            tx.execute(
                "DELETE FROM knowledge_defaults WHERE principal=?1 AND target=?2 AND library_id=?3",
                params![scope.principal, scope.target, id],
            )?;
            Some(now)
        } else {
            ensure!(
                current.deleted_at_ms.is_some(),
                "knowledge library is not in the trash"
            );
            ensure!(
                !current.purge_pending,
                "library cleanup is already in progress"
            );
            let changed = tx.execute(
                "UPDATE libraries SET deleted_at_ms=NULL,metadata_revision=metadata_revision+1 WHERE id=?1 AND principal=?2 AND target=?3 AND metadata_revision=?4 AND deleted_at_ms IS NOT NULL AND purge_pending=0",
                params![id, scope.principal, scope.target, expected_revision as i64],
            )?;
            ensure!(changed == 1, "library revision conflict");
            None
        };
        tx.commit()?;
        Ok(Library {
            revision: expected_revision + 1,
            deleted_at_ms,
            purge_after_ms: deleted_at_ms
                .map(|value| value.saturating_add(crate::catalog::LIBRARY_TRASH_RETENTION_MS)),
            purge_pending: false,
            ..current
        })
    }

    pub fn purge_library(
        &mut self,
        scope: &KnowledgeScope,
        id: &str,
        expected_revision: u64,
    ) -> Result<()> {
        ensure!(
            expected_revision <= i64::MAX as u64,
            "invalid library revision"
        );
        let now = crate::jobs::now_ms()?;
        {
            let tx = self
                .connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let (current, purged) = read_scoped(&tx, scope, id)?;
            ensure!(
                current.revision == expected_revision,
                "library revision conflict"
            );
            if purged {
                tx.commit()?;
                return Ok(());
            }
            let deleted_at = current
                .deleted_at_ms
                .ok_or_else(|| anyhow::anyhow!("knowledge library is not in the trash"))?;
            if !current.purge_pending {
                let purge_after =
                    deleted_at.saturating_add(crate::catalog::LIBRARY_TRASH_RETENTION_MS);
                ensure!(
                    now >= purge_after,
                    "knowledge library retention period has not elapsed"
                );
                let changed = tx.execute(
                    "UPDATE libraries SET purge_pending=1 WHERE id=?1 AND principal=?2 AND target=?3 AND metadata_revision=?4 AND deleted_at_ms=?5 AND purge_pending=0",
                    params![id, scope.principal, scope.target, expected_revision as i64, deleted_at],
                )?;
                ensure!(changed == 1, "library revision conflict");
            }
            tx.execute(
                "UPDATE knowledge_jobs SET status='paused',error_code='library_purge_pending',lease_token=NULL,lease_until_ms=0 WHERE library_id=?1 AND status IN ('queued','running')",
                [id],
            )?;
            tx.execute(
                "UPDATE knowledge_image_imports SET status='cancelled',error_code='library_purge_pending',lease_token=NULL,lease_until_ms=0,updated_at_ms=?2 WHERE library_id=?1 AND status IN ('accepted','running')",
                params![id, now],
            )?;
            tx.execute(
                "DELETE FROM knowledge_automatic_merge_leases WHERE library_id=?1",
                [id],
            )?;
            tx.execute(
                "DELETE FROM knowledge_defaults WHERE principal=?1 AND target=?2 AND library_id=?3",
                params![scope.principal, scope.target, id],
            )?;
            tx.commit()?;
        }

        // The durable marker makes a partially completed filesystem cleanup safe to retry.
        self.objects.remove_library_permanently(id)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let pending: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1 AND principal=?2 AND target=?3 AND deleted_at_ms IS NOT NULL AND purge_pending=1 AND purged_at_ms IS NULL)",
                params![id, scope.principal, scope.target],
                |row| row.get(0),
            )?;
        ensure!(pending, "library cleanup ownership changed");
        for table in LIBRARY_DATA_TABLES {
            tx.execute(&format!("DELETE FROM {table} WHERE library_id=?1"), [id])?;
        }
        tx.execute(
            "DELETE FROM knowledge_defaults WHERE principal=?1 AND target=?2 AND library_id=?3",
            params![scope.principal, scope.target, id],
        )?;
        let removed = tx.execute(
            "UPDATE libraries SET name='',purpose='',purge_pending=0,purged_at_ms=?4 WHERE id=?1 AND principal=?2 AND target=?3 AND deleted_at_ms IS NOT NULL AND purge_pending=1 AND purged_at_ms IS NULL",
            params![id, scope.principal, scope.target, now],
        )?;
        ensure!(removed == 1, "library cleanup ownership changed");
        // Keep a scrubbed idempotency tombstone so delayed create/purge retries cannot recreate or replay the Wiki.
        tx.commit()?;
        Ok(())
    }
}

fn read_scoped(
    connection: &rusqlite::Connection,
    scope: &KnowledgeScope,
    id: &str,
) -> Result<(Library, bool)> {
    connection
        .query_row(
            &format!("SELECT {LIBRARY_COLUMNS},purged_at_ms FROM libraries WHERE principal=?1 AND target=?2 AND id=?3"),
            params![scope.principal, scope.target, id],
            |row| Ok((read_library(row)?, row.get::<_, Option<i64>>(7)?.is_some())),
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("knowledge library not found"))
}
