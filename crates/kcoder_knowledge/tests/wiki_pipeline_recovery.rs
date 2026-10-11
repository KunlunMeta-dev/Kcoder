//! Owned model fixtures against the real durable stage store. These exercise
//! recovery and reject missing/unsupported facts; they are not model benchmarks.
use anyhow::{Result, anyhow};
use async_trait::async_trait;
use kcoder_knowledge::*;
use kcoder_types::{knowledge::*, wiki_pipeline::*};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

const SOURCE: &str =
    "Storage R1 uses port 8192.\n\nTelemetry R2 only uses module B in its test scope.\n";
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn cache_key(request: &WikiModelRequest) -> Result<String> {
    Ok(hash(
        serde_json::to_string(&json!({"stage":request.stage,"system":request.system,
        "user":request.user,"maxOutput":request.max_output_tokens}))?
        .as_bytes(),
    ))
}

struct Fixture {
    invalid_kind: AtomicBool,
    invalid_plan: AtomicBool,
    invalid_repairs: AtomicBool,
    path: PathBuf,
    scope: KnowledgeScope,
    library: String,
    source: SourceRevision,
    purpose: String,
    lease: Mutex<WikiJobLease>,
    calls: Mutex<Vec<String>>,
    crash_received: AtomicBool,
    bad_analysis: bool,
    fail_second: AtomicBool,
    fail_coverage: AtomicBool,
    missing_fact: bool,
    advisory: bool,
    blocking_plan: bool,
    repair_failure: AtomicBool,
    truncate_second: AtomicBool,
    crash_node: Mutex<Option<String>>,
    merge_calls: Mutex<usize>,
}
impl Fixture {
    fn stage(&self, request: &WikiModelRequest, lease: &WikiJobLease) -> Result<WikiStageInput> {
        let mut body: Value = serde_json::from_str(&request.user)?;
        let metadata = body.as_object_mut().unwrap().remove("pipeline").unwrap();
        Ok(WikiStageInput {
            binding: WikiStageBinding {
                address: WikiPipelineStageAddress {
                    batch: lease.job.after_chunk,
                    source_revision: lease.job.source_revision.clone(),
                    stage_key: metadata["nodeId"].as_str().unwrap().into(),
                    stage: serde_json::from_value(metadata["stage"].clone())?,
                    unit_key: metadata["unitKey"].as_str().unwrap().into(),
                },
                purpose_hash: hash(self.purpose.as_bytes()),
                recipe_key: lease.job.recipe_key.clone(),
                model_fingerprint: "9".repeat(64),
                dependency_hashes: serde_json::from_value(metadata["dependencyHashes"].clone())?,
                input_page_revisions: serde_json::from_value(
                    metadata["inputPageRevisions"].clone(),
                )?,
            },
            input_fingerprint: hash(&serde_json::to_vec(
                &json!({"stage":request.stage,"system":request.system,
                "user":body,"maxOutput":request.max_output_tokens}),
            )?),
            unit_label: metadata["unitLabel"].as_str().map(str::to_owned),
            unit_index: metadata["unitIndex"].as_u64().map(|v| v as usize),
            total_units: metadata["totalUnits"].as_u64().map(|v| v as usize),
        })
    }
    fn store<T>(
        &self,
        request: &WikiModelRequest,
        action: impl FnOnce(&mut KnowledgeCatalog, &WikiJobLease, &WikiStageInput) -> Result<T>,
    ) -> Result<T> {
        let lease = self.lease.lock().unwrap();
        let input = self.stage(request, &lease)?;
        action(&mut KnowledgeCatalog::open(&self.path)?, &lease, &input).map_err(|error| {
            error.context(format!("owned stage {}", input.binding.address.stage_key))
        })
    }
    fn analysis(&self, input: &Value) -> Value {
        let inventory = &input["sourceInventory"];
        json!({"summary":"Storage and telemetry retain distinct subject and scope","queries":["Storage","Telemetry"],
            "organizationPlan":{"units":inventory["units"].as_array().unwrap().iter().map(|unit|
                json!({"unitId":unit["id"],"disposition":"required"})).collect::<Vec<_>>()}})
    }
    fn input(&self) -> WikiIngestRequest<'_> {
        WikiIngestRequest {
            library_id: &self.library,
            source_id: &self.source.source_id,
            source_revision: &self.source.revision_id,
            after_chunk: 0,
            output_language: "en",
            context_tokens: 64000,
        }
    }
    fn resume(&self, store: &mut KnowledgeCatalog) -> Result<()> {
        let mut lease = self.lease.lock().unwrap();
        let id = lease.job.id.clone();
        store.stop_job_with_reason(
            &self.scope,
            &self.library,
            &lease,
            "failed",
            "provider_error",
        )?;
        store.resume_job(&self.scope, &self.library, &id)?;
        *lease = store.claim_job(&self.scope, &self.library, &id)?.unwrap();
        Ok(())
    }
}

