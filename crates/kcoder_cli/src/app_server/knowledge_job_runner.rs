//! Target model execution over the persistent Wiki job/checkpoint protocol.
//! Shared by the local connection adapter and the independent target Wiki worker.
//! Leases and checkpoints remain authoritative across process boundaries.
use super::{knowledge_model::ProviderWikiModel, knowledge_requests};
use anyhow::{Result, ensure};
use kcoder_knowledge::{WikiCheckpoint, WikiIngestRequest};
use std::path::Path;
use tokio_util::sync::CancellationToken;

pub(super) async fn run(
    path: &Path,
    library: &str,
    job_id: &str,
    model: &ProviderWikiModel,
    context_tokens: usize,
    cancel: &CancellationToken,
) -> Result<()> {
    let (mut store, scope) = knowledge_requests::open_catalog(path)?;
    loop {
        if cancel.is_cancelled() || !knowledge_requests::organization_enabled(path)? {
            store.pause_job(&scope, library, job_id)?;
            return Ok(());
        }
        let Some(lease) = store.claim_job(&scope, library, job_id)? else {
            return Ok(());
        };
        let attempt:Result<()>=async {
            let checkpoint=match store.job_checkpoint(&scope,library,job_id)? {
                Some(checkpoint)=>checkpoint,
                None=>{
                    let (mut heartbeat,_)=knowledge_requests::open_catalog(path)?;
                    let monitor=async {
                        loop {
                            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                            if !knowledge_requests::organization_enabled(path).unwrap_or(false) || heartbeat.heartbeat_job(&scope,library,&lease).is_err() {return;}
                        }
                    };
                    let budgeted = BudgetedModel { path, library, lease: &lease, inner: model };
                    let prepared=tokio::select! {
                        biased;
                        _=cancel.cancelled()=>anyhow::bail!("Wiki job cancelled"),
                        _=monitor=>anyhow::bail!("Wiki job paused or disabled"),
                        value=store.prepare_wiki_update(&scope,WikiIngestRequest {library_id:library,source_id:&lease.job.source_id,source_revision:&lease.job.source_revision,after_chunk:lease.job.after_chunk,output_language:&lease.job.language,context_tokens:context_tokens.min(2_000_000)},&budgeted,cancel)=>value?,
                    };
                    let checkpoint=WikiCheckpoint {through_chunk:prepared.through_chunk,has_more_chunks:prepared.has_more_chunks,proposal:prepared.proposal};
                    store.save_job_checkpoint(&scope,library,&lease,&checkpoint)?;
                    checkpoint
                }
            };
            if !checkpoint.proposal.review_notes.is_empty() {
                store.stop_job_with_reason(&scope,library,&lease,"awaiting_review","review_required")?;
                return Ok(());
            }
            ensure!(!cancel.is_cancelled() && knowledge_requests::organization_enabled(path)?,"Wiki job disabled before commit");
            store.commit_job_checkpoint(&scope,library,&lease)?;
            store.finish_job_batch(&scope,library,&lease)?;
            Ok(())
        }.await;
        if let Err(error) = attempt {
            if let Some(truncated) = error.downcast_ref::<kcoder_knowledge::WikiOutputTruncated>() {
                store.record_job_truncation_details(&scope, library, &lease, truncated)?;
            }

            if let Some(provider_error) = error.downcast_ref::<kcoder_api::ApiErrorKind>() {
                store.record_job_provider_error(
                    &scope,
                    library,
                    &lease,
                    &provider_error.safe_summary(),
                )?;
            }
            if error.is::<kcoder_knowledge::ReviewRequired>() {
                store.stop_job_with_reason(
                    &scope,
                    library,
                    &lease,
                    "awaiting_review",
                    "review_required",
                )?;
                return Ok(());
            }
            let paused = cancel.is_cancelled()
                || !knowledge_requests::organization_enabled(path).unwrap_or(false);
            store.stop_job_with_reason(
                &scope,
                library,
                &lease,
                if paused { "paused" } else { "failed" },
                if paused {
                    "cancelled"
                } else {
                    failure_code(&error)
                },
            )?;
            return Err(error);
        }
        if store.read_job(&scope, library, job_id)?.status != "queued" {
            return Ok(());
        }
    }
}

