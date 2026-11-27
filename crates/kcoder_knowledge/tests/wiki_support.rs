//! Deterministic lifecycle tests; fixture verdicts are not semantic-quality evidence.
#[path = "fixtures/organization.rs"]
mod organization_fixture;
use anyhow::Result;
use async_trait::async_trait;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, WikiAnalysis, WikiCheckpoint, WikiIngestRequest,
    WikiJobLease, WikiModel, WikiModelRequest, WikiProposal,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

struct Fixture {
    path: PathBuf,
    scope: KnowledgeScope,
    library: String,
    lease: WikiJobLease,
    calls: Arc<Mutex<Vec<String>>>,
    verdict: &'static str,
    coverage: &'static str,
    malformed: bool,
    selected_indices: Option<Vec<usize>>,
    missing_unit: bool,
    duplicate_unit: bool,
    interrupt: AtomicBool,
    cancellation: Option<CancellationToken>,
}
impl Fixture {
    fn key(&self, request: &WikiModelRequest) -> String {
        format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "{}\0{}\0{}\0{}\0{}",
                    self.lease.job.recipe_key,
                    request.stage,
                    request.system,
                    request.user,
                    request.max_output_tokens
                )
                .as_bytes()
            )
        )
    }
}
#[async_trait]
impl WikiModel for Fixture {
    async fn complete_with_output_limit(
        &self,
        mut request: WikiModelRequest,
        limit: u32,
    ) -> Result<String> {
        assert_eq!(
            request.max_output_tokens,
            kcoder_types::DEFAULT_MODEL_OUTPUT_TOKENS
        );
        // Cache the host request identity, before the transport/context clamp.
        if request.stage == "analysis"
            && let Some(cached) = KnowledgeCatalog::open(&self.path)?.cached_analysis(
                &self.scope,
                &self.library,
                &self.lease,
                &self.key(&request),
            )?
        {
            return Ok(cached);
        }
        request.max_output_tokens = request.max_output_tokens.min(limit);
        self.complete(request).await
    }
    fn remaining_shared_repairs(&self) -> Result<u32> {
        let store = KnowledgeCatalog::open(&self.path)?;
        Ok(3u32.saturating_sub(store.job_batch_repair_calls(
            &self.scope,
            &self.library,
            &self.lease,
        )?))
    }
    fn cached_proposal(&self, request: &WikiModelRequest) -> Result<Option<WikiProposal>> {
        KnowledgeCatalog::open(&self.path)?.cached_proposal(
            &self.scope,
            &self.library,
            &self.lease,
            &self.key(request),
        )
    }
    fn remember_proposal(&self, request: &WikiModelRequest, proposal: &WikiProposal) -> Result<()> {
        KnowledgeCatalog::open(&self.path)?.remember_proposal(
            &self.scope,
            &self.library,
            &self.lease,
            &self.key(request),
            proposal,
        )?;
        let input: Value = serde_json::from_str(&request.user)?;
        if input["repairKind"] == "source_support" && self.interrupt.swap(false, Ordering::SeqCst) {
            anyhow::bail!("simulated interruption after completed assessment");
        }
        Ok(())
    }
    fn remember_analysis(&self, request: &WikiModelRequest, analysis: &WikiAnalysis) -> Result<()> {
        KnowledgeCatalog::open(&self.path)?.remember_analysis(
            &self.scope,
            &self.library,
            &self.lease,
            &self.key(request),
            analysis,
        )
    }
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        let mut store = KnowledgeCatalog::open(&self.path)?;
        if request.stage == "analysis"
            && let Some(cached) = store.cached_analysis(
                &self.scope,
                &self.library,
                &self.lease,
                &self.key(&request),
            )?
        {
            return Ok(cached);
        }
        let call = store
            .budget_reserve_for_stage(
                &self.scope,
                &self.library,
                &self.lease,
                64,
                request.stage,
                None,
            )?
            .unwrap();
        self.calls.lock().unwrap().push(request.stage.into());
        let input: Value = serde_json::from_str(&request.user)?;
        let response = if request.stage == "analysis" {
            organization_fixture::with_plan(
                &input,
                json!({"summary":"historical evidence","queries":[],"conflicts":[]}),
            )
            .to_string()
        } else if input["repairKind"] == "source_support" {
            assert_eq!(request.stage, "source_support");
            assert_eq!(
                request.max_output_tokens as usize + self.estimate_input_tokens(&request),
                64_000,
                "effective output remains within the explicit context ceiling"
            );
            assert!(
                input["units"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|unit| unit["text"].as_str().unwrap().contains("unified rejection"))
            );
            for page in input["candidate"]["pages"].as_array().unwrap() {
                assert!(
                    page.get("citations").is_none(),
                    "citation content belongs only in bindings"
                );
                let binding = input["citationBindings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["pageId"] == page["pageId"])
                    .unwrap();
                for (index, citation) in binding["citations"].as_array().unwrap().iter().enumerate()
                {
                    assert_eq!(citation["index"], index);
                    assert_eq!(citation["sourceId"], self.lease.job.source_id);
                    assert_eq!(citation["revisionId"], self.lease.job.source_revision);
                    assert!(!citation["quote"].as_str().unwrap().is_empty());
                }
            }
            for unit in input["units"].as_array().unwrap() {
                let binding = input["citationBindings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["pageId"] == unit["pageId"])
                    .unwrap();
                assert_eq!(
                    unit["allowedCitationIndices"],
                    json!((0..binding["citations"].as_array().unwrap().len()).collect::<Vec<_>>())
                );
            }
            assert!(request.system.contains("ZERO-BASED"));
            assert!(
                request
                    .system
                    .contains("exact named subject, component, task/dataset and period")
            );
            if let Some(cancel) = &self.cancellation {
                cancel.cancel();
            }
            if self.malformed {
                "{}".into()
            } else {
                let mut report = input["units"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|unit| {
                        json!({"pageId":unit["pageId"],"unit":unit["unit"],"verdict":self.verdict,
                        "citationIndices":self.selected_indices.clone().unwrap_or_else(||vec![0])})
                    })
                    .collect::<Vec<_>>();
                if self.missing_unit {
                    report.pop();
                }
                if self.duplicate_unit {
                    report[1] = report[0].clone();
                }
                organization_fixture::with_organization_support(
                    &input,
                    json!({"sourceCoverage":self.coverage,"units":report}),
                )
                .to_string()
            }
        } else {
            let source = &input["source"];
            let chunk = &source["chunks"][0];
            organization_fixture::with_proof(&input,json!({"pages":[{"pageId":input["newPageIds"][0],"expectedRevision":null,
                "kind":"concept","title":"Historical formats", "markdown":"The examples establish a unified rejection mechanism for non-UTF encodings, including UTF-16.",
                "citations":[{"sourceId":source["sourceId"],"revisionId":source["revisionId"],"chunkId":chunk["chunkId"],"quote":chunk["text"]}],"relatedPageIds":[]}],"reviewNotes":[]})).to_string()
        };
        store.budget_record_usage(&self.scope, &self.library, &call, None)?;
        Ok(response)
    }
}
fn setup(verdict: &'static str) -> Result<(tempfile::TempDir, KnowledgeCatalog, Fixture)> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("wiki.sqlite");
    let mut store = KnowledgeCatalog::open(&path)?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "target")?;
    let library = store.create(&scope, "create", "Wiki", "")?;
    let source=store.import_text(&scope,&library.id,"source","Historical 0.3.1",
        "Historical 0.3.1: UTF-16 TXT succeeds. GBK TXT rejected. Office UTF-16 XML variants rejected.")?;
    let job = store.enqueue_ingest(
        &scope,
        &library.id,
        "job",
        &source.source_id,
        &source.revision_id,
        "support-v1",
        "en",
    )?;
    let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    Ok((
        dir,
        store,
        Fixture {
            path,
            scope,
            library: library.id,
            lease,
            calls: Arc::new(Mutex::new(vec![])),
            verdict,
            coverage: "complete",
            malformed: false,
            selected_indices: None,
            missing_unit: false,
            duplicate_unit: false,
            interrupt: AtomicBool::new(false),
            cancellation: None,
        },
    ))
}
fn input(model: &Fixture) -> WikiIngestRequest<'_> {
    WikiIngestRequest {
        library_id: &model.library,
        source_id: &model.lease.job.source_id,
        source_revision: &model.lease.job.source_revision,
        after_chunk: 0,
        output_language: "en",
        context_tokens: 64_000,
    }
}
#[tokio::test]
async fn uncertain_and_unsupported_require_review_with_exact_evidence_and_unknown_usage()
-> Result<()> {
    for verdict in ["unsupported", "uncertain"] {
        let (_dir, mut store, model) = setup(verdict)?;
        let prepared = store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new(),
            )
            .await?;
        assert_eq!(
            *model.calls.lock().unwrap(),
            vec!["analysis", "generation", "source_support"]
        );
        assert_eq!(prepared.proposal.review_notes.len(), 1);
        assert!(prepared.proposal.review_notes[0].contains("Source support requires review"));
        assert!(
            prepared.proposal.pages[0]
                .markdown
                .contains("unified rejection")
        );
        let checkpoint = WikiCheckpoint {
            through_chunk: prepared.through_chunk,
            has_more_chunks: prepared.has_more_chunks,
            proposal: prepared.proposal,
        };
        store.save_job_checkpoint(&model.scope, &model.library, &model.lease, &checkpoint)?;
        // Mirror the worker's existing blocking-note gate before publication.
        store.stop_job_with_reason(
            &model.scope,
            &model.library,
            &model.lease,
            "awaiting_review",
            "review_required",
        )?;
        assert_eq!(
            store
                .read_job(&model.scope, &model.library, &model.lease.job.id)?
                .status,
            "awaiting_review"
        );
        assert!(
            store
                .commit_job_checkpoint(&model.scope, &model.library, &model.lease)
                .is_err()
        );
        assert!(
            store
                .list_pages(&model.scope, &model.library, None, 100)?
                .is_empty()
        );
        let budget = store.budget_read(&model.scope, &model.library, &model.lease.job.id)?;
        assert_eq!(budget.reserved_calls, 3);
        assert_eq!(budget.usage_reported_calls, 0);
        assert_eq!(
            store.job_repair_calls(&model.scope, &model.library, &model.lease.job.id)?,
            0
        );
    }
    Ok(())
}
#[tokio::test]
async fn completed_assessment_replays_without_a_new_call_after_interruption() -> Result<()> {
    let (_dir, mut store, mut model) = setup("uncertain")?;
    model.interrupt = AtomicBool::new(true);
    assert!(
        store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(model.calls.lock().unwrap().len(), 3);
    store.pause_job(&model.scope, &model.library, &model.lease.job.id)?;
    store.resume_job(&model.scope, &model.library, &model.lease.job.id)?;
    model.lease = store
        .claim_job(&model.scope, &model.library, &model.lease.job.id)?
        .unwrap();
    let restored = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert_eq!(model.calls.lock().unwrap().len(), 3);
    assert_eq!(restored.proposal.review_notes.len(), 1);
    assert!(
        store
            .list_pages(&model.scope, &model.library, None, 100)?
            .is_empty()
    );
    Ok(())
}
#[tokio::test]
async fn malformed_or_cancelled_assessment_cannot_be_published_or_repaired_without_bound()
-> Result<()> {
    for cancelled in [false, true] {
        let (_dir, mut store, mut model) = setup("supported")?;
        let cancel = CancellationToken::new();
        if cancelled {
            model.cancellation = Some(cancel.clone());
        } else {
            model.malformed = true;
        }
        let error = store
            .prepare_wiki_update(&model.scope, input(&model), &model, &cancel)
            .await
            .err()
            .unwrap();
        if !cancelled {
            assert_eq!(
                KnowledgeCatalog::candidate_failure_code(&error),
                Some("wiki_support_schema")
            );
        }
        assert_eq!(model.calls.lock().unwrap().len(), 3);
        assert!(
            store
                .list_pages(&model.scope, &model.library, None, 100)?
                .is_empty()
        );
    }
    Ok(())
}

#[tokio::test]
async fn incomplete_organization_requires_review_even_when_individual_claims_are_supported()
-> Result<()> {
    for coverage in ["incomplete", "uncertain"] {
        let (_dir, mut store, mut model) = setup("supported")?;
        model.coverage = coverage;
        let prepared = store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new(),
            )
            .await?;
        assert_eq!(model.calls.lock().unwrap().len(), 3);
        assert!(
            prepared
                .proposal
                .review_notes
                .iter()
                .any(|note| note.contains("Source coverage requires review"))
        );
        assert!(
            store
                .list_pages(&model.scope, &model.library, None, 100)?
                .is_empty()
        );
    }
    Ok(())
}
#[tokio::test]
async fn normal_source_verification_keeps_its_real_call_budget_after_format_repairs_are_exhausted()
-> Result<()> {
    let (_dir, mut store, model) = setup("supported")?;
    for _ in 0..3 {
        let reservation = store
            .budget_reserve_for_stage(
                &model.scope,
                &model.library,
                &model.lease,
                64,
                "format_repair",
                None,
            )?
            .unwrap();
        store.budget_record_usage(&model.scope, &model.library, &reservation, None)?;
    }
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    assert_eq!(
        *model.calls.lock().unwrap(),
        vec!["analysis", "generation", "source_support"]
    );
    assert_eq!(
        store
            .budget_read(&model.scope, &model.library, &model.lease.job.id)?
            .reserved_calls,
        6
    );
    assert_eq!(
        store.job_repair_calls(&model.scope, &model.library, &model.lease.job.id)?,
        3
    );
    assert!(
        store
            .list_pages(&model.scope, &model.library, None, 100)?
            .is_empty()
    );
    Ok(())
}

