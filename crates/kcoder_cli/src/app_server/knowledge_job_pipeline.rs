//! Bind core-authored nodes to actual host identity and hold the library writer
//! lease through final publication, rather than only through generation.
use super::{BudgetedModel, knowledge_requests};
use anyhow::{Context, Result, ensure};
use kcoder_knowledge::{WikiModelRequest, WikiStageBinding, WikiStageInput, WikiStagePageRevision};
use kcoder_types::wiki_pipeline::{WikiPipelineStageAddress, WikiPipelineStageKind};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Node {
    stage: WikiPipelineStageKind,
    node_id: String,
    unit_key: String,
    #[serde(default)]
    unit_label: Option<String>,
    #[serde(default)]
    unit_index: Option<usize>,
    #[serde(default)]
    total_units: Option<usize>,
    #[serde(default)]
    dependency_hashes: Vec<String>,
    #[serde(default)]
    input_page_revisions: Vec<WikiStagePageRevision>,
}

impl BudgetedModel<'_> {
    pub(super) fn format_cache_requests(
        request: &WikiModelRequest,
    ) -> Result<Vec<WikiModelRequest>> {
        let mut alternatives = request.recent_format_cache_requests()?;
        // The oldest supported spelling must be derived from the released
        // request too, so newer host-format additions do not pollute its key.
        let ancestors = std::iter::once(request)
            .chain(alternatives.iter())
            .map(WikiModelRequest::legacy_format_cache_request)
            .collect::<Result<Vec<_>>>()?;
        for ancestor in ancestors.into_iter().flatten() {
            if !alternatives.iter().any(|prior| {
                prior.stage == ancestor.stage
                    && prior.system == ancestor.system
                    && prior.user == ancestor.user
                    && prior.max_output_tokens == ancestor.max_output_tokens
            }) {
                alternatives.push(ancestor);
            }
        }
        Ok(alternatives)
    }

    pub(super) fn record_source_read(
        &self,
        through: usize,
        first_page: Option<u32>,
        last_page: Option<u32>,
    ) -> Result<()> {
        if !self.pipeline_enabled {
            return Ok(());
        }
        let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
        let chunks = store
            .source_chunks(
                &scope,
                self.library,
                &self.lease.job.source_id,
                &self.lease.job.source_revision,
                self.lease.job.after_chunk,
                8,
            )?
            .into_iter()
            .filter(|chunk| chunk.ordinal <= through)
            .collect::<Vec<_>>();
        ensure!(
            through > self.lease.job.after_chunk
                && chunks.last().is_some_and(|chunk| chunk.ordinal == through)
                && chunks.first().and_then(|chunk| chunk.page) == first_page
                && chunks.last().and_then(|chunk| chunk.page) == last_page,
            "Wiki source read receipt does not match the actual chunk range"
        );
        let receipt = serde_json::to_string(
            &serde_json::json!({"sourceId":self.lease.job.source_id,"sourceRevision":self.lease.job.source_revision,"afterChunk":self.lease.job.after_chunk,"throughChunk":through,"firstPage":first_page,"lastPage":last_page,"chunks":chunks.iter().map(|chunk|serde_json::json!({"chunkId":chunk.chunk_id,"ordinal":chunk.ordinal,"bodyHash":hash(chunk.text.as_bytes())})).collect::<Vec<_>>()}),
        )?;
        let fingerprint = hash(receipt.as_bytes());
        let input = WikiStageInput {
            binding: WikiStageBinding {
                address: WikiPipelineStageAddress {
                    batch: self.lease.job.after_chunk,
                    source_revision: self.lease.job.source_revision.clone(),
                    stage_key: "source-read".into(),
                    stage: WikiPipelineStageKind::Extract,
                    unit_key: "source".into(),
                },
                purpose_hash: self.purpose_hash.clone(),
                recipe_key: self.lease.job.recipe_key.clone(),
                model_fingerprint: self.model_fingerprint.clone(),
                dependency_hashes: vec![],
                input_page_revisions: vec![],
            },
            input_fingerprint: fingerprint,
            unit_label: None,
            unit_index: None,
            total_units: Some(chunks.len()),
        };
        if store
            .stage_validated_output(&scope, self.library, self.lease, &input)?
            .is_none()
        {
            store.stage_begin(&scope, self.library, self.lease, &input)?;
        }
        store.stage_mark_completed(&scope, self.library, self.lease, &input, &receipt)
    }

    pub(super) fn recover_compatible_stage(
        &self,
        request: &WikiModelRequest,
    ) -> Result<Option<WikiStageInput>> {
        let Some(input) = self.stage_input(request)? else {
            return Ok(None);
        };
        let alternatives = Self::format_cache_requests(request)?
            .iter()
            .map(|request| self.stage_input(request))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        if !alternatives.is_empty() {
            let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
            store.stage_rebind_compatible_input(
                &scope,
                self.library,
                self.lease,
                &input,
                &alternatives,
            )?;
        }
        Ok(Some(input))
    }

    pub(super) fn stage_input(&self, request: &WikiModelRequest) -> Result<Option<WikiStageInput>> {
        if !self.pipeline_enabled {
            return Ok(None);
        }
        let body: serde_json::Value =
            serde_json::from_str(&request.user).context("invalid host Wiki pipeline input")?;
        let Some(node) = body.get("pipeline") else {
            return Ok(None);
        };
        let node: Node =
            serde_json::from_value(node.clone()).context("invalid host Wiki pipeline metadata")?;
        let mut semantic = body;
        semantic
            .as_object_mut()
            .context("Wiki pipeline input must be an object")?
            .remove("pipeline");
        let input_fingerprint = hash(&serde_json::to_vec(
            &serde_json::json!({"stage":request.stage,"system":request.system,"user":semantic,"maxOutput":request.max_output_tokens}),
        )?);
        Ok(Some(WikiStageInput {
            binding: WikiStageBinding {
                address: WikiPipelineStageAddress {
                    batch: self.lease.job.after_chunk,
                    source_revision: self.lease.job.source_revision.clone(),
                    stage_key: node.node_id,
                    stage: node.stage,
                    unit_key: node.unit_key,
                },
                purpose_hash: self.purpose_hash.clone(),
                recipe_key: self.lease.job.recipe_key.clone(),
                model_fingerprint: self.model_fingerprint.clone(),
                dependency_hashes: node.dependency_hashes,
                input_page_revisions: node.input_page_revisions,
            },
            input_fingerprint,
            unit_label: node.unit_label,
            unit_index: node.unit_index,
            total_units: node.total_units,
        }))
    }

    pub(super) async fn acquire_merge(&self, cancel: &CancellationToken) -> Result<()> {
        if self
            .merge
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_some()
        {
            return Ok(());
        }
        let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
        let waiting = self.merge_stage_input();
        if self.pipeline_enabled {
            store.stage_begin(&scope, self.library, self.lease, &waiting)?;
            store.stage_mark_waiting(&scope, self.library, self.lease, &waiting)?;
        }
        loop {
            ensure!(
                !cancel.is_cancelled() && knowledge_requests::organization_enabled(self.path)?,
                "Wiki operation cancelled before automatic merge"
            );
            ensure!(
                hash(store.read(&scope, self.library)?.purpose.as_bytes()) == self.purpose_hash,
                "Wiki generation configuration changed"
            );
            if let Some(lease) = store.claim_automatic_merge(&scope, self.library, self.lease)? {
                *self.merge.lock().unwrap_or_else(|error| error.into_inner()) = Some(lease);
                if self.pipeline_enabled {
                    store.stage_mark_completed(
                        &scope,
                        self.library,
                        self.lease,
                        &waiting,
                        "{\"acquired\":true}",
                    )?;
                }
                return Ok(());
            }
            tokio::select! {
                _ = cancel.cancelled() => anyhow::bail!("Wiki job cancelled while waiting for automatic merge"),
                _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {},
            }
        }
    }

    pub(super) fn heartbeat_merge(&self) -> Result<()> {
        let merge = self.merge.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(lease) = merge.as_ref() {
            let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
            store.heartbeat_automatic_merge(&scope, self.library, lease)?;
        }
        Ok(())
    }

    pub(super) fn validate_publication_owner(&self) -> Result<()> {
        let (store, scope) = knowledge_requests::open_catalog(self.path)?;
        ensure!(
            hash(store.read(&scope, self.library)?.purpose.as_bytes()) == self.purpose_hash,
            "Wiki generation configuration changed"
        );
        ensure!(
            self.merge
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_some(),
            "Wiki publication has no automatic merge owner"
        );
        self.heartbeat_merge()
    }

    fn merge_stage_input(&self) -> WikiStageInput {
        WikiStageInput {
            binding: WikiStageBinding {
                address: WikiPipelineStageAddress {
                    batch: self.lease.job.after_chunk,
                    source_revision: self.lease.job.source_revision.clone(),
                    stage_key: "automatic-merge".into(),
                    stage: WikiPipelineStageKind::Retrieve,
                    unit_key: "library".into(),
                },
                purpose_hash: self.purpose_hash.clone(),
                recipe_key: self.lease.job.recipe_key.clone(),
                model_fingerprint: self.model_fingerprint.clone(),
                dependency_hashes: vec![],
                input_page_revisions: vec![],
            },
            input_fingerprint: hash(self.lease.job.recipe_key.as_bytes()),
            unit_label: None,
            unit_index: None,
            total_units: None,
        }
    }

    pub(super) fn commit_stage_input(
        &self,
        checkpoint: &kcoder_knowledge::WikiCheckpoint,
    ) -> Result<WikiStageInput> {
        let fingerprint = hash(&serde_json::to_vec(&checkpoint.proposal)?);
        Ok(WikiStageInput {
            binding: WikiStageBinding {
                address: WikiPipelineStageAddress {
                    batch: self.lease.job.after_chunk,
                    source_revision: self.lease.job.source_revision.clone(),
                    stage_key: "commit".into(),
                    stage: WikiPipelineStageKind::Commit,
                    unit_key: "batch".into(),
                },
                purpose_hash: self.purpose_hash.clone(),
                recipe_key: self.lease.job.recipe_key.clone(),
                model_fingerprint: self.model_fingerprint.clone(),
                dependency_hashes: vec![fingerprint.clone()],
                input_page_revisions: checkpoint
                    .proposal
                    .pages
                    .iter()
                    .filter_map(|page| {
                        page.expected_revision
                            .as_ref()
                            .map(|revision| WikiStagePageRevision {
                                page_id: page.page_id.clone(),
                                revision_id: revision.clone(),
                            })
                    })
                    .collect(),
            },
            input_fingerprint: fingerprint,
            unit_label: None,
            unit_index: None,
            total_units: None,
        })
    }
}

