//! Durable task leases and prepared-output checkpoints. Reclaimed workers must
//! replay the saved proposal with its stable commit key, never regenerate it.
use crate::{KnowledgeCatalog, KnowledgeScope, WikiProposal};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiJob {
    pub id: String,
    pub source_id: String,
    pub source_revision: String,
    pub recipe_key: String,
    pub language: String,
    pub status: String,
    pub after_chunk: usize,
    pub error_code: Option<String>,
    pub error_detail: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiCheckpoint {
    pub through_chunk: usize,
    pub has_more_chunks: bool,
    pub proposal: WikiProposal,
}
pub struct WikiJobLease {
    pub job: WikiJob,
    pub(crate) token: String,
}

impl KnowledgeCatalog {
    #[allow(clippy::too_many_arguments)]
    pub fn enqueue_ingest(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        key: &str,
        source: &str,
        revision: &str,
        recipe: &str,
        language: &str,
    ) -> Result<WikiJob> {
        ensure!(
            !self.read(scope, library)?.archived,
            "knowledge library is archived"
        );
        ensure!(
            !key.is_empty() && key.len() <= 128 && !recipe.is_empty() && recipe.len() <= 256,
            "invalid job identity"
        );
        ensure!(
            !language.trim().is_empty() && language.len() <= 80,
            "invalid output language"
        );
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::pages::require_active(&tx, library)?;
        crate::source_lifecycle::require_current_source(&tx, library, source, revision)?;
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_sources WHERE library_id=?1 AND source_id=?2 AND revision_id=?3)",params![library,source,revision],|r|r.get(0))?;
        ensure!(exists, "source revision not found");
        let old=tx.query_row("SELECT job_id,source_id,source_revision,recipe_key,language,status,after_chunk,error_code,error_detail FROM knowledge_jobs WHERE library_id=?1 AND request_key=?2",params![library,key],read_job).optional()?;
        if let Some(old) = old {
            ensure!(
                old.source_id == source
                    && old.source_revision == revision
                    && old.recipe_key == recipe
                    && old.language == language,
                "idempotency conflict"
            );
            return Ok(old);
        }
        let pending: i64 = tx.query_row("SELECT count(*) FROM knowledge_jobs WHERE status IN ('queued','running') AND library_id IN (SELECT id FROM libraries WHERE principal=?1 AND target=?2)",params![scope.principal,scope.target],|row|row.get(0))?;
        ensure!(pending < 64, "knowledge task queue is full");
        let job = WikiJob {
            id: uuid::Uuid::new_v4().to_string(),
            source_id: source.into(),
            source_revision: revision.into(),
            recipe_key: recipe.into(),
            language: language.into(),
            status: "queued".into(),
            after_chunk: 0,
            error_code: None,
            error_detail: None,
        };
        tx.execute("INSERT INTO knowledge_jobs(library_id,job_id,request_key,source_id,source_revision,recipe_key,language,status) VALUES(?1,?2,?3,?4,?5,?6,?7,'queued')",params![library,job.id,key,source,revision,recipe,language])?;
        tx.commit()?;
        Ok(job)
    }
    pub fn read_job(&self, scope: &KnowledgeScope, library: &str, id: &str) -> Result<WikiJob> {
        self.read(scope, library)?;
        self.connection.query_row("SELECT job_id,source_id,source_revision,recipe_key,language,status,after_chunk,error_code,error_detail FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2",params![library,id],read_job).optional()?.ok_or_else(||anyhow::anyhow!("Wiki job not found"))
    }
    pub fn claim_job(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        id: &str,
    ) -> Result<Option<WikiJobLease>> {
        self.read(scope, library)?;
        let now = now_ms()?;
        let token = uuid::Uuid::new_v4().to_string();
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::pages::require_active(&tx, library)?;
        let changed=tx.execute("UPDATE knowledge_jobs SET status='running',lease_token=?3,lease_until_ms=?4,error_code=NULL,error_detail=NULL WHERE library_id=?1 AND job_id=?2 AND (status='queued' OR (status='running' AND lease_until_ms<?5))",params![library,id,token,now+30_000,now])?;
        if changed == 0 {
            return Ok(None);
        }
        let job=tx.query_row("SELECT job_id,source_id,source_revision,recipe_key,language,status,after_chunk,error_code,error_detail FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2",params![library,id],read_job)?;
        crate::source_lifecycle::require_current_source(
            &tx,
            library,
            &job.source_id,
            &job.source_revision,
        )?;
        tx.commit()?;
        Ok(Some(WikiJobLease { job, token }))
    }
    pub fn heartbeat_job(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
    ) -> Result<()> {
        self.read(scope, library)?;
        let changed=self.connection.execute("UPDATE knowledge_jobs SET lease_until_ms=?4 WHERE library_id=?1 AND job_id=?2 AND lease_token=?3 AND status='running' AND lease_until_ms>=?5",params![library,lease.job.id,lease.token,now_ms()?+30_000,now_ms()?])?;
        ensure!(changed == 1, "Wiki job lease lost");
        Ok(())
    }
    pub fn save_job_checkpoint(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        checkpoint: &WikiCheckpoint,
    ) -> Result<()> {
        self.read(scope, library)?;
        ensure!(
            checkpoint.through_chunk > lease.job.after_chunk,
            "checkpoint must advance source position"
        );
        let json = serde_json::to_string(checkpoint)?;
        ensure!(
            json.len() <= crate::ingest::WIKI_MAX_PROPOSAL_BYTES,
            "checkpoint too large"
        );
        let changed=self.connection.execute("UPDATE knowledge_jobs SET checkpoint_json=?4 WHERE library_id=?1 AND job_id=?2 AND lease_token=?3 AND status='running' AND lease_until_ms>=?5 AND checkpoint_json IS NULL",params![library,lease.job.id,lease.token,json,now_ms()?])?;
        ensure!(
            changed == 1,
            "Wiki job lease lost or checkpoint already saved"
        );
        Ok(())
    }
    pub fn job_checkpoint(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        id: &str,
    ) -> Result<Option<WikiCheckpoint>> {
        self.read_job(scope, library, id)?;
        let raw: Option<String> = self.connection.query_row(
            "SELECT checkpoint_json FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2",
            params![library, id],
            |r| r.get(0),
        )?;
        raw.map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }
    /// Called only after the checkpoint's idempotent Wiki commit succeeds.
    pub fn finish_job_batch(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
    ) -> Result<()> {
        self.read(scope, library)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::pages::require_active(&tx, library)?;
        let raw:String=tx.query_row("SELECT checkpoint_json FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2 AND lease_token=?3 AND status='running' AND lease_until_ms>=?4",params![library,lease.job.id,lease.token,now_ms()?],|r|r.get(0))?;
        let checkpoint: WikiCheckpoint = serde_json::from_str(&raw)?;
        let commit_key = format!("wiki-job:{}:{}", lease.job.id, checkpoint.through_chunk);
        let committed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM knowledge_commits WHERE library_id=?1 AND request_key=?2)",
            params![library, commit_key],
            |r| r.get(0),
        )?;
        ensure!(committed, "Wiki batch has no committed pages");
        let committed_hash: String = tx.query_row(
            "SELECT payload_hash FROM knowledge_commits WHERE library_id=?1 AND request_key=?2",
            params![library, commit_key],
            |r| r.get(0),
        )?;
        ensure!(
            committed_hash
                == crate::objects::digest(&serde_json::to_vec(&checkpoint.proposal.pages)?),
            "Wiki commit does not match prepared checkpoint"
        );
        tx.execute("UPDATE knowledge_jobs SET status=?4,after_chunk=?5,checkpoint_json=NULL,lease_token=NULL,lease_until_ms=0 WHERE library_id=?1 AND job_id=?2 AND lease_token=?3",params![library,lease.job.id,lease.token,if checkpoint.has_more_chunks {"queued"} else {"completed"},checkpoint.through_chunk as i64])?;
        tx.commit()?;
        Ok(())
    }
    pub fn commit_job_checkpoint(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
    ) -> Result<Vec<crate::PageRevisionRef>> {
        let checkpoint = self
            .job_checkpoint(scope, library, &lease.job.id)?
            .ok_or_else(|| anyhow::anyhow!("Wiki checkpoint missing"))?;
        let key = format!("wiki-job:{}:{}", lease.job.id, checkpoint.through_chunk);
        self.commit_pages(scope, library, &key, checkpoint.proposal.pages, Some(lease))
    }

    pub fn pause_job(&mut self, scope: &KnowledgeScope, library: &str, id: &str) -> Result<()> {
        self.read_job(scope, library, id)?;
        self.connection.execute("UPDATE knowledge_jobs SET status='paused',lease_token=NULL,lease_until_ms=0 WHERE library_id=?1 AND job_id=?2 AND status IN ('queued','running')",params![library,id])?;
        Ok(())
    }
    pub fn resume_job(&mut self, scope: &KnowledgeScope, library: &str, id: &str) -> Result<()> {
        let job = self.read_job(scope, library, id)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::pages::require_active(&tx, library)?;
        crate::source_lifecycle::require_current_source(
            &tx,
            library,
            &job.source_id,
            &job.source_revision,
        )?;
        let (status, error_code, checkpoint): (String, Option<String>, Option<String>) = tx.query_row(
            "SELECT status,error_code,checkpoint_json FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2",
            params![library,id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        )?;
        let refresh = if matches!(status.as_str(), "paused" | "failed") {
            checkpoint_requires_refresh(
                &tx,
                library,
                id,
                checkpoint.as_deref(),
                error_code.as_deref(),
            )?
        } else {
            false
        };
        tx.execute("UPDATE knowledge_jobs SET status='queued',checkpoint_json=CASE WHEN ?3 THEN NULL ELSE checkpoint_json END,error_code=NULL,error_detail=NULL WHERE library_id=?1 AND job_id=?2 AND status IN ('paused','failed')",params![library,id,refresh])?;
        tx.commit()?;
        Ok(())
    }
}
// A normal pause can outlive concurrent human edits without first producing a
// commit error. Refresh stale, uncommitted proposals on the first resume. A
// committed checkpoint must survive: it may be waiting only for finish_job_batch
// after a process crash and replaying its receipt must never regenerate content.
fn checkpoint_requires_refresh(
    db: &rusqlite::Connection,
    library: &str,
    job: &str,
    raw: Option<&str>,
    error_code: Option<&str>,
) -> Result<bool> {
    let Some(raw) = raw else {
        return Ok(false);
    };
    let checkpoint: WikiCheckpoint = serde_json::from_str(raw)?;
    let key = format!("wiki-job:{job}:{}", checkpoint.through_chunk);
    let committed: Option<String> = db
        .query_row(
            "SELECT payload_hash FROM knowledge_commits WHERE library_id=?1 AND request_key=?2",
            params![library, key],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(hash) = committed {
        ensure!(
            hash == crate::objects::digest(&serde_json::to_vec(&checkpoint.proposal.pages)?),
            "Wiki commit does not match prepared checkpoint"
        );
        return Ok(false);
    }
    if matches!(error_code, Some("revision_conflict" | "invalid_evidence")) {
        return Ok(true);
    }
    let proposed: std::collections::BTreeSet<_> = checkpoint
        .proposal
        .pages
        .iter()
        .map(|page| page.page_id.as_str())
        .collect();
    for page in &checkpoint.proposal.pages {
        let current: Option<String> = db
            .query_row(
                "SELECT current_revision FROM knowledge_pages WHERE library_id=?1 AND page_id=?2",
                params![library, page.page_id],
                |row| row.get(0),
            )
            .optional()?;
        if current.as_deref() != page.expected_revision.as_deref() {
            return Ok(true);
        }
        for target in &page.related_page_ids {
            if !proposed.contains(target.as_str()) {
                let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_pages WHERE library_id=?1 AND page_id=?2)",params![library,target],|row|row.get(0))?;
                if !exists {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

pub(crate) fn read_job(r: &rusqlite::Row<'_>) -> rusqlite::Result<WikiJob> {
    Ok(WikiJob {
        id: r.get(0)?,
        source_id: r.get(1)?,
        source_revision: r.get(2)?,
        recipe_key: r.get(3)?,
        language: r.get(4)?,
        status: r.get(5)?,
        after_chunk: r.get::<_, i64>(6)? as usize,
        error_code: r.get(7)?,
        error_detail: r.get(8)?,
    })
}
fn now_ms() -> Result<i64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .try_into()?)
}

pub(crate) fn require_lease(
    db: &rusqlite::Connection,
    library: &str,
    lease: &WikiJobLease,
) -> Result<()> {
    let valid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2 AND lease_token=?3 AND status='running' AND lease_until_ms>=?4)",params![library,lease.job.id,lease.token,now_ms()?],|r|r.get(0))?;
    ensure!(valid, "Wiki job lease lost");
    Ok(())
}

impl KnowledgeCatalog {
    pub fn stop_job_with_reason(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        status: &str,
        code: &str,
    ) -> Result<()> {
        self.read(scope, library)?;
        ensure!(
            matches!(status, "paused" | "failed" | "awaiting_review"),
            "invalid job stop status"
        );
        ensure!(
            matches!(
                code,
                "disabled"
                    | "cancelled"
                    | "ingest_failed"
                    | "review_required"
                    | "configuration_changed"
                    | "invalid_model_output"
                    | "model_output_truncated"
                    | "context_budget_exceeded"
                    | "provider_error"
                    | "revision_conflict"
                    | "invalid_evidence"
            ),
            "invalid job error code"
        );
        self.connection.execute("UPDATE knowledge_jobs SET status=?4,error_code=?5,lease_token=NULL,lease_until_ms=0 WHERE library_id=?1 AND job_id=?2 AND lease_token=?3 AND status='running'",params![library,lease.job.id,lease.token,status,code])?;
        Ok(())
    }
}

impl KnowledgeCatalog {
    pub fn list_jobs(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<WikiJob>> {
        self.read(scope, library)?;
        ensure!((1..=100).contains(&limit), "job limit must be 1..100");
        let mut query=self.connection.prepare("SELECT job_id,source_id,source_revision,recipe_key,language,status,after_chunk,error_code,error_detail FROM knowledge_jobs WHERE library_id=?1 AND job_id>?2 ORDER BY job_id LIMIT ?3")?;
        Ok(query
            .query_map(
                params![library, after.unwrap_or(""), limit as i64],
                read_job,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

impl KnowledgeCatalog {
    pub fn pause_all_jobs(&mut self, scope: &KnowledgeScope) -> Result<usize> {
        Ok(self.connection.execute("UPDATE knowledge_jobs SET status='paused',lease_token=NULL,lease_until_ms=0 WHERE status IN ('queued','running') AND library_id IN (SELECT id FROM libraries WHERE principal=?1 AND target=?2)",params![scope.principal,scope.target])?)
    }
}

impl KnowledgeCatalog {
    pub fn record_job_provider_error(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        summary: &kcoder_types::ProviderErrorSummary,
    ) -> Result<()> {
        self.read(scope, library)?;
        self.connection.execute("UPDATE knowledge_jobs SET error_detail=?4 WHERE library_id=?1 AND job_id=?2 AND lease_token=?3 AND status='running'",params![library,lease.job.id,lease.token,summary.as_str()])?;
        Ok(())
    }
}

impl KnowledgeCatalog {
    /// UI overview prioritizes all active work before old terminal records.
    pub fn job_overview(&self, scope: &KnowledgeScope, library: &str) -> Result<Vec<WikiJob>> {
        self.read(scope, library)?;
        let mut query = self.connection.prepare("SELECT job_id,source_id,source_revision,recipe_key,language,status,after_chunk,error_code,error_detail FROM knowledge_jobs WHERE library_id=?1 ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'awaiting_review' THEN 2 WHEN 'failed' THEN 3 WHEN 'paused' THEN 4 ELSE 5 END, rowid DESC LIMIT 100")?;
        Ok(query
            .query_map([library], read_job)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

impl KnowledgeCatalog {
    pub fn record_job_truncation_details(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        error: &crate::WikiOutputTruncated,
    ) -> Result<()> {
        self.record_job_truncation(
            scope,
            library,
            lease,
            error.stage,
            error.text_bytes,
            error.reasoning_bytes,
        )?;
        let detail = serde_json::json!({"stage":error.stage,"textBytes":error.text_bytes,
            "reasoningBytes":error.reasoning_bytes,"requestedTokens":error.requested_tokens,
            "reportedOutputTokens":error.reported_output_tokens,"stopReason":error.stop_reason})
        .to_string();
        self.connection.execute("UPDATE knowledge_jobs SET error_detail=?4 WHERE library_id=?1 AND job_id=?2 AND lease_token=?3 AND status='running'",params![library,lease.job.id,lease.token,detail])?;
        Ok(())
    }
    pub fn record_job_truncation(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        stage: &str,
        text_bytes: usize,
        reasoning_bytes: usize,
    ) -> Result<()> {
        self.read(scope, library)?;
        ensure!(
            matches!(stage, "analysis" | "generation" | "citation_repair"),
            "invalid Wiki stage"
        );
        let detail = serde_json::json!({"stage":stage,"textBytes":text_bytes,"reasoningBytes":reasoning_bytes}).to_string();
        self.connection.execute("UPDATE knowledge_jobs SET error_detail=?4 WHERE library_id=?1 AND job_id=?2 AND lease_token=?3 AND status='running'",params![library,lease.job.id,lease.token,detail])?;
        Ok(())
    }
}

impl KnowledgeCatalog {
    pub fn cancel_job(&mut self, scope: &KnowledgeScope, library: &str, id: &str) -> Result<()> {
        self.read_job(scope, library, id)?;
        self.connection.execute("UPDATE knowledge_jobs SET status='cancelled',lease_token=NULL,lease_until_ms=0,error_code='cancelled' WHERE library_id=?1 AND job_id=?2 AND status NOT IN ('completed','cancelled')",params![library,id])?;
        Ok(())
    }
}