pub(super) fn recipe_key(
    settings: &kcoder_config::Settings,
    model: &ProviderWikiModel,
    purpose: &str,
) -> Result<String> {
    use sha2::{Digest, Sha256};
    // Hash behavior inputs, never persist credentials or request headers.
    let value = serde_json::json!({"version":kcoder_knowledge::PREPARATION_VERSION,"provider":settings.active_provider,"model":settings.model,"endpoint":model.provider.endpoint(),"format":settings.api_format,"reasoning":settings.model_reasoning_effort,"extraBody":settings.provider_extra_body,"context":settings.context_window_tokens,"output":settings.max_tokens,"purpose":purpose});
    Ok(format!(
        "wiki-v1:{:x}",
        Sha256::digest(serde_json::to_vec(&value)?)
    ))
}

pub(super) fn slots() -> std::sync::Arc<tokio::sync::Semaphore> {
    static SLOTS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    SLOTS
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
}

fn failure_code(error: &anyhow::Error) -> &'static str {
    let detail = format!("{error:#}");
    if detail.contains("invalid analysis JSON")
        || detail.contains("invalid Wiki proposal JSON")
        || detail.contains("invalid Wiki JSON")
    {
        "invalid_model_output"
    } else if detail.contains("output was truncated") {
        "model_output_truncated"
    } else if detail.contains("context budget exceeded")
        || detail.contains("output budget cannot fit")
        || detail.contains("invalid context budget")
    {
        "context_budget_exceeded"
    } else if error.is::<kcoder_api::ApiErrorKind>()
        || detail.contains("model request failed")
        || detail.contains("model stream ended")
    {
        "provider_error"
    } else if detail.contains("revision conflict") {
        "revision_conflict"
    } else if detail.contains("citation") || detail.contains("source revision not found") {
        "invalid_evidence"
    } else {
        "ingest_failed"
    }
}

struct BudgetedModel<'a> {
    path: &'a Path,
    library: &'a str,
    lease: &'a kcoder_knowledge::WikiJobLease,
    inner: &'a ProviderWikiModel,
}
#[async_trait::async_trait]
impl kcoder_knowledge::WikiModel for BudgetedModel<'_> {
    fn output_token_budget(&self, suggested: u32) -> Result<u32> {
        kcoder_knowledge::WikiModel::output_token_budget(self.inner, suggested)
    }
    fn remember_analysis(
        &self,
        input: &kcoder_knowledge::WikiModelRequest,
        analysis: &kcoder_knowledge::WikiAnalysis,
    ) -> Result<()> {
        let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
        store.remember_analysis(
            &scope,
            self.library,
            self.lease,
            &self.cache_key(input)?,
            analysis,
        )
    }

    async fn complete(&self, input: kcoder_knowledge::WikiModelRequest) -> Result<String> {
        self.complete_with_output_limit(input, u32::MAX).await
    }
    async fn complete_with_output_limit(
        &self,
        input: kcoder_knowledge::WikiModelRequest,
        limit: u32,
    ) -> Result<String> {
        if input.stage == "analysis" {
            let (store, scope) = knowledge_requests::open_catalog(self.path)?;
            ensure!(
                knowledge_requests::organization_enabled(self.path)?,
                "Wiki is disabled"
            );
            if let Some(cached) =
                store.cached_analysis(&scope, self.library, self.lease, &self.cache_key(&input)?)?
            {
                return Ok(cached);
            }
        }
        let reservation = {
            let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
            ensure!(
                knowledge_requests::organization_enabled(self.path)?,
                "Wiki is disabled"
            );
            store
                .budget_reserve(&scope, self.library, self.lease, 64)?
                .ok_or_else(|| anyhow::anyhow!("Wiki model call budget exceeded"))?
        };
        let result = self.inner.complete_measured_with_limit(input, limit).await;
        let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
        let usage = match &result {
            Ok((_, usage)) => usage.clone(),
            Err(error) => error
                .downcast_ref::<super::knowledge_model::WikiReportedUsage>()
                .and_then(|context| context.0.clone()),
        };
        store.budget_record_usage(&scope, self.library, &reservation, usage)?;
        result.map(|(text, _)| text)
    }
}

impl BudgetedModel<'_> {
    fn cache_key(&self, input: &kcoder_knowledge::WikiModelRequest) -> Result<String> {
        use sha2::{Digest, Sha256};
        let bytes = serde_json::to_vec(
            &serde_json::json!({"recipe":self.lease.job.recipe_key,"stage":input.stage,"system":input.system,"user":input.user,"maxOutput":input.max_output_tokens}),
        )?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
}
