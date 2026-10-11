//! Target model execution over the persistent Wiki job/checkpoint protocol.
//! Shared by the local connection adapter and the independent target Wiki worker.
//! Leases and checkpoints remain authoritative across process boundaries.
use super::{knowledge_model::ProviderWikiModel, knowledge_requests};
use anyhow::{Result, ensure};
use kcoder_knowledge::{WikiCheckpoint, WikiIngestRequest};
use std::path::Path;
use tokio_util::sync::CancellationToken;
#[path = "knowledge_job_pipeline.rs"]
mod pipeline;

pub(super) const MAX_CONCURRENT_JOBS: usize = 2;

pub(super) async fn run(
    path: &Path,
    library: &str,
    job_id: &str,
    model: &ProviderWikiModel,
    context_tokens: usize,
    cancel: &CancellationToken,
) -> Result<()> {
    run_inner(path, library, job_id, model, context_tokens, cancel, None).await
}

/// The scheduler claims before spawning so another process's running lease
/// cannot repeatedly occupy a worker slot ahead of queued sources.
pub(super) async fn run_claimed(
    path: &Path,
    library: &str,
    lease: kcoder_knowledge::WikiJobLease,
    model: &ProviderWikiModel,
    context_tokens: usize,
    cancel: &CancellationToken,
) -> Result<()> {
    let job_id = lease.job.id.clone();
    run_inner(
        path,
        library,
        &job_id,
        model,
        context_tokens,
        cancel,
        Some(lease),
    )
    .await
}