#[async_trait]
impl WikiModel for Fixture {
    fn supports_staged_topics(&self) -> bool {
        true
    }
    fn batch_identity(&self) -> String {
        let lease = self.lease.lock().unwrap();
        format!("{}:{}", lease.job.id, lease.job.recipe_key)
    }
    async fn acquire_merge_slot(&self, _: &CancellationToken) -> Result<()> {
        *self.merge_calls.lock().unwrap() += 1;
        Ok(())
    }
    fn stage_begin(&self, request: &WikiModelRequest) -> Result<()> {
        self.store(request, |store, lease, input| {
            store
                .stage_begin(&self.scope, &self.library, lease, input)
                .map(|_| ())
        })
    }
    fn stage_received_response(&self, request: &WikiModelRequest) -> Result<Option<String>> {
        self.store(request, |store, lease, input| {
            store.stage_received_response(&self.scope, &self.library, lease, input)
        })
    }
    fn stage_remember_received(&self, request: &WikiModelRequest, raw: &str) -> Result<()> {
        self.store(request, |store, lease, input| {
            store.stage_remember_received(&self.scope, &self.library, lease, input, raw)
        })?;
        if request.stage == "analysis" && self.crash_received.swap(false, Ordering::SeqCst) {
            anyhow::bail!("owned interruption after durable received, before JSON parsing");
        }
        let node: Value = serde_json::from_str(&request.user)?;
        let mut crash = self.crash_node.lock().unwrap();
        if crash
            .as_deref()
            .zip(node["pipeline"]["nodeId"].as_str())
            .is_some_and(|(suffix, node)| node.ends_with(suffix))
        {
            *crash = None;
            anyhow::bail!("owned interruption after durable child response");
        }
        Ok(())
    }
    fn stage_validated_output(&self, request: &WikiModelRequest) -> Result<Option<String>> {
        self.store(request, |store, lease, input| {
            store.stage_validated_output(&self.scope, &self.library, lease, input)
        })
    }
    fn stage_mark_validated(&self, request: &WikiModelRequest, raw: &str) -> Result<()> {
        self.store(request, |store, lease, input| {
            store.stage_mark_validated(&self.scope, &self.library, lease, input, raw)
        })
        .map_err(|error| error.context("mark validated"))
    }
    fn stage_mark_completed(&self, request: &WikiModelRequest, raw: &str) -> Result<()> {
        self.store(request, |store, lease, input| {
            store.stage_mark_completed(&self.scope, &self.library, lease, input, raw)
        })
    }
    fn stage_mark_failed(&self, request: &WikiModelRequest, code: &str, field: &str) -> Result<()> {
        self.store(request, |store, lease, input| {
            store.stage_mark_failed(&self.scope, &self.library, lease, input, code, field)
        })
        .map_err(|error| error.context("mark failed"))
    }
    fn stage_mark_needs_review(
        &self,
        request: &WikiModelRequest,
        raw: &str,
        code: &str,
        field: &str,
    ) -> Result<()> {
        self.store(request, |store, lease, input| {
            store.stage_mark_needs_review(
                &self.scope,
                &self.library,
                lease,
                input,
                raw,
                code,
                field,
            )
        })
    }
    fn cached_proposal(&self, request: &WikiModelRequest) -> Result<Option<WikiProposal>> {
        Ok(self
            .stage_validated_output(request)?
            .and_then(|raw| serde_json::from_str(&raw).ok()))
    }
    fn cached_json_response(&self, request: &WikiModelRequest) -> Result<Option<String>> {
        let lease = self.lease.lock().unwrap();
        KnowledgeCatalog::open(&self.path)?.cached_json_response(
            &self.scope,
            &self.library,
            &lease,
            &cache_key(request)?,
        )
    }
    fn remember_json_response(&self, request: &WikiModelRequest, raw: &str) -> Result<()> {
        let lease = self.lease.lock().unwrap();
        KnowledgeCatalog::open(&self.path)?.remember_json_response(
            &self.scope,
            &self.library,
            &lease,
            &cache_key(request)?,
            raw,
        )
    }
    fn forget_json_response(&self, request: &WikiModelRequest) -> Result<()> {
        self.store(request, |store, lease, input| {
            store.stage_invalidate_artifacts(&self.scope, &self.library, lease, input)?;
            store.forget_json_response(&self.scope, &self.library, lease, &cache_key(request)?)
        })
    }
    fn remaining_shared_repairs(&self) -> Result<u32> {
        let lease = self.lease.lock().unwrap();
        Ok(
            3u32.saturating_sub(KnowledgeCatalog::open(&self.path)?.job_batch_repair_calls(
                &self.scope,
                &self.library,
                &lease,
            )?),
        )
    }
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        let mut input: Value = serde_json::from_str(&request.user)?;
        let node = input["pipeline"]["nodeId"].as_str().unwrap().to_owned();
        self.calls.lock().unwrap().push(node.clone());
        let lease = self.lease.lock().unwrap();
        let mut store = KnowledgeCatalog::open(&self.path)?;
        let reservation = store
            .budget_reserve_for_stage(&self.scope, &self.library, &lease, 64, request.stage, None)?
            .unwrap();
        let result = (|| -> Result<String> {
            if request.stage == "analysis" {
                assert!(
                    input["wiki"].get("hasPages").is_none(),
                    "mutable library state cannot enter source analysis"
                );
                return Ok(if self.bad_analysis {
                    "fully terminated response with invalid JSON".into()
                } else {
                    self.analysis(&input).to_string()
                });
            }
            if request.stage == "format_repair" {
                if self.repair_failure.swap(false, Ordering::SeqCst) {
                    anyhow::bail!("owned repair transport failure");
                }
                let original = input["originalInput"].clone();
                if original.get("selectedTopic").is_none() && original.get("newPageIds").is_none() {
                    return Ok(self.analysis(&original).to_string());
                }
                input = original;
            }
            if node.starts_with("topic-plan") {
                let units = input["sourceInventory"]["units"].as_array().unwrap();
                return Ok(json!({"topics":units.iter().enumerate().map(|(index,unit)|{
                    let title=if index==0 {"Storage R1"}else{"Telemetry R2"};
                    let target=input["existingPages"].as_array().unwrap().iter().find(|page|page["draft"]["title"]==title)
                        .map(|page|page["draft"]["pageId"].clone()).unwrap_or_else(||input["newPageIds"][index].clone());
                    json!({
                    "pageId":target,"kind":if self.invalid_plan.load(Ordering::SeqCst)
                        && (request.stage == "generation" || self.invalid_repairs.load(Ordering::SeqCst)) {"source"} else {"concept"}, "title":title,
                    "unitIds":[unit["id"]]})}).collect::<Vec<_>>(),"reviewNotes":if self.blocking_plan && request.stage == "generation" {vec!["A concrete decision needs confirmation"]}else{vec![]},
                    "warnings":if self.advisory {vec!["Layout is represented as Markdown"]}else{vec![]}}).to_string());
            }
            if input.get("selectedTopic").is_some() {
                let topic = &input["selectedTopic"];
                if topic["title"] == "Telemetry R2"
                    && self.fail_second.swap(false, Ordering::SeqCst)
                {
                    anyhow::bail!("owned second topic transport failure");
                }
                if topic["title"] == "Telemetry R2"
                    && request.stage == "generation"
                    && self.truncate_second.swap(false, Ordering::SeqCst)
                {
                    return Err(WikiOutputTruncated {
                        stage: "generation",
                        text_bytes: 12,
                        reasoning_bytes: 0,
                        requested_tokens: request.max_output_tokens,
                        reported_output_tokens: None,
                        stop_reason: "max_tokens".into(),
                    }
                    .into());
                }
                let selected = &topic["unitIds"][0];
                let unit = input["sourceInventory"]["units"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|unit| unit["id"] == *selected)
                    .unwrap();
                let text = if topic["title"] == "Telemetry R2" && self.missing_fact {
                    "Telemetry R2 is described."
                } else if topic["title"] == "Storage R1" {
                    "Storage R1 uses port 8192."
                } else {
                    "Telemetry R2 only uses module B in its test scope."
                };
                let mut markdown = text.to_owned();
                let mut citations = vec![json!({"ref":unit["reference"]})];
                if let Some(prior) = input["existingPages"]
                    .as_array()
                    .and_then(|pages| pages.first())
                {
                    markdown = prior["draft"]["markdown"].as_str().unwrap().to_owned();
                    if !markdown.contains(text) {
                        markdown.push_str(&format!("\n{text}"));
                    }
                    citations.extend(
                        prior["draft"]["citations"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .cloned(),
                    );
                }
                return Ok(json!({"pages":{"pageId":topic["pageId"],"kind":if topic["title"] == "Telemetry R2" && self.invalid_kind.load(Ordering::SeqCst)
                        && (request.stage == "generation" || self.invalid_repairs.load(Ordering::SeqCst)) {"entity"} else {"concept"},"title":topic["title"],
                    "markdown":markdown,"citations":citations}, "notes":if self.advisory {"Source formatting is normalized for readability"}else{""} }).to_string());
            }
            if request.stage == "source_support" {
                if self.fail_coverage.swap(false, Ordering::SeqCst) {
                    anyhow::bail!("owned coverage transport failure");
                }
                let candidate = &input["candidate"];
                let complete = candidate["pages"].as_array().unwrap().iter().any(|page| {
                    page["markdown"]
                        .as_str()
                        .unwrap()
                        .contains("only uses module B in its test scope")
                });
                let placements = candidate["organizationProof"]["placements"]
                    .as_array()
                    .unwrap();
                // This owned literal classifier refuses ungrounded body text.
                // It intentionally does not label every offered unit supported.
                return Ok(json!({"sourceCoverage":if complete {"complete"}else{"incomplete"},
                    "units":input["units"].as_array().unwrap().iter().map(|unit|{
                        let grounded=SOURCE.contains(unit["text"].as_str().unwrap());
                        let binding=input["citationBindings"].as_array().unwrap().iter().find(|binding|binding["pageId"]==unit["pageId"]).unwrap();
                        let indices=binding["citations"].as_array().unwrap().iter().filter(|citation|
                            citation["quote"].as_str().unwrap().contains(unit["text"].as_str().unwrap())).map(|citation|citation["index"].clone()).take(1).collect::<Vec<_>>();
                        json!({"pageId":unit["pageId"],"unit":unit["unit"],"verdict":if grounded&&!indices.is_empty(){"supported"}else{"unsupported"},
                            "citationIndices":if grounded {indices}else{vec![]}})}).collect::<Vec<_>>(),
                    "organizationUnits":input["organizationInventory"]["units"].as_array().unwrap().iter().map(|unit|json!({
                        "unitId":unit["id"],"verdict":if unit["id"]==input["organizationInventory"]["units"][1]["id"]&&!complete {"unsupported"}else{"supported"},
                        "placementIndices":placements.iter().enumerate().filter(|(_,placement)|placement["unitId"]==unit["id"]).map(|(index,_)|index).collect::<Vec<_>>()})).collect::<Vec<_>>()}).to_string());
            }
            Err(anyhow!("unexpected owned model stage {node}"))
        })();
        store.budget_record_usage(&self.scope, &self.library, &reservation, None)?;
        result
    }
}

