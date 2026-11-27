//! Cross-process coordination for automated Wiki writers. It never freezes
//! human edits; read revisions and final CAS still protect every changed page.
use crate::{KnowledgeCatalog, KnowledgeScope, WikiJobLease};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};

/// Opaque host lease; a model or client cannot manufacture a release authority.
pub struct WikiAutomaticMergeLease {
    library: String,
    job: String,
    job_token: String,
    token: String,
}

impl KnowledgeCatalog {
    pub fn claim_automatic_merge(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        job: &WikiJobLease,
    ) -> Result<Option<WikiAutomaticMergeLease>> {
        self.read(scope, library)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::jobs::require_lease(&tx, library, job)?;
        crate::pages::require_active(&tx, library)?;
        crate::source_lifecycle::require_current_source(
            &tx,
            library,
            &job.job.source_id,
            &job.job.source_revision,
        )?;
        let existing:Option<(String,String,String)>=tx.query_row("SELECT job_id,job_token,merge_token FROM knowledge_automatic_merge_leases WHERE library_id=?1",[library],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((owner, job_token, token)) = existing {
            let alive:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2 AND lease_token=?3 AND status='running' AND lease_until_ms>=?4)",params![library,owner,job_token,crate::jobs::now_ms()?],|r|r.get(0))?;
            if alive {
                if owner == job.job.id && job_token == job.token {
                    return Ok(Some(WikiAutomaticMergeLease {
                        library: library.into(),
                        job: owner,
                        job_token,
                        token,
                    }));
                }
                return Ok(None);
            }
        }
        let lease = WikiAutomaticMergeLease {
            library: library.into(),
            job: job.job.id.clone(),
            job_token: job.token.clone(),
            token: uuid::Uuid::new_v4().to_string(),
        };
        tx.execute("INSERT INTO knowledge_automatic_merge_leases(library_id,job_id,job_token,merge_token,updated_at_ms) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(library_id) DO UPDATE SET job_id=excluded.job_id,job_token=excluded.job_token,merge_token=excluded.merge_token,updated_at_ms=excluded.updated_at_ms",params![library,lease.job,lease.job_token,lease.token,crate::jobs::now_ms()?])?;
        tx.commit()?;
        Ok(Some(lease))
    }
    pub fn heartbeat_automatic_merge(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiAutomaticMergeLease,
    ) -> Result<()> {
        self.read(scope, library)?;
        ensure!(
            lease.library == library,
            "Wiki automatic merge identity mismatch"
        );
        let changed=self.connection.execute("UPDATE knowledge_automatic_merge_leases SET updated_at_ms=?5 WHERE library_id=?1 AND job_id=?2 AND job_token=?3 AND merge_token=?4 AND EXISTS(SELECT 1 FROM knowledge_jobs j WHERE j.library_id=?1 AND j.job_id=?2 AND j.lease_token=?3 AND j.status='running' AND j.lease_until_ms>=?5)",params![library,lease.job,lease.job_token,lease.token,crate::jobs::now_ms()?])?;
        ensure!(changed == 1, "Wiki automatic merge lease lost");
        Ok(())
    }
    /// Cleanup remains valid after pause/failure, but cannot release a successor.
    pub fn release_automatic_merge(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiAutomaticMergeLease,
    ) -> Result<()> {
        self.read(scope, library)?;
        ensure!(
            lease.library == library,
            "Wiki automatic merge identity mismatch"
        );
        self.connection.execute("DELETE FROM knowledge_automatic_merge_leases WHERE library_id=?1 AND job_id=?2 AND job_token=?3 AND merge_token=?4",params![library,lease.job,lease.job_token,lease.token])?;
        Ok(())
    }
}