impl Drop for BudgetedModel<'_> {
    fn drop(&mut self) {
        let Some(lease) = self
            .merge
            .get_mut()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        else {
            return;
        };
        let release = knowledge_requests::open_catalog(self.path).and_then(|(mut store, scope)| {
            store.release_automatic_merge(&scope, self.library, &lease)
        });
        if release.is_err() {
            tracing::warn!("Wiki automatic merge cleanup will require lease recovery");
        }
    }
}

pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
    use kcoder_knowledge::WikiModel;
    use kcoder_types::MessagesRequest;
    use serde_json::json;
    use std::sync::Arc;

    struct NoCalls;
    impl Provider for NoCalls {
        fn name(&self) -> &'static str {
            "wiki-host-fixture"
        }
        fn stream_messages(
            &self,
            _: MessagesRequest,
        ) -> std::result::Result<ProviderStream, ApiErrorKind> {
            panic!("checkpoint/merge host tests must not call a model")
        }
    }
    fn model() -> super::super::ProviderWikiModel {
        super::super::ProviderWikiModel {
            provider: Arc::new(NoCalls),
            model: "fixture-model".into(),
            max_output_tokens: Some(8192),
            reasoning: None,
            configuration: None,
        }
    }
    fn fixture() -> Result<(
        tempfile::TempDir,
        std::path::PathBuf,
        String,
        kcoder_knowledge::WikiJobLease,
        kcoder_knowledge::WikiJobLease,
    )> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"knowledge":{"organization_enabled":true}}"#)?;
        let (mut store, scope) = knowledge_requests::open_catalog(&path)?;
        let library = store.create(&scope, "create", "Wiki", "Shared concepts")?;
        let one =
            store.import_text(&scope, &library.id, "one", "One", "First immutable source.")?;
        let two = store.import_text(
            &scope,
            &library.id,
            "two",
            "Two",
            "Second immutable source.",
        )?;
        let first = store.enqueue_ingest(
            &scope,
            &library.id,
            "job-one",
            &one.source_id,
            &one.revision_id,
            "frozen-recipe",
            "zh-CN",
        )?;
        let second = store.enqueue_ingest(
            &scope,
            &library.id,
            "job-two",
            &two.source_id,
            &two.revision_id,
            "frozen-recipe",
            "zh-CN",
        )?;
        let first = store.claim_job(&scope, &library.id, &first.id)?.unwrap();
        let second = store.claim_job(&scope, &library.id, &second.id)?.unwrap();
        Ok((dir, path, library.id, first, second))
    }
    fn request(index: usize, label: &str) -> WikiModelRequest {
        WikiModelRequest { stage: "generation", system: "Host fixture contract".into(), user: json!({"purpose":"Shared concepts","source":{"id":"immutable"},"pipeline":{"stage":"generate","nodeId":"topic/stable","unitKey":"stable","unitLabel":label,"unitIndex":index,"totalUnits":2,"dependencyHashes":[],"inputPageRevisions":[]}}).to_string(), max_output_tokens: 8192 }
    }
    #[test]
    fn host_replays_real_0311_cache_before_begin_without_calling_provider() -> Result<()> {
        fn fixture_request(raw: &str) -> WikiModelRequest {
            let value: serde_json::Value = serde_json::from_str(raw).unwrap();
            WikiModelRequest {
                stage: "generation",
                system: value["system"].as_str().unwrap().into(),
                user: value["user"].as_str().unwrap().into(),
                max_output_tokens: value["maxOutputTokens"].as_u64().unwrap() as u32,
            }
        }
        let old = fixture_request(include_str!(
            "../../../kcoder_knowledge/tests/fixtures/cache_request_0311.json"
        ));
        let current = fixture_request(include_str!(
            "../../../kcoder_knowledge/tests/fixtures/cache_request_current.json"
        ));
        let (_dir, path, library, lease, _) = fixture()?;
        let provider = model();
        let host = BudgetedModel::new(&path, &library, &lease, &provider)?;
        let raw = r#"{"privateRecovery":"complete old response, not publication"}"#;
        host.stage_begin(&old)?;
        host.stage_remember_received(&old, raw)?;
        host.remember_json_response(&old, raw)?;
        assert_eq!(host.cached_json_response(&current)?, Some(raw.into()));
        assert_eq!(host.stage_received_response(&current)?, Some(raw.into()));
        host.stage_begin(&current)?;
        assert_eq!(host.stage_received_response(&current)?, Some(raw.into()));
        host.forget_json_response(&current)?;
        assert!(host.cached_json_response(&old)?.is_none());
        assert!(host.stage_received_response(&current)?.is_none());
        // NoCalls panics on any Provider request. Recovery must not buy a model
        // generation or publish this deliberately non-proposal private input.
        let (store, scope) = knowledge_requests::open_catalog(&path)?;
        assert!(store.list_pages(&scope, &library, None, 20)?.is_empty());
        Ok(())
    }

    #[test]
    fn host_stage_identity_ignores_display_reordering_and_keeps_received_private() -> Result<()> {
        let (_dir, path, library, first, _) = fixture()?;
        let model = model();
        let budgeted = BudgetedModel::new(&path, &library, &first, &model)?;
        assert!(budgeted.supports_staged_topics());
        let original = request(0, "First topic");
        let reordered = request(1, "Renamed display");
        let first_input = budgeted.stage_input(&original)?.unwrap();
        let second_input = budgeted.stage_input(&reordered)?.unwrap();
        assert_eq!(first_input.binding, second_input.binding);
        assert_eq!(
            first_input.input_fingerprint,
            second_input.input_fingerprint
        );
        assert_eq!(first_input.binding.recipe_key, first.job.recipe_key);
        assert_eq!(
            first_input.binding.address.source_revision,
            first.job.source_revision
        );
        budgeted.stage_begin(&original)?;
        budgeted
            .stage_remember_received(&original, "PRIVATE_COMPLETE_MODEL_RESPONSE_WITH_BAD_JSON")?;
        assert_eq!(
            budgeted.stage_received_response(&reordered)?.as_deref(),
            Some("PRIVATE_COMPLETE_MODEL_RESPONSE_WITH_BAD_JSON")
        );
        let (store, scope) = knowledge_requests::open_catalog(&path)?;
        let public = serde_json::to_string(&store.read_job(&scope, &library, &first.job.id)?)?;
        assert!(!public.contains("PRIVATE_COMPLETE_MODEL_RESPONSE"));
        assert!(!public.contains("Host fixture contract"));
        Ok(())
    }
    #[test]
    fn restored_source_range_does_not_reset_a_later_phase_or_model_counts() -> Result<()> {
        let (_dir, path, library, first, _) = fixture()?;
        let model = model();
        let budgeted = BudgetedModel::new(&path, &library, &first, &model)?;
        budgeted.progress("generation", 23, 11)?;
        budgeted.source_range(1, None, None)?;
        let (store, scope) = knowledge_requests::open_catalog(&path)?;
        let job = store.read_job(&scope, &library, &first.job.id)?;
        let progress = job.progress.unwrap();
        assert_eq!(progress.phase, "generation");
        assert_eq!(progress.text_bytes, 23);
        assert_eq!(progress.reasoning_bytes, 11);
        assert_eq!(progress.through_chunk, Some(1));
        let pipeline = job.pipeline.unwrap();
        let read = pipeline
            .records
            .iter()
            .find(|record| record.address.stage == WikiPipelineStageKind::Extract)
            .unwrap();
        assert_eq!(read.address.batch, first.job.after_chunk);
        assert_eq!(read.address.source_revision, first.job.source_revision);
        assert_eq!(
            read.status,
            kcoder_types::wiki_pipeline::WikiPipelineStageStatus::Completed
        );
        assert!(read.artifact_hash.is_some());
        // A later model stage does not regress the completed source read.
        let mut analysis = request(0, "Source analysis");
        analysis.user = json!({"source":{"id":first.job.source_id},"pipeline":{"stage":"analyze","nodeId":"source-analysis","unitKey":"source","dependencyHashes":[],"inputPageRevisions":[]}}).to_string();
        budgeted.stage_begin(&analysis)?;
        let pipeline = store
            .read_job(&scope, &library, &first.job.id)?
            .pipeline
            .unwrap();
        assert_eq!(pipeline.current_stage, Some(WikiPipelineStageKind::Analyze));
        assert!(pipeline.records.iter().any(|record| record.address.stage
            == WikiPipelineStageKind::Extract
            && record.status == kcoder_types::wiki_pipeline::WikiPipelineStageStatus::Completed));
        Ok(())
    }
    #[test]
    fn source_read_receipt_rejects_a_range_without_actual_chunks() -> Result<()> {
        let (_dir, path, library, first, _) = fixture()?;
        let model = model();
        let budgeted = BudgetedModel::new(&path, &library, &first, &model)?;
        assert!(budgeted.source_range(2, None, None).is_err());
        let (store, scope) = knowledge_requests::open_catalog(&path)?;
        let job = store.read_job(&scope, &library, &first.job.id)?;
        assert!(job.progress.is_none());
        assert!(
            job.pipeline
                .is_none_or(|pipeline| pipeline.records.is_empty())
        );
        Ok(())
    }
    #[tokio::test]
    async fn cancellation_before_claim_does_not_pause_a_foreign_job() -> Result<()> {
        let (_dir, path, library, first, _) = fixture()?;
        let model = model();
        let cancel = CancellationToken::new();
        cancel.cancel();
        super::super::run(&path, &library, &first.job.id, &model, 32_768, &cancel).await?;
        let (mut store, scope) = knowledge_requests::open_catalog(&path)?;
        assert_eq!(
            store.read_job(&scope, &library, &first.job.id)?.status,
            "running"
        );
        store.heartbeat_job(&scope, &library, &first)?;
        Ok(())
    }
    #[test]
    fn early_review_without_checkpoint_is_retryable_and_keeps_stage_diagnostics() -> Result<()> {
        let (_dir, path, library, first, _) = fixture()?;
        let model = model();
        let budgeted = BudgetedModel::new(&path, &library, &first, &model)?;
        let planning = request(0, "Topic plan");
        budgeted.stage_begin(&planning)?;
        budgeted.stage_mark_needs_review(
            &planning,
            r#"{"topics":[],"reviewNotes":["PRIVATE_PLANNING_NOTE"]}"#,
            "wiki_topic_plan_requires_review",
            "/reviewNotes",
        )?;
        let (mut store, scope) = knowledge_requests::open_catalog(&path)?;
        super::super::stop_for_review(&mut store, &scope, &library, &first)?;
        let stopped = store.read_job(&scope, &library, &first.job.id)?;
        assert_eq!(stopped.status, "failed");
        assert_eq!(
            stopped.error_code.as_deref(),
            Some("review_required_without_candidate")
        );
        assert!(
            store
                .job_checkpoint(&scope, &library, &first.job.id)?
                .is_none()
        );
        let record = &stopped.pipeline.as_ref().unwrap().records[0];
        assert_eq!(
            record.status,
            kcoder_types::wiki_pipeline::WikiPipelineStageStatus::NeedsReview
        );
        assert_eq!(
            record.error_code.as_deref(),
            Some("wiki_topic_plan_requires_review")
        );
        assert!(!serde_json::to_string(&stopped)?.contains("PRIVATE_PLANNING_NOTE"));
        store.resume_job(&scope, &library, &first.job.id)?;
        assert_eq!(
            store.read_job(&scope, &library, &first.job.id)?.status,
            "queued"
        );
        let resumed = store.claim_job(&scope, &library, &first.job.id)?.unwrap();
        store.heartbeat_job(&scope, &library, &resumed)?;
        assert!(store.heartbeat_job(&scope, &library, &first).is_err());
        assert!(store.list_pages(&scope, &library, None, 100)?.is_empty());
        let chunk = store
            .source_chunks(
                &scope,
                &library,
                &first.job.source_id,
                &first.job.source_revision,
                0,
                1,
            )?
            .remove(0);
        store.save_job_checkpoint(
            &scope,
            &library,
            &resumed,
            &kcoder_knowledge::WikiCheckpoint {
                through_chunk: 1,
                has_more_chunks: false,
                proposal: kcoder_knowledge::WikiProposal {
                    pages: vec![kcoder_types::knowledge::KnowledgePageDraft {
                        page_id: uuid::Uuid::new_v4().to_string(),
                        expected_revision: None,
                        kind: kcoder_types::knowledge::KnowledgePageKind::Concept,
                        title: "Source concept".into(),
                        markdown: chunk.text.clone(),
                        citations: vec![kcoder_types::knowledge::KnowledgeCitation {
                            source_id: first.job.source_id.clone(),
                            revision_id: first.job.source_revision.clone(),
                            chunk_id: chunk.chunk_id,
                            quote: chunk.text,
                        }],
                        related_page_ids: vec![],
                    }],
                    review_notes: vec!["Needs human confirmation".into()],
                    advisory_notes: vec![],
                    organization_proof: None,
                },
            },
        )?;
        super::super::stop_for_review(&mut store, &scope, &library, &resumed)?;
        let prepared = store.read_job(&scope, &library, &first.job.id)?;
        assert_eq!(prepared.status, "awaiting_review");
        assert_eq!(prepared.review_available, Some(true));
        assert_eq!(prepared.error_code.as_deref(), Some("review_required"));
        assert_eq!(
            store
                .pending_review(&scope, &library, &first.job.id)?
                .pages
                .len(),
            1
        );
        assert!(store.list_pages(&scope, &library, None, 100)?.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn automatic_merge_is_held_after_preparation_and_released_by_owner_drop() -> Result<()> {
        let (_dir, path, library, first, second) = fixture()?;
        let model = model();
        let owner = BudgetedModel::new(&path, &library, &first, &model)?;
        let other = BudgetedModel::new(&path, &library, &second, &model)?;
        owner.acquire_merge(&CancellationToken::new()).await?;
        // Model preparation returning does not drop the attempt-level owner.
        owner.heartbeat_merge()?;
        let cancel = CancellationToken::new();
        let mut waiting = Box::pin(other.acquire_merge(&cancel));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut waiting)
                .await
                .is_err()
        );
        drop(owner);
        tokio::time::timeout(std::time::Duration::from_secs(1), waiting).await??;
        other.heartbeat_merge()?;
        Ok(())
    }
    #[tokio::test]
    async fn human_edit_remains_possible_under_merge_lease_and_old_proposal_fails_cas() -> Result<()>
    {
        use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
        let (_dir, path, library, first, _) = fixture()?;
        let model = model();
        let owner = BudgetedModel::new(&path, &library, &first, &model)?;
        owner.acquire_merge(&CancellationToken::new()).await?;
        let (mut store, scope) = knowledge_requests::open_catalog(&path)?;
        let chunk = store
            .source_chunks(
                &scope,
                &library,
                &first.job.source_id,
                &first.job.source_revision,
                0,
                1,
            )?
            .remove(0);
        let page = KnowledgePageDraft {
            page_id: uuid::Uuid::new_v4().to_string(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "Concept".into(),
            markdown: chunk.text.clone(),
            citations: vec![KnowledgeCitation {
                source_id: first.job.source_id.clone(),
                revision_id: first.job.source_revision.clone(),
                chunk_id: chunk.chunk_id,
                quote: chunk.text,
            }],
            related_page_ids: vec![],
        };
        let initial = store
            .commit_generated_pages(&scope, &library, "initial-human-page", vec![page.clone()])?
            .remove(0);
        let human = store.edit_page(
            &scope,
            &library,
            &page.page_id,
            &initial.revision_id,
            "human-edit",
            "Human concept",
            "Human preserved addition",
        )?;
        let mut old_candidate = page;
        old_candidate.expected_revision = Some(initial.revision_id);
        let checkpoint = kcoder_knowledge::WikiCheckpoint {
            through_chunk: 1,
            has_more_chunks: false,
            proposal: kcoder_knowledge::WikiProposal {
                pages: vec![old_candidate],
                review_notes: vec![],
                advisory_notes: vec![],
                organization_proof: None,
            },
        };
        store.save_job_checkpoint(&scope, &library, &first, &checkpoint)?;
        assert!(
            store
                .commit_job_checkpoint(&scope, &library, &first)
                .unwrap_err()
                .to_string()
                .contains("revision conflict")
        );
        let current = store.read_page(&scope, &library, &human.page_id, None)?;
        assert_eq!(current.revision_id, human.revision_id);
        assert_eq!(current.draft.markdown, "Human preserved addition");
        owner.heartbeat_merge()?;
        Ok(())
    }

    #[tokio::test]
    async fn cancelling_one_waiter_never_releases_the_live_library_owner() -> Result<()> {
        let (_dir, path, library, first, second) = fixture()?;
        let model = model();
        let owner = BudgetedModel::new(&path, &library, &first, &model)?;
        let other = BudgetedModel::new(&path, &library, &second, &model)?;
        owner.acquire_merge(&CancellationToken::new()).await?;
        let cancel = CancellationToken::new();
        let mut waiting = Box::pin(other.acquire_merge(&cancel));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut waiting)
                .await
                .is_err()
        );
        cancel.cancel();
        assert!(waiting.await.is_err());
        drop(other);
        owner.heartbeat_merge()?;
        Ok(())
    }
}