fn setup() -> Result<(tempfile::TempDir, KnowledgeCatalog, Fixture)> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("wiki.sqlite");
    let mut store = KnowledgeCatalog::open(&path)?;
    let scope = KnowledgeScope::from_authenticated_host("owned-pipeline", "local")?;
    let purpose = "Preserve storage and telemetry subjects and all their actual conditions";
    let library = store.create(&scope, "create", "Wiki", purpose)?;
    let source = store.import_text(&scope, &library.id, "source", "Owned source", SOURCE)?;
    let job = store.enqueue_ingest(
        &scope,
        &library.id,
        "job",
        &source.source_id,
        &source.revision_id,
        "owned-recipe",
        "en",
    )?;
    let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    Ok((
        temp,
        store,
        Fixture {
            invalid_kind: AtomicBool::new(false),
            invalid_plan: AtomicBool::new(false),
            invalid_repairs: AtomicBool::new(false),
            path,
            scope,
            library: library.id,
            source,
            purpose: purpose.into(),
            lease: Mutex::new(lease),
            calls: Mutex::new(Vec::new()),
            crash_received: AtomicBool::new(false),
            bad_analysis: false,
            fail_second: AtomicBool::new(false),
            fail_coverage: AtomicBool::new(false),
            missing_fact: false,
            advisory: false,
            blocking_plan: false,
            repair_failure: AtomicBool::new(false),
            truncate_second: AtomicBool::new(false),
            crash_node: Mutex::new(None),
            merge_calls: Mutex::new(0),
        },
    ))
}