async fn run_inner(
    path: &Path,
    library: &str,
    job_id: &str,
    model: &ProviderWikiModel,
    context_tokens: usize,
    cancel: &CancellationToken,
    mut initial_lease: Option<kcoder_knowledge::WikiJobLease>,
) -> Result<()> {
    let (mut store, scope) = knowledge_requests::open_catalog(path)?;
    loop {
        if cancel.is_cancelled() || !knowledge_requests::organization_enabled(path)? {
            if let Some(lease) = initial_lease.as_ref() {
                store.stop_job_with_reason(&scope, library, lease, "paused", "cancelled")?;
            }
            return Ok(());
        }
        let Some(lease) = (match initial_lease.take() {
            Some(lease) => Some(lease),
            None => store.claim_job(&scope, library, job_id)?,
        }) else {
            return Ok(());
        };
        let budgeted = BudgetedModel::new(path, library, &lease, model)?;
        let mut heartbeat = knowledge_requests::open_catalog(path)?.0;
        let monitor = async {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                ensure!(
                    knowledge_requests::organization_enabled(path).unwrap_or(false),
                    "Wiki job disabled"
                );
                heartbeat.heartbeat_job(&scope, library, &lease)?;
                budgeted.heartbeat_merge()?;
            }
            #[allow(unreachable_code)]
            Ok::<(), anyhow::Error>(())
        };
        let prepare_and_commit = async {
            let checkpoint = match store.job_checkpoint(&scope, library, job_id)? {
                Some(checkpoint) => {
                    // Old durable proposals remain idempotent, but automated
                    // writers still serialize the final revision check/commit.
                    budgeted.acquire_merge(cancel).await?;
                    checkpoint
                }
                None => {
                    let prepared = store
                        .prepare_wiki_update(
                            &scope,
                            WikiIngestRequest {
                                library_id: library,
                                source_id: &lease.job.source_id,
                                source_revision: &lease.job.source_revision,
                                after_chunk: lease.job.after_chunk,
                                output_language: &lease.job.language,
                                context_tokens: context_tokens.min(2_000_000),
                            },
                            &budgeted,
                            cancel,
                        )
                        .await?;
                    let checkpoint = WikiCheckpoint {
                        through_chunk: prepared.through_chunk,
                        has_more_chunks: prepared.has_more_chunks,
                        proposal: prepared.proposal,
                    };
                    store.save_job_checkpoint(&scope, library, &lease, &checkpoint)?;
                    checkpoint
                }
            };
            if !checkpoint.proposal.review_notes.is_empty() {
                store.stop_job_with_reason(
                    &scope,
                    library,
                    &lease,
                    "awaiting_review",
                    "review_required",
                )?;
                return Ok(());
            }
            ensure!(
                !cancel.is_cancelled() && knowledge_requests::organization_enabled(path)?,
                "Wiki job disabled before commit"
            );
            budgeted.validate_publication_owner()?;
            budgeted.progress("commit", 0, 0)?;
            let commit_stage = budgeted
                .pipeline_enabled
                .then(|| budgeted.commit_stage_input(&checkpoint))
                .transpose()?;
            if let Some(input) = &commit_stage {
                store.stage_begin(&scope, library, &lease, input)?;
            }
            let published = match store.commit_job_checkpoint(&scope, library, &lease) {
                Ok(revisions) => revisions,
                Err(error) => {
                    if let Some(input) = &commit_stage {
                        store.stage_mark_failed(
                            &scope,
                            library,
                            &lease,
                            input,
                            failure_code(&error),
                            "/",
                        )?;
                    }
                    return Err(error);
                }
            };
            if let Some(input) = &commit_stage {
                store.stage_mark_completed(
                    &scope,
                    library,
                    &lease,
                    input,
                    &serde_json::to_string(&published)?,
                )?;
            }
            store.finish_job_batch(&scope, library, &lease)?;
            store.clear_terminal_stage_cache(&scope, library)?;
            Ok::<(), anyhow::Error>(())
        };
        let attempt: Result<()> = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(anyhow::anyhow!("Wiki job cancelled")),
            result = monitor => result,
            result = prepare_and_commit => result,
        };
        if let Err(error) = attempt {
            store.record_job_candidate_failure(&scope, library, &lease, &error)?;
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
                stop_for_review(&mut store, &scope, library, &lease)?;
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

/// Early stage diagnostics do not constitute a complete, publishable proposal.
/// A retryable failure preserves those records without exposing a fake review.
fn stop_for_review(
    store: &mut kcoder_knowledge::KnowledgeCatalog,
    scope: &kcoder_knowledge::KnowledgeScope,
    library: &str,
    lease: &kcoder_knowledge::WikiJobLease,
) -> Result<()> {
    let prepared = store
        .job_checkpoint(scope, library, &lease.job.id)?
        .is_some();
    store.stop_job_with_reason(
        scope,
        library,
        lease,
        if prepared {
            "awaiting_review"
        } else {
            "failed"
        },
        if prepared {
            "review_required"
        } else {
            "review_required_without_candidate"
        },
    )
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
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_JOBS)))
        .clone()
}

