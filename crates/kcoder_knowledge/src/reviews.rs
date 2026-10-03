//! Human decisions are bound to the exact persisted proposal. Accepting a review
//! publishes pages and advances the job in the same database transaction.
use crate::{KnowledgeCatalog, KnowledgeScope, WikiCheckpoint, WikiJob, objects::digest};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub struct ReviewRequired;
impl std::fmt::Display for ReviewRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("human-edited page requires review")
    }
}
impl std::error::Error for ReviewRequired {}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReviewSummary {
    pub token: String,
    pub notes: Vec<String>,
    pub pages: Vec<WikiReviewPage>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReviewPage {
    pub page_id: String,
    pub title: String,
    pub updating: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReviewExcerpt {
    pub proposed: String,
    pub current: Option<String>,
    pub next_offset: Option<usize>,
}

impl KnowledgeCatalog {
    pub fn pending_review(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        job: &str,
    ) -> Result<WikiReviewSummary> {
        let status = self.read_job(scope, library, job)?;
        ensure!(
            status.status == "awaiting_review",
            "Wiki job has no pending review"
        );
        let raw: String = self.connection.query_row(
            "SELECT checkpoint_json FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2",
            params![library, job],
            |r| r.get(0),
        )?;
        let checkpoint: WikiCheckpoint = serde_json::from_str(&raw)?;
        Ok(WikiReviewSummary {
            token: review_token(library, job, &raw),
            notes: checkpoint.proposal.review_notes,
            pages: checkpoint
                .proposal
                .pages
                .into_iter()
                .map(|p| WikiReviewPage {
                    page_id: p.page_id,
                    title: p.title,
                    updating: p.expected_revision.is_some(),
                })
                .collect(),
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn review_excerpt(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        job: &str,
        token: &str,
        page_id: &str,
        offset: usize,
    ) -> Result<WikiReviewExcerpt> {
        ensure!(
            self.pending_review(scope, library, job)?.token == token,
            "Wiki review changed; reload it"
        );
        let checkpoint = self
            .job_checkpoint(scope, library, job)?
            .ok_or_else(|| anyhow::anyhow!("Wiki checkpoint missing"))?;
        let page = checkpoint
            .proposal
            .pages
            .iter()
            .find(|p| p.page_id == page_id)
            .ok_or_else(|| anyhow::anyhow!("review page not found"))?;
        let current = if page.expected_revision.is_some() {
            Some(
                self.read_page(scope, library, page_id, None)?
                    .draft
                    .markdown,
            )
        } else {
            None
        };
        let end = offset
            .checked_add(16_384)
            .ok_or_else(|| anyhow::anyhow!("invalid review offset"))?;
        let total = page
            .markdown
            .chars()
            .count()
            .max(current.as_ref().map_or(0, |v| v.chars().count()));
        ensure!(offset <= total, "invalid review offset");
        Ok(WikiReviewExcerpt {
            proposed: page.markdown.chars().skip(offset).take(16_384).collect(),
            current: current.map(|text| text.chars().skip(offset).take(16_384).collect()),
            next_offset: (end < total).then_some(end),
        })
    }
    pub fn decide_review(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        job: &str,
        token: &str,
        accept: bool,
    ) -> Result<WikiJob> {
        self.read(scope, library)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let previous:Option<bool>=tx.query_row("SELECT accepted FROM knowledge_review_receipts WHERE library_id=?1 AND job_id=?2 AND token=?3",params![library,job,token],|r|r.get(0)).optional()?;
        if let Some(previous) = previous {
            ensure!(previous == accept, "Wiki review was already decided");
            return Ok(tx.query_row("SELECT job_id,source_id,source_revision,recipe_key,language,status,after_chunk,error_code,error_detail FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2",params![library,job],crate::jobs::read_job)?);
        }
        let raw:String=tx.query_row("SELECT checkpoint_json FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2 AND status='awaiting_review'",params![library,job],|r|r.get(0)).optional()?.ok_or_else(||anyhow::anyhow!("Wiki job has no pending review"))?;
        ensure!(
            review_token(library, job, &raw) == token,
            "Wiki review changed; reload it"
        );
        let checkpoint: WikiCheckpoint = serde_json::from_str(&raw)?;
        let commit_key = format!("wiki-job:{job}:{}", checkpoint.through_chunk);
        let payload_hash = digest(&serde_json::to_vec(&checkpoint.proposal.pages)?);
        tx.execute("INSERT INTO knowledge_review_receipts(library_id,job_id,token,commit_key,payload_hash,accepted,checkpoint_json) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![library,job,token,commit_key,payload_hash,accept,raw])?;
        if accept {
            crate::pages::commit_in_transaction(
                &tx,
                &self.objects,
                library,
                &commit_key,
                checkpoint.proposal.pages,
                None,
            )?;
            tx.execute("UPDATE knowledge_jobs SET status=?3,after_chunk=?4,checkpoint_json=NULL,error_code=NULL,lease_token=NULL,lease_until_ms=0 WHERE library_id=?1 AND job_id=?2",params![library,job,if checkpoint.has_more_chunks {"queued"} else {"completed"},checkpoint.through_chunk as i64])?;
        } else {
            tx.execute("UPDATE knowledge_jobs SET status='cancelled',checkpoint_json=NULL,error_code=NULL,lease_token=NULL,lease_until_ms=0 WHERE library_id=?1 AND job_id=?2",params![library,job])?;
        }
        let result=tx.query_row("SELECT job_id,source_id,source_revision,recipe_key,language,status,after_chunk,error_code,error_detail FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2",params![library,job],crate::jobs::read_job)?;
        tx.commit()?;
        Ok(result)
    }
}
fn review_token(library: &str, job: &str, raw: &str) -> String {
    digest(format!("wiki-review-v1\n{library}\n{job}\n{raw}").as_bytes())
}