#[tokio::test]
async fn complete_invalid_raw_is_durable_before_parse_and_only_failed_repair_is_rebought()
-> Result<()> {
    let (_temp, mut store, mut model) = setup()?;
    model.bad_analysis = true;
    model.crash_received.store(true, Ordering::SeqCst);
    model.repair_failure.store(true, Ordering::SeqCst);
    assert!(
        store
            .prepare_wiki_update(
                &model.scope,
                model.input(),
                &model,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(*model.calls.lock().unwrap(), vec!["source-analysis"]);
    model.resume(&mut store)?;
    assert!(
        store
            .prepare_wiki_update(
                &model.scope,
                model.input(),
                &model,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(
        *model.calls.lock().unwrap(),
        vec!["source-analysis", "source-analysis/format-repair"]
    );
    model.resume(&mut store)?;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            model.input(),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    let calls = model.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|node| node.as_str() == "source-analysis")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|node| node.as_str() == "source-analysis/format-repair")
            .count(),
        2
    );
    assert_eq!(
        *model.merge_calls.lock().unwrap(),
        1,
        "merge begins only after immutable source analysis completes"
    );
    Ok(())
}

#[tokio::test]
async fn second_topic_failure_preserves_first_topic_and_source_analysis_across_other_commits()
-> Result<()> {
    let (_temp, mut store, model) = setup()?;
    model.fail_second.store(true, Ordering::SeqCst);
    assert!(
        store
            .prepare_wiki_update(
                &model.scope,
                model.input(),
                &model,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    let before = model.calls.lock().unwrap().clone();
    assert_eq!(before.len(), 4);
    let progress = {
        let lease = model.lease.lock().unwrap();
        store
            .pipeline_progress(&model.scope, &model.library, &lease.job.id)?
            .unwrap()
    };
    assert_eq!(
        progress
            .records
            .iter()
            .filter(|record| record.address.stage_key.ends_with("/generation")
                && record.status == WikiPipelineStageStatus::Completed)
            .count(),
        1
    );
    assert!(
        store
            .list_pages(&model.scope, &model.library, None, 100)?
            .is_empty()
    );
    store.commit_generated_pages(
        &model.scope,
        &model.library,
        "unrelated",
        vec![KnowledgePageDraft {
            page_id: "fc4b82bb-9c74-4eab-9a63-593d243d99c3".into(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "Other subject".into(),
            markdown: "Unrelated preserved content".into(),
            related_page_ids: vec![],
            citations: vec![KnowledgeCitation {
                source_id: model.source.source_id.clone(),
                revision_id: model.source.revision_id.clone(),
                chunk_id: "chunk-1".into(),
                quote: SOURCE.into(),
            }],
        }],
    )?;
    model.resume(&mut store)?;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            model.input(),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    let calls = model.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|node| node.as_str() == "source-analysis")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|node| node.as_str() == "topic-plan")
            .count(),
        1
    );
    assert_eq!(calls.iter().filter(|node| node == &&before[2]).count(), 1);
    assert_eq!(calls.iter().filter(|node| node == &&before[3]).count(), 2);
    Ok(())
}

#[tokio::test]
async fn missing_necessary_fact_and_unsupported_body_stay_private_with_real_review_status()
-> Result<()> {
    let (_temp, mut store, mut model) = setup()?;
    model.missing_fact = true;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            model.input(),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(!prepared.proposal.review_notes.is_empty());
    assert!(
        prepared
            .proposal
            .review_notes
            .iter()
            .any(|note| note.contains("Source coverage"))
    );
    let lease = model.lease.lock().unwrap();
    let progress = store
        .pipeline_progress(&model.scope, &model.library, &lease.job.id)?
        .unwrap();
    assert!(
        progress
            .records
            .iter()
            .any(|record| record.address.stage_key == "source-coverage"
                && record.status == WikiPipelineStageStatus::NeedsReview)
    );
    store.save_job_checkpoint(
        &model.scope,
        &model.library,
        &lease,
        &WikiCheckpoint {
            through_chunk: prepared.through_chunk,
            has_more_chunks: prepared.has_more_chunks,
            proposal: prepared.proposal,
        },
    )?;
    store.stop_job_with_reason(
        &model.scope,
        &model.library,
        &lease,
        "awaiting_review",
        "review_required",
    )?;
    assert!(
        store
            .commit_job_checkpoint(&model.scope, &model.library, &lease)
            .is_err()
    );
    assert!(
        store
            .list_pages(&model.scope, &model.library, None, 100)?
            .is_empty()
    );
    Ok(())
}

#[tokio::test]
async fn changed_read_page_invalidates_only_its_topic_and_human_body_still_requires_review()
-> Result<()> {
    let (_temp, mut store, model) = setup()?;
    let page = "f568a82b-c351-447f-9f4b-0f4a9f23705a";
    let initial = store.commit_generated_pages(
        &model.scope,
        &model.library,
        "initial",
        vec![KnowledgePageDraft {
            page_id: page.into(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "Storage R1".into(),
            markdown: "Storage R1 uses port 8192.".into(),
            related_page_ids: vec![],
            citations: vec![KnowledgeCitation {
                source_id: model.source.source_id.clone(),
                revision_id: model.source.revision_id.clone(),
                chunk_id: "chunk-1".into(),
                quote: SOURCE.into(),
            }],
        }],
    )?;
    model.fail_coverage.store(true, Ordering::SeqCst);
    assert!(
        store
            .prepare_wiki_update(
                &model.scope,
                model.input(),
                &model,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    let before = model.calls.lock().unwrap().clone();
    assert_eq!(before.len(), 5);
    let human = "Storage R1 uses port 8192.\n\n";
    let changed = store.edit_page(
        &model.scope,
        &model.library,
        page,
        &initial[0].revision_id,
        "human",
        "Storage R1",
        human,
    )?;
    model.resume(&mut store)?;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            model.input(),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    let updated = prepared
        .proposal
        .pages
        .iter()
        .find(|draft| draft.page_id == page)
        .unwrap();
    assert_eq!(
        updated.expected_revision.as_deref(),
        Some(changed.revision_id.as_str())
    );
    assert!(updated.markdown.contains(human));
    let calls = model.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|node| node.as_str() == "source-analysis")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|node| node.as_str() == "topic-plan")
            .count(),
        2
    );
    assert_eq!(calls.iter().filter(|node| node == &&before[2]).count(), 2);
    assert_eq!(calls.iter().filter(|node| node == &&before[3]).count(), 1);
    assert_eq!(calls.iter().filter(|node| node == &&before[4]).count(), 2);
    drop(calls);
    assert!(
        store
            .commit_generated_pages(
                &model.scope,
                &model.library,
                "generated-over-human",
                prepared.proposal.pages
            )
            .is_err()
    );
    assert_eq!(
        store
            .read_page(&model.scope, &model.library, page, None)?
            .draft
            .markdown,
        human
    );
    Ok(())
}

#[tokio::test]
async fn truncated_topic_is_not_received_and_a_complete_retry_survives_before_parse_crash()
-> Result<()> {
    let (_temp, mut store, model) = setup()?;
    model.truncate_second.store(true, Ordering::SeqCst);
    *model.crash_node.lock().unwrap() = Some("/truncation-retry".into());
    assert!(
        store
            .prepare_wiki_update(
                &model.scope,
                model.input(),
                &model,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    let before = model.calls.lock().unwrap().clone();
    assert_eq!(before.len(), 5);
    let progress = {
        let lease = model.lease.lock().unwrap();
        store
            .pipeline_progress(&model.scope, &model.library, &lease.job.id)?
            .unwrap()
    };
    assert!(
        progress
            .records
            .iter()
            .any(|record| record.status == WikiPipelineStageStatus::Failed
                && record.error_code.as_deref() == Some("wiki_output_truncated"))
    );
    assert!(progress.records.iter().any(|record| {
        record.address.stage_key.ends_with("/truncation-retry")
            && record.status == WikiPipelineStageStatus::Received
    }));
    model.resume(&mut store)?;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            model.input(),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    let calls = model.calls.lock().unwrap();
    assert_eq!(
        calls.iter().filter(|node| node == &&before[3]).count(),
        1,
        "the truncated parent is not repurchased after its child completed"
    );
    assert_eq!(
        calls.iter().filter(|node| node == &&before[4]).count(),
        1,
        "the fully received retry is not repurchased"
    );
    assert_eq!(
        calls.len(),
        6,
        "only the still-missing normal coverage call runs"
    );
    Ok(())
}

#[tokio::test]
async fn advisory_notes_still_run_evidence_checks_and_allow_supported_publication() -> Result<()> {
    let (_temp, mut store, mut model) = setup()?;
    model.advisory = true;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            model.input(),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    assert_eq!(prepared.proposal.advisory_notes.len(), 2);
    assert!(
        model
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|node| node == "source-coverage")
    );
    let checkpoint = WikiCheckpoint {
        through_chunk: prepared.through_chunk,
        has_more_chunks: prepared.has_more_chunks,
        proposal: prepared.proposal,
    };
    let lease = model.lease.lock().unwrap();
    store.save_job_checkpoint(&model.scope, &model.library, &lease, &checkpoint)?;
    store.commit_job_checkpoint(&model.scope, &model.library, &lease)?;
    store.finish_job_batch(&model.scope, &model.library, &lease)?;
    assert_eq!(
        store
            .read_job(&model.scope, &model.library, &lease.job.id)?
            .status,
        "completed"
    );
    Ok(())
}

#[tokio::test]
async fn a_blocking_plan_builds_a_real_review_candidate_instead_of_an_empty_review() -> Result<()> {
    let (_temp, mut store, mut model) = setup()?;
    model.blocking_plan = true;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            model.input(),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(!prepared.proposal.pages.is_empty());
    assert!(
        prepared
            .proposal
            .review_notes
            .iter()
            .any(|note| note == "A concrete decision needs confirmation")
    );
    let checkpoint = WikiCheckpoint {
        through_chunk: prepared.through_chunk,
        has_more_chunks: prepared.has_more_chunks,
        proposal: prepared.proposal,
    };
    let lease = model.lease.lock().unwrap();
    store.save_job_checkpoint(&model.scope, &model.library, &lease, &checkpoint)?;
    assert!(
        store
            .commit_job_checkpoint(&model.scope, &model.library, &lease)
            .is_err()
    );
    store.stop_job_with_reason(
        &model.scope,
        &model.library,
        &lease,
        "awaiting_review",
        "review_required",
    )?;
    let review = store.pending_review(&model.scope, &model.library, &lease.job.id)?;
    assert!(!review.pages.is_empty());
    assert!(
        store
            .read_job(&model.scope, &model.library, &lease.job.id)?
            .review_available
            .unwrap()
    );
    Ok(())
}

#[tokio::test]
async fn invalid_topic_cache_is_evicted_and_resume_reuses_completed_topics() -> Result<()> {
    let (_temp, mut store, model) = setup()?;
    model.invalid_kind.store(true, Ordering::SeqCst);
    model.repair_failure.store(true, Ordering::SeqCst);
    let first = store
        .prepare_wiki_update(
            &model.scope,
            model.input(),
            &model,
            &CancellationToken::new(),
        )
        .await;
    assert!(first.is_err());
    let before = model.calls.lock().unwrap().clone();
    model.invalid_kind.store(false, Ordering::SeqCst);
    model.resume(&mut store)?;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            model.input(),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    let calls = model.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|node| node.as_str() == "source-analysis")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|node| node.as_str() == "topic-plan")
            .count(),
        1
    );
    assert_eq!(calls.iter().filter(|node| node == &&before[2]).count(), 1);
    assert_eq!(calls.iter().filter(|node| node == &&before[3]).count(), 2);
    Ok(())
}