fn failure_code(error: &anyhow::Error) -> &'static str {
    let detail = format!("{error:#}");
    if detail.contains("shared repair budget exceeded") {
        "repair_budget_exceeded"
    } else if kcoder_knowledge::KnowledgeCatalog::candidate_failure_code(error)
        == Some("wiki_candidate_relations_bounds")
    {
        // The legacy commit bounds failure used the generic public category.
        "ingest_failed"
    } else if kcoder_knowledge::KnowledgeCatalog::candidate_failure_code(error)
        .is_some_and(|code| code.starts_with("wiki_evidence_"))
    {
        "invalid_evidence"
    } else if kcoder_knowledge::KnowledgeCatalog::candidate_failure_code(error).is_some()
        || error.chain().any(|cause| {
            matches!(
                cause.to_string().as_str(),
                "analysis exceeds budget"
                    | "conflict analysis exceeds budget"
                    | "review notes exceed budget"
                    | "proposal repeats page identity"
                    | "proposal uses an unreserved overview id"
                    | "reserved overview id cannot change page kind"
                    | "proposal uses an unread or unallocated page id"
                    | "proposal page exceeds budget"
                    | "related page not found"
                    | "self reference is not a related page"
                    | "invalid page title"
                    | "invalid page content size"
                    | "duplicate page id"
                    | "invalid page id"
            )
        })
        || detail.contains("invalid analysis JSON")
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
    pipeline_enabled: bool,
    purpose_hash: String,
    model_fingerprint: String,
    merge: std::sync::Mutex<Option<kcoder_knowledge::WikiAutomaticMergeLease>>,
}
#[async_trait::async_trait]
impl kcoder_knowledge::WikiModel for BudgetedModel<'_> {
    fn supports_staged_topics(&self) -> bool {
        self.pipeline_enabled
    }
    async fn acquire_merge_slot(&self, cancel: &CancellationToken) -> Result<()> {
        self.acquire_merge(cancel).await
    }
    fn stage_begin(&self, request: &kcoder_knowledge::WikiModelRequest) -> Result<()> {
        if let Some(input) = self.recover_compatible_stage(request)? {
            let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
            store.stage_begin(&scope, self.library, self.lease, &input)?;
        }
        Ok(())
    }
    fn stage_received_response(
        &self,
        request: &kcoder_knowledge::WikiModelRequest,
    ) -> Result<Option<String>> {
        if let Some(input) = self.recover_compatible_stage(request)? {
            let (store, scope) = knowledge_requests::open_catalog(self.path)?;
            return store.stage_received_response(&scope, self.library, self.lease, &input);
        }
        Ok(None)
    }
    fn stage_remember_received(
        &self,
        request: &kcoder_knowledge::WikiModelRequest,
        raw: &str,
    ) -> Result<()> {
        if let Some(input) = self.stage_input(request)? {
            let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
            store.stage_remember_received(&scope, self.library, self.lease, &input, raw)?;
        }
        Ok(())
    }
    fn stage_validated_output(
        &self,
        request: &kcoder_knowledge::WikiModelRequest,
    ) -> Result<Option<String>> {
        if let Some(input) = self.recover_compatible_stage(request)? {
            let (store, scope) = knowledge_requests::open_catalog(self.path)?;
            return store.stage_validated_output(&scope, self.library, self.lease, &input);
        }
        Ok(None)
    }
    fn stage_mark_validated(
        &self,
        request: &kcoder_knowledge::WikiModelRequest,
        canonical: &str,
    ) -> Result<()> {
        if let Some(input) = self.stage_input(request)? {
            let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
            store.stage_mark_validated(&scope, self.library, self.lease, &input, canonical)?;
        }
        Ok(())
    }
    fn stage_mark_completed(
        &self,
        request: &kcoder_knowledge::WikiModelRequest,
        canonical: &str,
    ) -> Result<()> {
        if let Some(input) = self.stage_input(request)? {
            let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
            store.stage_mark_completed(&scope, self.library, self.lease, &input, canonical)?;
        }
        Ok(())
    }
    fn stage_mark_failed(
        &self,
        request: &kcoder_knowledge::WikiModelRequest,
        code: &str,
        field: &str,
    ) -> Result<()> {
        if let Some(input) = self.stage_input(request)? {
            let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
            store.stage_mark_failed(&scope, self.library, self.lease, &input, code, field)?;
        }
        Ok(())
    }
    fn stage_mark_needs_review(
        &self,
        request: &kcoder_knowledge::WikiModelRequest,
        canonical: &str,
        code: &str,
        field: &str,
    ) -> Result<()> {
        if let Some(input) = self.stage_input(request)? {
            let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
            store.stage_mark_needs_review(
                &scope,
                self.library,
                self.lease,
                &input,
                canonical,
                code,
                field,
            )?;
        }
        Ok(())
    }
    fn estimate_input_tokens(&self, request: &kcoder_knowledge::WikiModelRequest) -> usize {
        let estimate = kcoder_knowledge::WikiModel::estimate_input_tokens(self.inner, request);
        knowledge_requests::open_catalog(self.path)
            .and_then(|(store, scope)| {
                store.calibrated_input_estimate(&scope, self.library, &self.lease.job.id, estimate)
            })
            .unwrap_or_else(|_| {
                request
                    .system
                    .len()
                    .saturating_add(request.user.len())
                    .saturating_add(512)
            })
    }
    fn batch_identity(&self) -> String {
        format!("{}:{}", self.lease.job.id, self.lease.job.recipe_key)
    }
    fn restored_through_chunk(&self) -> Result<Option<usize>> {
        let (store, scope) = knowledge_requests::open_catalog(self.path)?;
        Ok(store
            .read_job(&scope, self.library, &self.lease.job.id)?
            .progress
            .and_then(|progress| progress.through_chunk))
    }
    fn source_range(
        &self,
        through: usize,
        first_page: Option<u32>,
        last_page: Option<u32>,
    ) -> Result<()> {
        self.record_source_read(through, first_page, last_page)?;
        let (store, scope) = knowledge_requests::open_catalog(self.path)?;
        if store
            .read_job(&scope, self.library, &self.lease.job.id)?
            .progress
            .is_none()
        {
            self.progress("analysis", 0, 0)?;
        }
        let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
        let mut progress = store
            .read_job(&scope, self.library, &self.lease.job.id)?
            .progress
            .unwrap();
        progress.through_chunk = Some(through);
        progress.first_page = first_page;
        progress.last_page = last_page;
        store.update_job_progress(&scope, self.library, self.lease, &progress)?;
        Ok(())
    }
    fn cached_proposal(
        &self,
        input: &kcoder_knowledge::WikiModelRequest,
    ) -> Result<Option<kcoder_knowledge::WikiProposal>> {
        let (store, scope) = knowledge_requests::open_catalog(self.path)?;
        ensure!(
            knowledge_requests::organization_enabled(self.path)?,
            "Wiki is disabled"
        );
        if let Some(proposal) =
            store.cached_proposal(&scope, self.library, self.lease, &self.cache_key(input)?)?
        {
            return Ok(Some(proposal));
        }
        for compatible in Self::format_cache_requests(input)? {
            if let Some(proposal) = store.cached_proposal(
                &scope,
                self.library,
                self.lease,
                &self.cache_key(&compatible)?,
            )? {
                return Ok(Some(proposal));
            }
        }
        Ok(None)
    }
    fn cached_json_response(
        &self,
        input: &kcoder_knowledge::WikiModelRequest,
    ) -> Result<Option<String>> {
        let (store, scope) = knowledge_requests::open_catalog(self.path)?;
        ensure!(
            knowledge_requests::organization_enabled(self.path)?,
            "Wiki is disabled"
        );
        if let Some(raw) =
            store.cached_json_response(&scope, self.library, self.lease, &self.cache_key(input)?)?
        {
            return Ok(Some(raw));
        }
        for compatible in Self::format_cache_requests(input)? {
            if let Some(raw) = store.cached_json_response(
                &scope,
                self.library,
                self.lease,
                &self.cache_key(&compatible)?,
            )? {
                return Ok(Some(raw));
            }
        }
        Ok(None)
    }
    fn remember_json_response(
        &self,
        input: &kcoder_knowledge::WikiModelRequest,
        raw: &str,
    ) -> Result<()> {
        let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
        store.remember_json_response(
            &scope,
            self.library,
            self.lease,
            &self.cache_key(input)?,
            raw,
        )
    }
    fn forget_json_response(&self, input: &kcoder_knowledge::WikiModelRequest) -> Result<()> {
        let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
        if let Some(stage) = self.stage_input(input)? {
            store.stage_invalidate_artifacts(&scope, self.library, self.lease, &stage)?;
        }
        store.forget_json_response(&scope, self.library, self.lease, &self.cache_key(input)?)?;
        for compatible in Self::format_cache_requests(input)? {
            store.forget_json_response(
                &scope,
                self.library,
                self.lease,
                &self.cache_key(&compatible)?,
            )?;
        }
        Ok(())
    }
    fn remember_proposal(
        &self,
        input: &kcoder_knowledge::WikiModelRequest,
        proposal: &kcoder_knowledge::WikiProposal,
    ) -> Result<()> {
        let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
        store.remember_proposal(
            &scope,
            self.library,
            self.lease,
            &self.cache_key(input)?,
            proposal,
        )
    }
    fn output_token_budget(&self, suggested: u32) -> Result<u32> {
        kcoder_knowledge::WikiModel::output_token_budget(self.inner, suggested)
    }
    fn remaining_shared_repairs(&self) -> Result<u32> {
        let (store, scope) = knowledge_requests::open_catalog(self.path)?;
        Ok(3u32.saturating_sub(store.job_batch_repair_calls(&scope, self.library, self.lease)?))
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
        // Local request-shape/output failures cannot consume a model call.
        self.inner.with_output_limit(&input, limit)?;
        let reservation = {
            let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
            ensure!(
                knowledge_requests::organization_enabled(self.path)?,
                "Wiki is disabled"
            );
            store
                .budget_reserve_for_stage(
                    &scope,
                    self.library,
                    self.lease,
                    64,
                    input.stage,
                    Some(self.estimate_input_tokens(&input)),
                )?
                .ok_or_else(|| anyhow::anyhow!("Wiki model call budget exceeded"))?
        };
        let stage = input.stage;
        self.progress(stage, 0, 0)?;
        {
            let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
            let mut progress = store
                .read_job(&scope, self.library, &self.lease.job.id)?
                .progress
                .unwrap();
            progress.requested_output_tokens = Some(
                self.output_token_budget(input.max_output_tokens)?
                    .min(limit),
            );
            progress.estimated_input_tokens = Some(self.estimate_input_tokens(&input));
            store.update_job_progress(&scope, self.library, self.lease, &progress)?;
        }
        let progress = |text, reasoning| self.progress(stage, text, reasoning);
        let result = self
            .inner
            .complete_measured_with_progress(input, limit, &progress)
            .await;
        let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
        let usage = match &result {
            Ok((_, usage)) => usage.clone(),
            Err(error) => error
                .downcast_ref::<super::knowledge_model::WikiReportedUsage>()
                .and_then(|context| context.0.clone()),
        };
        store.budget_record_usage(&scope, self.library, &reservation, usage)?;
        // Refresh actual usage even when the Provider failed. No absent report
        // becomes estimated tokens; reservation still counts the real request.
        let current = store.read_job(&scope, self.library, &self.lease.job.id)?;
        if current.status == "running"
            && let Some(progress) = current.progress
        {
            self.progress(stage, progress.text_bytes, progress.reasoning_bytes)?;
        }
        result.map(|(text, _)| text)
    }
}

