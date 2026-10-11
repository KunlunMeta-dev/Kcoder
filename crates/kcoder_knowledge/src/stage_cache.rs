//! Private recovery inputs, scoped to a durable job and its exact request recipe.
use crate::{KnowledgeCatalog, KnowledgeScope, WikiAnalysis, WikiJobLease};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};

impl KnowledgeCatalog {
    /// A complete JSON response is recoverable before the later structural or
    /// evidence repair completes. It is never returned as a validated proposal.
    pub fn cached_json_response(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        key: &str,
    ) -> Result<Option<String>> {
        self.read_job(scope, library, &lease.job.id)?;
        crate::jobs::require_lease(&self.connection, library, lease)?;
        crate::pages::require_active(&self.connection, library)?;
        crate::source_lifecycle::require_current_source(
            &self.connection,
            library,
            &lease.job.source_id,
            &lease.job.source_revision,
        )?;
        let key = response_key(key)?;
        let row: Option<(String, String)> = self.connection.query_row(
            "SELECT body_hash,body_json FROM knowledge_stage_cache WHERE library_id=?1 AND job_id=?2 AND request_hash=?3 AND body_json IS NOT NULL",
            params![library, lease.job.id, key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        row.map(|(hash, raw)| {
            ensure!(
                raw.len() <= crate::WIKI_MAX_OUTPUT_BYTES
                    && crate::objects::digest(raw.as_bytes()) == hash,
                "Wiki JSON response cache integrity failure"
            );
            super::ingest::complete_json_response(&raw)?;
            Ok(raw)
        })
        .transpose()
    }

    pub fn remember_json_response(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        key: &str,
        raw: &str,
    ) -> Result<()> {
        self.read_job(scope, library, &lease.job.id)?;
        let key = response_key(key)?;
        ensure!(
            raw.len() <= crate::WIKI_MAX_OUTPUT_BYTES,
            "Wiki JSON response exceeds limit"
        );
        // Defense in depth: a partial response is not a restartable JSON stage.
        super::ingest::complete_json_response(raw)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::jobs::require_lease(&tx, library, lease)?;
        crate::pages::require_active(&tx, library)?;
        crate::source_lifecycle::require_current_source(
            &tx,
            library,
            &lease.job.source_id,
            &lease.job.source_revision,
        )?;
        let hash = crate::objects::digest(raw.as_bytes());
        tx.execute(
            "INSERT INTO knowledge_stage_cache(library_id,job_id,request_hash,body_hash,body_json) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(library_id,job_id,request_hash) DO UPDATE SET body_hash=excluded.body_hash,body_json=excluded.body_json",
            params![library, lease.job.id, key, hash, raw],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn forget_json_response(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        key: &str,
    ) -> Result<()> {
        self.read_job(scope, library, &lease.job.id)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::jobs::require_lease(&tx, library, lease)?;
        tx.execute(
            "DELETE FROM knowledge_stage_cache WHERE library_id=?1 AND job_id=?2 AND request_hash=?3",
            params![library, lease.job.id, response_key(key)?],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn cached_analysis(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        key: &str,
    ) -> Result<Option<String>> {
        self.read_job(scope, library, &lease.job.id)?;
        crate::jobs::require_lease(&self.connection, library, lease)?;
        crate::pages::require_active(&self.connection, library)?;
        crate::source_lifecycle::require_current_source(
            &self.connection,
            library,
            &lease.job.source_id,
            &lease.job.source_revision,
        )?;
        let row: Option<(String,Option<String>)> = self.connection.query_row("SELECT body_hash,body_json FROM knowledge_stage_cache WHERE library_id=?1 AND job_id=?2 AND request_hash=?3",params![library,lease.job.id,key],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        row.map(|(hash, body)| match body {
            Some(body) => {
                ensure!(
                    crate::objects::digest(body.as_bytes()) == hash,
                    "Wiki analysis cache integrity failure"
                );
                Ok(body)
            }
            None => self.objects.read(library, &hash),
        })
        .transpose()
        .and_then(|body: Option<String>| {
            if let Some(raw) = &body {
                let analysis: WikiAnalysis = serde_json::from_str(raw)?;
                if let Some(plan) = &analysis.organization_plan {
                    crate::ingest::ingest_organization::validate_cached_plan(
                        self, scope, library, lease, plan,
                    )?;
                }
            }
            Ok(body)
        })
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
        if let Some(plan) = &analysis.organization_plan {
            crate::ingest::ingest_organization::validate_cached_plan(
                self, scope, library, lease, plan,
            )?;
        }
        let body = serde_json::to_string(analysis)?;
        ensure!(body.len() <= 64 * 1024, "analysis cache exceeds limit");
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::jobs::require_lease(&tx, library, lease)?;
        let hash = crate::objects::digest(body.as_bytes());
        tx.execute("INSERT INTO knowledge_stage_cache(library_id,job_id,request_hash,body_hash,body_json) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(library_id,job_id,request_hash) DO NOTHING",params![library,lease.job.id,key,hash,body])?;
        tx.commit()?;
        Ok(())
    }
}

fn response_key(key: &str) -> Result<String> {
    ensure!(
        key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "invalid cache recipe"
    );
    // Keep complete wire responses separate from validated analysis/proposals.
    Ok(crate::objects::digest(
        format!("wiki-json-response-v1:{key}").as_bytes(),
    ))
}

impl KnowledgeCatalog {
    /// Restored candidates remain private and require all citation/CAS checks.
    pub fn cached_proposal(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        key: &str,
    ) -> Result<Option<crate::WikiProposal>> {
        self.read_job(scope, library, &lease.job.id)?;
        crate::jobs::require_lease(&self.connection, library, lease)?;
        crate::pages::require_active(&self.connection, library)?;
        crate::source_lifecycle::require_current_source(
            &self.connection,
            library,
            &lease.job.source_id,
            &lease.job.source_revision,
        )?;
        let row: Option<(String,String)> = self.connection.query_row("SELECT body_hash,body_json FROM knowledge_stage_cache WHERE library_id=?1 AND job_id=?2 AND request_hash=?3 AND body_json IS NOT NULL",params![library,lease.job.id,key],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        row.map(|(hash, body)| {
            ensure!(
                crate::objects::digest(body.as_bytes()) == hash,
                "Wiki staged candidate integrity failure"
            );
            let proposal: crate::WikiProposal = serde_json::from_str(&body)?;
            crate::ingest::ingest_organization::validate_cached_proposal(
                self, scope, library, lease, &proposal,
            )?;
            Ok(proposal)
        })
        .transpose()
    }
    pub fn remember_proposal(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        key: &str,
        proposal: &crate::WikiProposal,
    ) -> Result<()> {
        self.read_job(scope, library, &lease.job.id)?;
        ensure!(
            key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "invalid cache recipe"
        );
        ensure!(
            !proposal.pages.is_empty()
                && proposal.pages.len() <= 8
                && proposal
                    .pages
                    .iter()
                    .all(|page| page.markdown.len() <= crate::WIKI_MAX_PAGE_BYTES),
            "invalid cached proposal bounds"
        );
        crate::ingest::ingest_organization::validate_cached_proposal(
            self, scope, library, lease, proposal,
        )?;
        let body = serde_json::to_string(proposal)?;
        ensure!(
            body.len() <= crate::ingest::WIKI_MAX_PROPOSAL_BYTES,
            "proposal cache exceeds limit"
        );
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::jobs::require_lease(&tx, library, lease)?;
        crate::pages::require_active(&tx, library)?;
        crate::source_lifecycle::require_current_source(
            &tx,
            library,
            &lease.job.source_id,
            &lease.job.source_revision,
        )?;
        let hash = crate::objects::digest(body.as_bytes());
        tx.execute("INSERT INTO knowledge_stage_cache(library_id,job_id,request_hash,body_hash,body_json) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(library_id,job_id,request_hash) DO NOTHING",params![library,lease.job.id,key,hash,body])?;
        tx.commit()?;
        Ok(())
    }
    /// Release private candidate bodies after terminal receipts. SQLite reuses
    /// freed pages; original objects and immutable page/source history are untouched.
    pub fn clear_terminal_stage_cache(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
    ) -> Result<usize> {
        self.read(scope, library)?;
        Ok(self.connection.execute("DELETE FROM knowledge_stage_cache WHERE library_id=?1 AND job_id IN (SELECT job_id FROM knowledge_jobs WHERE library_id=?1 AND status IN ('completed','cancelled'))",[library])?)
    }
}