#[tokio::test]
async fn semantic_plan_and_topic_failures_are_repaired_locally_with_shared_budget() -> Result<()> {
    let (_temp, mut store, model) = setup()?;
    model.invalid_plan.store(true, Ordering::SeqCst);
    model.invalid_kind.store(true, Ordering::SeqCst);
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            model.input(),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    assert_eq!(model.remaining_shared_repairs()?, 1);
    let calls = model.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|node| node.as_str() == "source-analysis")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|node| node.as_str() == "topic-plan")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|node| node.ends_with("/semantic-repair"))
            .count(),
        2
    );
    Ok(())
}

#[tokio::test]
async fn invalid_plan_cache_is_evicted_after_failed_repair_before_resume() -> Result<()> {
    let (_temp, mut store, model) = setup()?;
    model.invalid_plan.store(true, Ordering::SeqCst);
    model.repair_failure.store(true, Ordering::SeqCst);
    assert!(
        store
            .prepare_wiki_update(
                &model.scope,
                model.input(),
                &model,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    model.invalid_plan.store(false, Ordering::SeqCst);
    model.resume(&mut store)?;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            model.input(),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    let calls = model.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|node| node.as_str() == "source-analysis")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|node| node.as_str() == "topic-plan")
            .count(),
        2
    );
    Ok(())
}