impl<'a> BudgetedModel<'a> {
    fn new(
        path: &'a Path,
        library: &'a str,
        lease: &'a kcoder_knowledge::WikiJobLease,
        inner: &'a ProviderWikiModel,
    ) -> Result<Self> {
        let (store, scope) = knowledge_requests::open_catalog(path)?;
        let pipeline_enabled = store.job_pipeline_enabled(&scope, library, &lease.job.id)?;
        let purpose_hash = pipeline::hash(store.read(&scope, library)?.purpose.as_bytes());
        let model_fingerprint = pipeline::hash(&serde_json::to_vec(&serde_json::json!({
            "recipe": lease.job.recipe_key, "model": inner.model,
            "configuration": inner.configuration, "reasoning": inner.reasoning,
            "maxOutput": inner.max_output_tokens,
        }))?);
        Ok(Self {
            path,
            library,
            lease,
            inner,
            pipeline_enabled,
            purpose_hash,
            model_fingerprint,
            merge: std::sync::Mutex::new(None),
        })
    }

    fn progress(&self, stage: &str, text: usize, reasoning: usize) -> Result<()> {
        let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
        let current = store.read_job(&scope, self.library, &self.lease.job.id)?;
        let now: i64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis()
            .try_into()?;
        let budget = store.budget_read(&scope, self.library, &self.lease.job.id)?;
        let (total, first_page, last_page) =
            store.job_evidence_range(&scope, self.library, self.lease)?;
        let old = current.progress;
        let same_stage = old.as_ref().is_some_and(|value| value.phase == stage);
        let progress = kcoder_knowledge::WikiJobProgress {
            phase: stage.into(),
            started_at_ms: old.as_ref().map_or(now, |value| value.started_at_ms),
            phase_started_at_ms: if same_stage {
                old.as_ref().unwrap().phase_started_at_ms
            } else {
                now
            },
            heartbeat_at_ms: old.as_ref().map_or(now, |value| value.heartbeat_at_ms),
            model_progress_at_ms: if old
                .as_ref()
                .is_none_or(|value| value.text_bytes != text || value.reasoning_bytes != reasoning)
                && (text > 0 || reasoning > 0)
            {
                Some(now)
            } else {
                old.as_ref().and_then(|value| value.model_progress_at_ms)
            },
            model: self.inner.model.clone(),
            model_configuration: self.inner.configuration.clone(),
            reasoning_effort: self
                .inner
                .reasoning
                .as_ref()
                .map(|effort| effort.as_str().to_owned()),
            text_bytes: text,
            reasoning_bytes: reasoning,
            through_chunk: old.as_ref().and_then(|value| value.through_chunk),
            total_chunks: Some(total),
            first_page: old
                .as_ref()
                .and_then(|value| value.first_page)
                .or(first_page),
            last_page: old.as_ref().and_then(|value| value.last_page).or(last_page),
            call_limit: budget.call_limit,
            requested_output_tokens: old.as_ref().and_then(|value| value.requested_output_tokens),
            estimated_input_tokens: old.as_ref().and_then(|value| value.estimated_input_tokens),
            reserved_calls: budget.reserved_calls,
            repair_calls: store.job_repair_calls(&scope, self.library, &self.lease.job.id)?,
            usage_reported_calls: budget.usage_reported_calls,
            input_tokens: (budget.usage_reported_calls > 0).then_some(budget.input_tokens),
            output_tokens: (budget.usage_reported_calls > 0).then_some(budget.output_tokens),
        };
        store.update_job_progress(&scope, self.library, self.lease, &progress)
    }
    fn cache_key(&self, input: &kcoder_knowledge::WikiModelRequest) -> Result<String> {
        use sha2::{Digest, Sha256};
        let bytes = serde_json::to_vec(
            &serde_json::json!({"recipe":self.lease.job.recipe_key,"stage":input.stage,"system":input.system,"user":input.user,"maxOutput":input.max_output_tokens}),
        )?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
}

#[cfg(test)]
mod candidate_failure_tests {
    use super::failure_code;
    #[test]
    fn literal_host_candidate_failures_are_specific_without_copying_arbitrary_text() {
        for message in [
            "related page not found",
            "self reference is not a related page",
            "analysis exceeds budget",
            "proposal uses an unreserved overview id",
            "invalid page title",
        ] {
            let error = anyhow::anyhow!(message).context("generation checkpoint validation");
            assert_eq!(failure_code(&error), "invalid_model_output");
        }
        assert_eq!(
            failure_code(&anyhow::anyhow!("PRIVATE_RESPONSE_WITH_unknown_shape")),
            "ingest_failed"
        );
    }
    #[test]
    fn typed_evidence_failure_preserves_public_category_and_budget_priority() {
        use kcoder_types::knowledge::{KnowledgePageDraft, KnowledgePageKind};
        let page = KnowledgePageDraft {
            page_id: uuid::Uuid::new_v4().to_string(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "PRIVATE_TITLE".into(),
            markdown: "PRIVATE_BODY".into(),
            citations: vec![],
            related_page_ids: vec![],
        };
        let error = kcoder_knowledge::validate_generated_changes(
            vec![page],
            &std::collections::BTreeMap::new(),
            &[],
        )
        .err()
        .unwrap();
        assert_eq!(failure_code(&error), "invalid_evidence");
        assert_eq!(
            failure_code(&error.context("Wiki shared repair budget exceeded")),
            "repair_budget_exceeded"
        );
        assert_eq!(
            failure_code(&anyhow::anyhow!("wiki_evidence_quote_span at /quote")),
            "ingest_failed",
            "untyped strings do not gain authority from diagnostic spelling"
        );
    }
    #[test]
    fn typed_commit_relation_bounds_preserve_legacy_public_category() {
        use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
        let page = KnowledgePageDraft {
            page_id: uuid::Uuid::new_v4().to_string(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "Title".into(),
            markdown: "Body".into(),
            citations: vec![KnowledgeCitation {
                source_id: "s".into(),
                revision_id: "r".into(),
                chunk_id: "c".into(),
                quote: "Evidence".into(),
            }],
            related_page_ids: vec!["PRIVATE_TARGET".into(); 129],
        };
        let evidence = kcoder_knowledge::EvidenceChunk {
            source_id: "s".into(),
            revision_id: "r".into(),
            chunk_id: "c".into(),
            text: "Evidence".into(),
        };
        let error = kcoder_knowledge::validate_generated_changes(
            vec![page],
            &std::collections::BTreeMap::new(),
            &[evidence],
        )
        .err()
        .unwrap();
        assert_eq!(
            failure_code(&error),
            failure_code(&anyhow::anyhow!("too many related pages"))
        );
    }
    #[test]
    fn finite_repair_and_revision_evidence_keep_their_existing_categories() {
        assert_eq!(
            failure_code(&anyhow::anyhow!("Wiki shared repair budget exceeded")),
            "repair_budget_exceeded"
        );
        assert_eq!(
            failure_code(&anyhow::anyhow!("revision conflict")),
            "revision_conflict"
        );
        assert_eq!(
            failure_code(&anyhow::anyhow!(
                "invalid source citations after two evidence repairs"
            )),
            "invalid_evidence"
        );
    }
}

#[cfg(test)]
mod source_only_review_tests {
    use super::*;
    use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
    use kcoder_types::{ContentBlock, ContentDelta, Message, MessagesRequest, StreamEvent};
    use serde_json::{Value, json};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[tokio::test]
    async fn impossible_local_reasoning_budget_reserves_no_model_call() -> Result<()> {
        use kcoder_knowledge::WikiModel;
        let dir = tempfile::tempdir()?;
        let settings = dir.path().join("settings.json");
        std::fs::write(&settings, r#"{"knowledge":{"organization_enabled":true}}"#)?;
        let (mut store, scope) = knowledge_requests::open_catalog(&settings)?;
        let library = store.create(&scope, "create", "Wiki", "Keep evidence")?;
        let source = store.import_text(&scope, &library.id, "source", "Evidence", "A fact.")?;
        let job = store.enqueue_ingest(
            &scope,
            &library.id,
            "job",
            &source.source_id,
            &source.revision_id,
            kcoder_knowledge::PREPARATION_VERSION,
            "en",
        )?;
        let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
        let provider = Arc::new(SourceOnlyProvider {
            calls: AtomicUsize::new(0),
            kind: "source",
        });
        let model = ProviderWikiModel {
            provider: provider.clone(),
            model: "fixture".into(),
            max_output_tokens: Some(65536),
            reasoning: Some(kcoder_types::ReasoningEffort::High),
            configuration: None,
        };
        let budgeted = BudgetedModel::new(&settings, &library.id, &lease, &model)?;
        let error = budgeted
            .complete_with_output_limit(
                kcoder_knowledge::WikiModelRequest {
                    stage: "analysis",
                    system: "Inspect evidence".into(),
                    user: "{}".into(),
                    max_output_tokens: 8192,
                },
                2000,
            )
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("output budget cannot fit"));
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
        let budget = store.budget_read(&scope, &library.id, &job.id)?;
        assert_eq!(budget.reserved_calls, 0);
        assert_eq!(budget.completed_calls, 0);
        Ok(())
    }

    struct SourceOnlyProvider {
        calls: AtomicUsize,
        kind: &'static str,
    }
    impl Provider for SourceOnlyProvider {
        fn name(&self) -> &'static str {
            "source-only-review-fixture"
        }
        fn stream_messages(
            &self,
            request: MessagesRequest,
        ) -> Result<ProviderStream, ApiErrorKind> {
            assert!(
                self.calls.fetch_add(1, Ordering::SeqCst) < 2,
                "source-only proposal requests review without another model call"
            );
            let Message::User { content, .. } = &request.messages[0] else {
                panic!("user input required")
            };
            let ContentBlock::Text { text } = &content[0] else {
                panic!("JSON text required")
            };
            let input: Value = serde_json::from_str(text).unwrap();
            let response = if input.get("analysis").is_none() {
                json!({"summary":"Historical source evidence","queries":[],"conflicts":[]})
            } else {
                let source = &input["source"];
                let chunk = &source["chunks"][0];
                json!({"pages":[{"pageId":if self.kind=="overview" {&input["overviewPageId"]} else {&input["newPageIds"][0]},"expectedRevision":null,
                    "kind":self.kind,"title":"Source only", "markdown":"New generalized summary",
                    "citations":[{"sourceId":source["sourceId"],"revisionId":source["revisionId"],
                        "chunkId":chunk["chunkId"],"quote":chunk["text"]}],"relatedPageIds":[]}],"reviewNotes":[]})
            };
            Ok(Box::pin(futures::stream::iter(vec![
                Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: response.to_string(),
                    },
                }),
                Ok(StreamEvent::MessageStop),
            ])))
        }
    }
    #[tokio::test]
    async fn legacy_source_only_preparation_stops_actual_worker_before_commit_with_two_calls()
    -> Result<()> {
        for kind in ["source", "overview"] {
            let dir = tempfile::tempdir()?;
            let settings = dir.path().join("settings.json");
            std::fs::write(&settings, r#"{"knowledge":{"organization_enabled":true}}"#)?;
            let (mut store, scope) = knowledge_requests::open_catalog(&settings)?;
            let library =
                store.create(&scope, "create", "Wiki", "Organize complete scoped facts")?;
            let raw = "Historical 0.3.1: UTF-16 TXT succeeds. GBK TXT rejected. Office XML variants fail.";
            let source =
                store.import_text(&scope, &library.id, "source", "Historical original", raw)?;
            let job = store.enqueue_ingest(
                &scope,
                &library.id,
                "job",
                &source.source_id,
                &source.revision_id,
                kcoder_knowledge::PREPARATION_VERSION,
                "en",
            )?;
            let provider = Arc::new(SourceOnlyProvider {
                calls: AtomicUsize::new(0),
                kind,
            });
            let model = ProviderWikiModel {
                provider: provider.clone(),
                model: "fixture".into(),
                max_output_tokens: Some(65536),
                reasoning: None,
                configuration: None,
            };
            run(
                &settings,
                &library.id,
                &job.id,
                &model,
                65536,
                &CancellationToken::new(),
            )
            .await?;
            let stopped = store.read_job(&scope, &library.id, &job.id)?;
            assert_eq!(stopped.status, "awaiting_review");
            assert_eq!(stopped.error_code.as_deref(), Some("review_required"));
            assert_eq!(stopped.after_chunk, 0);
            let checkpoint = store.job_checkpoint(&scope, &library.id, &job.id)?.unwrap();
            assert_eq!(checkpoint.proposal.review_notes.len(), 1);
            assert!(
                checkpoint.proposal.review_notes[0].contains("no validated purpose/source plan")
            );
            let preserved = checkpoint
                .proposal
                .pages
                .iter()
                .find(|page| page.kind == kcoder_types::knowledge::KnowledgePageKind::Source)
                .unwrap();
            assert_eq!(preserved.markdown, raw);
            assert_eq!(preserved.citations[0].revision_id, source.revision_id);
            assert!(store.list_pages(&scope, &library.id, None, 100)?.is_empty());
            assert!(store.claim_job(&scope, &library.id, &job.id)?.is_none());
            let budget = store.budget_read(&scope, &library.id, &job.id)?;
            assert_eq!(budget.reserved_calls, 2);
            assert_eq!(budget.completed_calls, 2);
            assert_eq!(budget.usage_reported_calls, 0);
            assert_eq!(store.job_repair_calls(&scope, &library.id, &job.id)?, 0);
            assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
        }
        Ok(())
    }
}
