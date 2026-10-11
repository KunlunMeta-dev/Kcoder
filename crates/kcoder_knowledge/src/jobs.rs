//! Durable task leases and prepared-output checkpoints. Reclaimed workers must
//! replay the saved proposal with its stable commit key, never regenerate it.
use crate::{KnowledgeCatalog, KnowledgeScope, WikiProposal};
use anyhow::{Result, ensure};
use kcoder_types::domain_status::{WikiJobPhase, WikiJobStatus};
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_available: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<WikiJobProgress>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<kcoder_types::wiki_pipeline::WikiPipelineProgress>,
}
pub use kcoder_types::wiki_job_progress::WikiJobProgress;

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
        let old=tx.query_row("SELECT job_id,source_id,source_revision,recipe_key,language,status,after_chunk,error_code,error_detail,progress_json FROM knowledge_jobs WHERE library_id=?1 AND request_key=?2",params![library,key],read_job).optional()?;
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
        let pending: i64 = tx.query_row("SELECT count(*) FROM knowledge_jobs WHERE status IN ('queued','running') AND (progress_json IS NULL OR json_extract(progress_json,'$.phase') IN ('analysis','generation','citation_repair','source_support','organization_repair','format_repair','truncation_retry','commit')) AND library_id IN (SELECT id FROM libraries WHERE principal=?1 AND target=?2)",params![scope.principal,scope.target],|row|row.get(0))?;
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
            review_available: None,
            progress: None,
            pipeline: None,
        };
        tx.execute("INSERT INTO knowledge_jobs(library_id,job_id,request_key,source_id,source_revision,recipe_key,language,status,pipeline_version) VALUES(?1,?2,?3,?4,?5,?6,?7,'queued',1)",params![library,job.id,key,source,revision,recipe,language])?;
        tx.commit()?;
        Ok(job)
    }
    pub fn read_job(&self, scope: &KnowledgeScope, library: &str, id: &str) -> Result<WikiJob> {
        self.read(scope, library)?;
        let mut job = self.connection.query_row("SELECT job_id,source_id,source_revision,recipe_key,language,status,after_chunk,error_code,error_detail,progress_json FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2",params![library,id],read_job).optional()?.ok_or_else(||anyhow::anyhow!("Wiki job not found"))?;
        job.pipeline = self.pipeline_progress(scope, library, id)?;
        self.hydrate_review_availability(library, &mut job)?;
        Ok(job)
    }
    fn hydrate_review_availability(&self, library: &str, job: &mut WikiJob) -> Result<()> {
        job.review_available = if job.status == "awaiting_review" {
            Some(self.connection.query_row(
                "SELECT checkpoint_json IS NOT NULL FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2",
                params![library,job.id], |row| row.get(0),
            )?)
        } else {
            None
        };
        Ok(())
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
        require_known_job(&tx, library, id)?;
        let changed=tx.execute("UPDATE knowledge_jobs SET status='running',lease_token=?3,lease_until_ms=?4,error_code=NULL,error_detail=NULL WHERE library_id=?1 AND job_id=?2 AND (status='queued' OR (status='running' AND lease_until_ms<?5))",params![library,id,token,now+30_000,now])?;
        if changed == 0 {
            return Ok(None);
        }
        let job=tx.query_row("SELECT job_id,source_id,source_revision,recipe_key,language,status,after_chunk,error_code,error_detail,progress_json FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2",params![library,id],read_job)?;
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
        require_known_job(&self.connection, library, &lease.job.id)?;
        let changed=self.connection.execute("UPDATE knowledge_jobs SET lease_until_ms=?4,progress_json=CASE WHEN progress_json IS NULL THEN NULL ELSE json_set(progress_json,'$.heartbeatAtMs',?5) END WHERE library_id=?1 AND job_id=?2 AND lease_token=?3 AND status='running' AND lease_until_ms>=?5",params![library,lease.job.id,lease.token,now_ms()?+30_000,now_ms()?])?;
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
        require_known_job(&self.connection, library, &lease.job.id)?;
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
        require_known_job(&self.connection, library, &lease.job.id)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::pages::require_active(&tx, library)?;
        let raw:Option<String>=tx.query_row("SELECT checkpoint_json FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2 AND lease_token=?3 AND status='running' AND lease_until_ms>=?4",params![library,lease.job.id,lease.token,now_ms()?],|r|r.get(0))?;
        let raw = raw.ok_or_else(|| anyhow::anyhow!("Wiki checkpoint missing"))?;
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
        // Receipt proves this batch is durable; no completed preparation stage
        // can be needed by a later batch. Paused/review/failed caches stay intact.
        tx.execute(
            "DELETE FROM knowledge_stage_cache WHERE library_id=?1 AND job_id=?2",
            params![library, lease.job.id],
        )?;
        tx.execute("UPDATE knowledge_pipeline_stages SET raw_response=NULL,raw_hash=NULL,output_json=NULL,output_hash=NULL WHERE library_id=?1 AND job_id=?2 AND batch=?3",params![library,lease.job.id,lease.job.after_chunk as i64])?;
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
        if !checkpoint.proposal.review_notes.is_empty() {
            return Err(crate::ReviewRequired.into());
        }
        let key = format!("wiki-job:{}:{}", lease.job.id, checkpoint.through_chunk);
        if checkpoint.proposal.pages.is_empty() {
            // Only an immutable, genuinely blank source window may commit no
            // pages. Model-generated empty output must still be rejected.
            let chunks = self.source_chunks(
                scope,
                library,
                &lease.job.source_id,
                &lease.job.source_revision,
                lease.job.after_chunk,
                8,
            )?;
            let chunks: Vec<_> = chunks
                .into_iter()
                .filter(|chunk| chunk.ordinal <= checkpoint.through_chunk)
                .collect();
            ensure!(
                chunks
                    .last()
                    .is_some_and(|chunk| chunk.ordinal == checkpoint.through_chunk)
                    && chunks.iter().all(|chunk| chunk.text.trim().is_empty()),
                "empty Wiki checkpoint requires a blank source window"
            );
            let has_more = !self
                .source_chunks(
                    scope,
                    library,
                    &lease.job.source_id,
                    &lease.job.source_revision,
                    checkpoint.through_chunk,
                    1,
                )?
                .is_empty();
            ensure!(
                checkpoint.has_more_chunks == has_more,
                "empty Wiki checkpoint must preserve remaining source work"
            );
            let tx = self
                .connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            crate::pages::require_active(&tx, library)?;
            require_lease(&tx, library, lease)?;
            crate::source_lifecycle::require_current_source(
                &tx,
                library,
                &lease.job.source_id,
                &lease.job.source_revision,
            )?;
            let hash = crate::objects::digest(b"[]");
            let prior: Option<String> = tx.query_row("SELECT payload_hash FROM knowledge_commits WHERE library_id=?1 AND request_key=?2",params![library,key],|row|row.get(0)).optional()?;
            if let Some(prior) = prior {
                ensure!(prior == hash, "idempotency conflict");
            } else {
                tx.execute("INSERT INTO knowledge_commits(library_id,request_key,payload_hash,result_json) VALUES(?1,?2,?3,'[]')",params![library,key,hash])?;
            }
            tx.commit()?;
            return Ok(vec![]);
        }
        self.commit_pages(scope, library, &key, checkpoint.proposal.pages, Some(lease))
    }

    pub fn pause_job(&mut self, scope: &KnowledgeScope, library: &str, id: &str) -> Result<()> {
        self.read_job(scope, library, id)?;
        require_known_job(&self.connection, library, id)?;
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
        require_known_job(&tx, library, id)?;
        let status = WikiJobStatus::from_raw(&status).map_err(anyhow::Error::msg)?;
        let refresh = if matches!(status, WikiJobStatus::Paused | WikiJobStatus::Failed) {
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
        // Older workers could stop an early planning stage as awaiting_review
        // without a complete candidate. Only that NULL case may resume; actual
        // proposals remain bound to the explicit review decision and its CAS.
        tx.execute("UPDATE knowledge_jobs SET status='queued',checkpoint_json=CASE WHEN ?3 THEN NULL ELSE checkpoint_json END,error_code=NULL,error_detail=NULL WHERE library_id=?1 AND job_id=?2 AND (status IN ('paused','failed') OR (status='awaiting_review' AND checkpoint_json IS NULL))",params![library,id,refresh])?;
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
        progress: r
            .get::<_, Option<String>>(9)?
            .map(|raw| {
                serde_json::from_str(&raw).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        9,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })
            .transpose()?,
        pipeline: None,
        review_available: None,
    })
}
// Parse the persisted fact, rather than a potentially stale worker copy. Unknown
// lifecycle evidence grants history access only; no operator can overwrite it.
pub(crate) fn require_known_job(db: &rusqlite::Connection, library: &str, id: &str) -> Result<()> {
    let job = db.query_row("SELECT job_id,source_id,source_revision,recipe_key,language,status,after_chunk,error_code,error_detail,progress_json FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2", params![library,id], read_job)?;
    ensure!(
        WikiJobStatus::from_raw(&job.status)
            .map_err(anyhow::Error::msg)?
            .is_known(),
        "Wiki job status is temporarily unrecognized; history is read-only"
    );
    if let Some(progress) = job.progress {
        ensure!(
            WikiJobPhase::from_raw(&progress.phase)
                .map_err(anyhow::Error::msg)?
                .is_known(),
            "Wiki job phase is temporarily unrecognized; history is read-only"
        );
    }
    Ok(())
}
pub(crate) fn now_ms() -> Result<i64> {
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
    require_known_job(db, library, &lease.job.id)?;
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
        require_known_job(&self.connection, library, &lease.job.id)?;
        ensure!(
            matches!(
                WikiJobStatus::from_raw(status).map_err(anyhow::Error::msg)?,
                WikiJobStatus::Paused | WikiJobStatus::Failed | WikiJobStatus::AwaitingReview
            ),
            "invalid job stop status"
        );
        ensure!(
            matches!(
                code,
                "disabled"
                    | "cancelled"
                    | "ingest_failed"
                    | "review_required"
                    | "review_required_without_candidate"
                    | "configuration_changed"
                    | "repair_budget_exceeded"
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
        let mut query=self.connection.prepare("SELECT job_id,source_id,source_revision,recipe_key,language,status,after_chunk,error_code,error_detail,progress_json FROM knowledge_jobs WHERE library_id=?1 AND job_id>?2 ORDER BY job_id LIMIT ?3")?;
        let mut jobs = query
            .query_map(
                params![library, after.unwrap_or(""), limit as i64],
                read_job,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for job in &mut jobs {
            job.pipeline = self.pipeline_progress(scope, library, &job.id)?;
            self.hydrate_review_availability(library, job)?;
        }
        Ok(jobs)
    }
}

impl KnowledgeCatalog {
    pub fn pause_all_jobs(&mut self, scope: &KnowledgeScope) -> Result<usize> {
        Ok(self.connection.execute("UPDATE knowledge_jobs SET status='paused',lease_token=NULL,lease_until_ms=0 WHERE status IN ('queued','running') AND (progress_json IS NULL OR json_extract(progress_json,'$.phase') IN ('analysis','generation','citation_repair','source_support','organization_repair','format_repair','truncation_retry','commit')) AND library_id IN (SELECT id FROM libraries WHERE principal=?1 AND target=?2)",params![scope.principal,scope.target])?)
    }
}

impl KnowledgeCatalog {
    /// Only a domain-authored validation error can carry a field diagnostic.
    /// Arbitrary Provider/SQLite/model text is never copied into public status.
    pub fn candidate_failure_code(error: &anyhow::Error) -> Option<&'static str> {
        error
            .downcast_ref::<crate::ingest::WikiCandidateFailure>()
            .map(|failure| failure.code)
    }

    pub fn record_job_candidate_failure(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        error: &anyhow::Error,
    ) -> Result<()> {
        self.read(scope, library)?;
        require_known_job(&self.connection, library, &lease.job.id)?;
        let Some(failure) = error.downcast_ref::<crate::ingest::WikiCandidateFailure>() else {
            return Ok(());
        };
        let detail = serde_json::json!({"stage":failure.stage, "errorType":failure.code, "field":failure.field}).to_string();
        self.connection.execute("UPDATE knowledge_jobs SET error_detail=?4 WHERE library_id=?1 AND job_id=?2 AND lease_token=?3 AND status='running'",params![library,lease.job.id,lease.token,detail])?;
        Ok(())
    }

    pub fn record_job_provider_error(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        summary: &kcoder_types::ProviderErrorSummary,
    ) -> Result<()> {
        self.read(scope, library)?;
        require_known_job(&self.connection, library, &lease.job.id)?;
        self.connection.execute("UPDATE knowledge_jobs SET error_detail=?4 WHERE library_id=?1 AND job_id=?2 AND lease_token=?3 AND status='running'",params![library,lease.job.id,lease.token,summary.as_str()])?;
        Ok(())
    }
}

/// Public overview keeps historical jobs small while active/failed work still
/// carries its actual persisted pipeline.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiJobOverviewItem {
    #[serde(flatten)]
    pub job: WikiJob,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_title: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiJobOverviewPage {
    pub items: Vec<WikiJobOverviewItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobOverviewCursor {
    version: u8,
    library_id: String,
    priority: u8,
    row_id: i64,
}

const JOB_OVERVIEW_MAX_BYTES: usize = 1024 * 1024;
const JOB_OVERVIEW_PRIORITY: &str = "CASE j.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'awaiting_review' THEN 2 WHEN 'failed' THEN 3 WHEN 'paused' THEN 4 ELSE 5 END";

impl KnowledgeCatalog {
    /// Legacy domain callers retain their first-page interface. New clients
    /// follow the explicit keyset cursor rather than silently losing row 101.
    pub fn job_overview(&self, scope: &KnowledgeScope, library: &str) -> Result<Vec<WikiJob>> {
        Ok(self
            .job_overview_page(scope, library, None, 100)?
            .items
            .into_iter()
            .map(|item| item.job)
            .collect())
    }

    /// Pages contain complete job summaries within a 1 MiB serialized budget.
    /// A single unusually large summary is rejected explicitly; stage records
    /// are never silently omitted to make an item fit.
    pub fn job_overview_page(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<WikiJobOverviewPage> {
        self.read(scope, library)?;
        let cursor = cursor
            .map(|value| -> Result<JobOverviewCursor> {
                ensure!(value.len() <= 1024, "invalid Wiki overview cursor");
                let parsed: JobOverviewCursor = serde_json::from_str(value)
                    .map_err(|_| anyhow::anyhow!("invalid Wiki overview cursor"))?;
                ensure!(
                    parsed.version == 1
                        && parsed.library_id == library
                        && parsed.priority <= 5
                        && parsed.row_id > 0,
                    "invalid Wiki overview cursor"
                );
                Ok(parsed)
            })
            .transpose()?;
        let limit = limit.clamp(1, 100);
        let sql = format!(
            "SELECT j.job_id,j.source_id,j.source_revision,j.recipe_key,j.language,j.status,j.after_chunk,j.error_code,j.error_detail,j.progress_json,{JOB_OVERVIEW_PRIORITY},j.rowid,s.title FROM knowledge_jobs j LEFT JOIN knowledge_sources s ON s.library_id=j.library_id AND s.source_id=j.source_id AND s.revision_id=j.source_revision WHERE j.library_id=?1 AND (?2 IS NULL OR {JOB_OVERVIEW_PRIORITY}>?2 OR ({JOB_OVERVIEW_PRIORITY}=?2 AND j.rowid<?3)) ORDER BY {JOB_OVERVIEW_PRIORITY},j.rowid DESC LIMIT ?4"
        );
        let mut query = self.connection.prepare(&sql)?;
        let rows = query
            .query_map(
                params![
                    library,
                    cursor.as_ref().map(|cursor| cursor.priority),
                    cursor.as_ref().map(|cursor| cursor.row_id),
                    (limit + 1) as i64
                ],
                |row| {
                    Ok((
                        read_job(row)?,
                        row.get::<_, u8>(10)?,
                        row.get::<_, i64>(11)?,
                        row.get::<_, Option<String>>(12)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let available = rows.len();
        let mut result = WikiJobOverviewPage {
            items: Vec::new(),
            next_cursor: None,
        };
        let mut last = None;
        for (mut job, priority, row_id, source_title) in rows.into_iter().take(limit) {
            if !matches!(job.status.as_str(), "completed" | "cancelled") {
                job.pipeline = self.pipeline_progress(scope, library, &job.id)?;
            }
            self.hydrate_review_availability(library, &mut job)?;
            let next = serde_json::to_string(&JobOverviewCursor {
                version: 1,
                library_id: library.into(),
                priority,
                row_id,
            })?;
            result.items.push(WikiJobOverviewItem { job, source_title });
            result.next_cursor = Some(next.clone());
            if serde_json::to_vec(&result)?.len() > JOB_OVERVIEW_MAX_BYTES {
                result.items.pop();
                ensure!(
                    !result.items.is_empty(),
                    "Wiki overview item exceeds response budget"
                );
                break;
            }
            last = Some(next);
        }
        result.next_cursor = if result.items.len() < available {
            last
        } else {
            None
        };
        Ok(result)
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
        require_known_job(&self.connection, library, &lease.job.id)?;
        ensure!(
            matches!(
                stage,
                "analysis"
                    | "generation"
                    | "citation_repair"
                    | "source_support"
                    | "organization_repair"
                    | "format_repair"
                    | "truncation_retry"
            ),
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
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        require_known_job(&tx, library, id)?;
        tx.execute("UPDATE knowledge_jobs SET status='cancelled',lease_token=NULL,lease_until_ms=0,error_code='cancelled' WHERE library_id=?1 AND job_id=?2 AND status IN ('queued','running','paused','failed','awaiting_review')",params![library,id])?;
        tx.execute("DELETE FROM knowledge_stage_cache WHERE library_id=?1 AND job_id=?2 AND EXISTS(SELECT 1 FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2 AND status IN ('completed','cancelled'))",params![library,id])?;
        tx.commit()?;
        Ok(())
    }
}

impl KnowledgeCatalog {
    pub fn update_job_progress(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        progress: &WikiJobProgress,
    ) -> Result<()> {
        self.read(scope, library)?;
        require_known_job(&self.connection, library, &lease.job.id)?;
        ensure!(
            WikiJobPhase::from_raw(&progress.phase)
                .map_err(anyhow::Error::msg)?
                .is_known(),
            "invalid Wiki progress phase"
        );
        ensure!(
            progress.model.len() <= 256
                && progress
                    .reasoning_effort
                    .as_ref()
                    .is_none_or(|value| value.len() <= 80),
            "invalid Wiki model summary"
        );
        let changed = self.connection.execute("UPDATE knowledge_jobs SET progress_json=?4 WHERE library_id=?1 AND job_id=?2 AND lease_token=?3 AND status='running' AND lease_until_ms>=?5", params![library,lease.job.id,lease.token,serde_json::to_string(progress)?,now_ms()?])?;
        ensure!(changed == 1, "Wiki job lease lost");
        Ok(())
    }
    pub fn job_evidence_range(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
    ) -> Result<(usize, Option<u32>, Option<u32>)> {
        self.read(scope, library)?;
        require_lease(&self.connection, library, lease)?;
        Ok(self.connection.query_row("SELECT COUNT(*),MIN(CASE WHEN ordinal>?4 THEN page END),MAX(page) FROM knowledge_chunks WHERE library_id=?1 AND source_id=?2 AND revision_id=?3",params![library,lease.job.source_id,lease.job.source_revision,lease.job.after_chunk as i64],|row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?)
    }
}

#[cfg(test)]
mod overview_tests {
    use super::*;
    fn catalog() -> Result<(
        tempfile::TempDir,
        KnowledgeCatalog,
        KnowledgeScope,
        String,
        crate::SourceRevision,
    )> {
        let root = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&root.path().join("state.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("overview-owner", "target")?;
        let library = store.create(&scope, "create", "Overview", "Goal")?;
        let source = store.import_text(
            &scope,
            &library.id,
            "source",
            "Real revision title",
            "Immutable original",
        )?;
        Ok((root, store, scope, library.id, source))
    }
    #[test]
    fn overview_keyset_paginates_beyond_one_hundred_and_prioritizes_active_jobs() -> Result<()> {
        let (_root, mut store, scope, library, source) = catalog()?;
        store.connection.execute("INSERT INTO knowledge_sources(library_id,source_id,revision_id,request_key,title,body_hash) VALUES(?1,?2,?3,'other-revision','Other revision title',?4)",params![library,source.source_id,uuid::Uuid::new_v4().to_string(),source.body_hash])?;
        let mut expected = std::collections::BTreeSet::new();
        for index in 0..121 {
            let job = store.enqueue_ingest(
                &scope,
                &library,
                &format!("job-{index}"),
                &source.source_id,
                &source.revision_id,
                "recipe",
                "zh-CN",
            )?;
            expected.insert(job.id.clone());
            store.connection.execute(
                "UPDATE knowledge_jobs SET status='completed' WHERE job_id=?1",
                [&job.id],
            )?;
        }
        let active = store.enqueue_ingest(
            &scope,
            &library,
            "active",
            &source.source_id,
            &source.revision_id,
            "recipe",
            "zh-CN",
        )?;
        expected.insert(active.id.clone());
        let _lease = store.claim_job(&scope, &library, &active.id)?.unwrap();
        let first = store.job_overview_page(&scope, &library, None, 16)?;
        assert_eq!(first.items.len(), 16);
        assert_eq!(first.items[0].job.id, active.id);
        assert!(
            first
                .items
                .iter()
                .all(|item| item.source_title.as_deref() == Some("Real revision title"))
        );
        let mut seen = first
            .items
            .iter()
            .map(|item| item.job.id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        let mut cursor = first.next_cursor;
        while let Some(next) = cursor {
            let page = store.job_overview_page(&scope, &library, Some(&next), 16)?;
            assert!(!page.items.is_empty());
            assert!(serde_json::to_vec(&page)?.len() <= JOB_OVERVIEW_MAX_BYTES);
            for item in page.items {
                assert!(seen.insert(item.job.id), "keyset duplicated a stable job");
            }
            cursor = page.next_cursor;
        }
        assert_eq!(seen, expected);
        Ok(())
    }
    #[test]
    fn overview_cursor_cannot_cross_library_principal_or_target_scope() -> Result<()> {
        let (_root, mut store, scope, library, source) = catalog()?;
        for index in 0..2 {
            store.enqueue_ingest(
                &scope,
                &library,
                &format!("job-{index}"),
                &source.source_id,
                &source.revision_id,
                "recipe",
                "en",
            )?;
        }
        let cursor = store
            .job_overview_page(&scope, &library, None, 1)?
            .next_cursor
            .unwrap();
        let other = store.create(&scope, "other", "Other", "")?;
        assert!(
            store
                .job_overview_page(&scope, &other.id, Some(&cursor), 16)
                .is_err()
        );
        for foreign in [
            KnowledgeScope::from_authenticated_host("foreign", "target")?,
            KnowledgeScope::from_authenticated_host("overview-owner", "foreign-target")?,
        ] {
            assert!(
                store
                    .job_overview_page(&foreign, &library, Some(&cursor), 16)
                    .is_err()
            );
        }
        assert!(
            store
                .job_overview_page(&scope, &library, Some("malformed PRIVATE_CURSOR"), 16)
                .unwrap_err()
                .to_string()
                .contains("invalid Wiki overview cursor")
        );
        Ok(())
    }
    #[test]
    fn overview_uses_real_pipeline_for_actionable_jobs_and_bounds_serialized_json() -> Result<()> {
        use kcoder_types::wiki_pipeline::{
            WikiPipelineStageAddress, WikiPipelineStageKind, WikiPipelineStageRecord,
            WikiPipelineStageStatus,
        };
        let (_root, mut store, scope, library, source) = catalog()?;
        let mut ids = Vec::new();
        for index in 0..4 {
            let job = store.enqueue_ingest(
                &scope,
                &library,
                &format!("job-{index}"),
                &source.source_id,
                &source.revision_id,
                "recipe",
                "en",
            )?;
            store.connection.execute(
                "UPDATE knowledge_jobs SET status='failed' WHERE job_id=?1",
                [&job.id],
            )?;
            for unit in 0..256 {
                let record = WikiPipelineStageRecord {
                    address: WikiPipelineStageAddress {
                        batch: 0,
                        source_revision: source.revision_id.clone(),
                        stage_key: format!("topic-{unit}"),
                        stage: WikiPipelineStageKind::Generate,
                        unit_key: unit.to_string(),
                    },
                    status: WikiPipelineStageStatus::Failed,
                    attempt: 1,
                    reused: false,
                    unit_label: Some("\"".repeat(512)),
                    unit_index: Some(unit),
                    completed_units: None,
                    total_units: Some(256),
                    started_at_ms: Some(1),
                    completed_at_ms: None,
                    updated_at_ms: 2,
                    artifact_hash: None,
                    error_code: Some("fixture_failed".into()),
                    error_detail: None,
                };
                store.connection.execute("INSERT INTO knowledge_pipeline_stages(library_id,job_id,batch,stage_key,unit_key,input_fingerprint,binding_json,record_json) VALUES(?1,?2,0,?3,?4,?5,'{}',?6)",params![library,job.id,record.address.stage_key,record.address.unit_key,"a".repeat(64),serde_json::to_string(&record)?])?;
            }
            ids.push(job.id);
        }
        let page = store.job_overview_page(&scope, &library, None, 1000)?;
        assert!(!page.items.is_empty());
        assert!(page.items.len() < ids.len());
        assert!(page.next_cursor.is_some());
        assert!(serde_json::to_vec(&page)?.len() <= JOB_OVERVIEW_MAX_BYTES);
        assert!(page.items.iter().all(|item| {
            item.job
                .pipeline
                .as_ref()
                .is_some_and(|pipeline| pipeline.records.len() == 256)
        }));
        store.connection.execute(
            "UPDATE knowledge_jobs SET status='completed' WHERE job_id=?1",
            [&ids[0]],
        )?;
        store.connection.execute(
            "UPDATE knowledge_jobs SET status='cancelled' WHERE job_id=?1",
            [&ids[1]],
        )?;
        let small = store.job_overview_page(&scope, &library, None, 100)?;
        for id in &ids[..2] {
            assert!(
                small
                    .items
                    .iter()
                    .find(|item| &item.job.id == id)
                    .unwrap()
                    .job
                    .pipeline
                    .is_none()
            );
        }
        assert!(
            small
                .items
                .iter()
                .filter(|item| matches!(item.job.status.as_str(), "completed" | "cancelled"))
                .all(|item| item.job.pipeline.is_none())
        );
        Ok(())
    }
}
