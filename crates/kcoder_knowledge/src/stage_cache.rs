//! Cache only validated analysis, scoped to a durable job and its exact request recipe.
use crate::{KnowledgeCatalog, KnowledgeScope, WikiAnalysis, WikiJobLease};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};

impl KnowledgeCatalog {
    pub fn cached_analysis(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        key: &str,
    ) -> Result<Option<String>> {
        self.read_job(scope, library, &lease.job.id)?;
        crate::jobs::require_lease(&self.connection, library, lease)?;
        let hash: Option<String> = self.connection.query_row("SELECT body_hash FROM knowledge_stage_cache WHERE library_id=?1 AND job_id=?2 AND request_hash=?3",params![library,lease.job.id,key],|row|row.get(0)).optional()?;
        hash.map(|hash| self.objects.read(library, &hash))
            .transpose()
    }
    pub fn remember_analysis(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        key: &str,
        analysis: &WikiAnalysis,
    ) -> Result<()> {
        self.read_job(scope, library, &lease.job.id)?;
        ensure!(
            key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "invalid cache recipe"
        );
        let body = serde_json::to_string(analysis)?;
        ensure!(body.len() <= 64 * 1024, "analysis cache exceeds limit");
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::jobs::require_lease(&tx, library, lease)?;
        let hash = self.objects.put(library, &body)?;
        tx.execute("INSERT INTO knowledge_stage_cache(library_id,job_id,request_hash,body_hash) VALUES(?1,?2,?3,?4) ON CONFLICT(library_id,job_id,request_hash) DO NOTHING",params![library,lease.job.id,key,hash])?;
        tx.commit()?;
        Ok(())
    }
}