#[tokio::test]
async fn well_shaped_missing_out_of_range_and_excessive_support_route_to_private_review()
-> Result<()> {
    for (indices, code) in [
        (vec![], "wiki_support_evidence_missing"),
        (vec![0, 999], "wiki_support_evidence_out_of_range"),
        (vec![0; 9], "wiki_support_evidence_too_many"),
    ] {
        let (_dir, mut store, mut model) = setup("supported")?;
        model.selected_indices = Some(indices);
        let prepared = store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new(),
            )
            .await?;
        assert_eq!(
            *model.calls.lock().unwrap(),
            vec!["analysis", "generation", "source_support"]
        );
        assert!(
            prepared
                .proposal
                .review_notes
                .iter()
                .any(|note| note.contains(code) && note.contains("/units/"))
        );
        assert!(
            prepared.proposal.pages[0]
                .markdown
                .contains("unified rejection")
        );
        assert_eq!(prepared.proposal.pages[0].citations.len(), 1);
        assert_eq!(
            prepared.proposal.pages[0].citations[0].quote,
            "Historical 0.3.1: UTF-16 TXT succeeds. GBK TXT rejected. Office UTF-16 XML variants rejected."
        );
        store.save_job_checkpoint(
            &model.scope,
            &model.library,
            &model.lease,
            &WikiCheckpoint {
                through_chunk: prepared.through_chunk,
                has_more_chunks: prepared.has_more_chunks,
                proposal: prepared.proposal,
            },
        )?;
        store.stop_job_with_reason(
            &model.scope,
            &model.library,
            &model.lease,
            "awaiting_review",
            "review_required",
        )?;
        assert!(
            store
                .commit_job_checkpoint(&model.scope, &model.library, &model.lease)
                .is_err()
        );
        assert_eq!(
            store
                .read_job(&model.scope, &model.library, &model.lease.job.id)?
                .status,
            "awaiting_review"
        );
        assert!(
            store
                .list_pages(&model.scope, &model.library, None, 100)?
                .is_empty()
        );
        assert_eq!(
            store
                .budget_read(&model.scope, &model.library, &model.lease.job.id)?
                .reserved_calls,
            3
        );
        assert_eq!(
            store.job_repair_calls(&model.scope, &model.library, &model.lease.job.id)?,
            0
        );
    }
    Ok(())
}
#[tokio::test]
async fn missing_and_duplicate_report_units_still_fail_without_assessment_retry() -> Result<()> {
    for duplicate in [false, true] {
        let (_dir, mut store, mut model) = setup("supported")?;
        model.missing_unit = !duplicate;
        model.duplicate_unit = duplicate;
        let error = store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new(),
            )
            .await
            .err()
            .unwrap();
        assert_eq!(
            KnowledgeCatalog::candidate_failure_code(&error),
            Some("wiki_support_coverage")
        );
        assert_eq!(model.calls.lock().unwrap().len(), 3);
        assert!(
            store
                .job_checkpoint(&model.scope, &model.library, &model.lease.job.id)?
                .is_none()
        );
        assert!(
            store
                .list_pages(&model.scope, &model.library, None, 100)?
                .is_empty()
        );
    }
    Ok(())
}
#[tokio::test]
async fn evidence_review_cache_replays_with_original_content_and_no_new_call() -> Result<()> {
    let (_dir, mut store, mut model) = setup("supported")?;
    model.selected_indices = Some(vec![999]);
    model.interrupt = AtomicBool::new(true);
    assert!(
        store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(model.calls.lock().unwrap().len(), 3);
    store.pause_job(&model.scope, &model.library, &model.lease.job.id)?;
    store.resume_job(&model.scope, &model.library, &model.lease.job.id)?;
    model.lease = store
        .claim_job(&model.scope, &model.library, &model.lease.job.id)?
        .unwrap();
    let restored = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert_eq!(model.calls.lock().unwrap().len(), 3);
    assert!(
        restored
            .proposal
            .review_notes
            .iter()
            .any(|note| note.contains("wiki_support_evidence_out_of_range"))
    );
    assert!(
        restored.proposal.pages[0]
            .markdown
            .contains("unified rejection")
    );
    assert_eq!(restored.proposal.pages[0].citations.len(), 1);
    assert!(
        store
            .list_pages(&model.scope, &model.library, None, 100)?
            .is_empty()
    );
    Ok(())
}