#[tokio::test]
async fn repeated_semantic_failure_preserves_repair_limit_across_resume() -> Result<()> {
    let (_temp, mut store, model) = setup()?;
    model.invalid_kind.store(true, Ordering::SeqCst);
    model.invalid_repairs.store(true, Ordering::SeqCst);
    let first = store
        .prepare_wiki_update(
            &model.scope,
            model.input(),
            &model,
            &CancellationToken::new(),
        )
        .await
        .err()
        .expect("semantic failure must remain private");
    assert!(format!("{first:#}").contains("Wiki shared repair budget exceeded"));
    assert_eq!(model.remaining_shared_repairs()?, 0);
    model.resume(&mut store)?;
    let second = store
        .prepare_wiki_update(
            &model.scope,
            model.input(),
            &model,
            &CancellationToken::new(),
        )
        .await
        .err()
        .expect("semantic failure must remain private");
    assert!(format!("{second:#}").contains("Wiki shared repair budget exceeded"));
    let lease = model.lease.lock().unwrap();
    assert_eq!(
        store.job_batch_repair_calls(&model.scope, &model.library, &lease)?,
        3
    );
    let progress = store
        .pipeline_progress(&model.scope, &model.library, &lease.job.id)?
        .unwrap();
    assert_eq!(
        progress
            .records
            .iter()
            .filter(|record| record.address.stage_key.ends_with("/generation")
                && record.status == WikiPipelineStageStatus::Completed)
            .count(),
        1
    );
    let invalid: usize = rusqlite::Connection::open(&model.path)?.query_row(
        r#"SELECT COUNT(*) FROM knowledge_stage_cache WHERE body_json LIKE '%"kind":"entity"%'"#,
        [],
        |row| row.get(0),
    )?;
    assert_eq!(
        invalid, 0,
        "known semantic failures cannot be replay inputs"
    );
    Ok(())
}

#[tokio::test]
async fn semantic_repair_preserves_original_blocking_review_notes() -> Result<()> {
    let (_temp, mut store, mut model) = setup()?;
    model.invalid_plan.store(true, Ordering::SeqCst);
    model.blocking_plan = true;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            model.input(),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(
        prepared
            .proposal
            .review_notes
            .iter()
            .any(|note| note == "A concrete decision needs confirmation")
    );
    assert!(
        store
            .list_pages(&model.scope, &model.library, None, 100)?
            .is_empty()
    );
    assert_eq!(model.remaining_shared_repairs()?, 2);
    Ok(())
}
