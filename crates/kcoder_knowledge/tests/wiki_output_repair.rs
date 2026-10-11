#[path = "fixtures/organization.rs"]
mod organization_fixture;
use anyhow::Result;
use async_trait::async_trait;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, WikiCheckpoint, WikiIngestRequest, WikiModel,
    WikiModelRequest,
};
use serde_json::{Value, json};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

struct RepairModel {
    refuses: bool,
    changed_words: bool,
    stages: Mutex<Vec<String>>,
}
#[async_trait]
impl WikiModel for RepairModel {
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        self.stages.lock().unwrap().push(request.stage.into());
        if request.stage == "analysis" {
            let input: Value = serde_json::from_str(&request.user)?;
            return Ok(organization_fixture::with_plan(
                &input,
                json!({"summary":"Evidence","queries":[],"conflicts":[]}),
            )
            .to_string());
        }
        let mut input: Value = serde_json::from_str(&request.user)?;
        if input["repairKind"] == "source_support" {
            return Ok(organization_fixture::with_organization_support(&input,json!({"sourceCoverage":"complete","units":input["units"].as_array().unwrap().iter().map(|unit|
                json!({"pageId":unit["pageId"],"unit":unit["unit"],"verdict":"supported","citationIndices":[0]})
            ).collect::<Vec<_>>()} )).to_string());
        }
        let repair = request.stage == "citation_repair";
        if repair {
            assert!(
                input["validationErrors"]
                    .as_array()
                    .is_some_and(|errors| !errors.is_empty())
            );
            input = input["originalInput"].clone();
            // Exercise the offered immutable evidence instead of pinning old
            // prompt prose: valid refs expand, changed facts still fail below.
            assert!(
                input["citationSpans"]
                    .as_array()
                    .is_some_and(|spans| !spans.is_empty())
            );
        }
        let source = &input["source"];
        let chunk = &source["chunks"][0];
        let citation = if repair && !self.refuses {
            json!({"ref":input["citationSpans"].as_array().unwrap().iter().find(|span|span["wholeChunk"]==true).unwrap()["ref"]})
        } else {
            json!({"sourceId":source["sourceId"],"revisionId":source["revisionId"],"chunkId":chunk["chunkId"],
                "quote":if self.changed_words {"incremental inconsistent"} else {"incremental consistency"}})
        };
        Ok(organization_fixture::with_proof(&input,json!({"pages":[{"pageId":input["newPageIds"][0],"kind":"concept","title":"Evidence","markdown":"Supported claim","citations":[citation],"relatedPageIds":[]}],"reviewNotes":[]})).to_string())
    }
}
#[tokio::test]
async fn unique_pdf_whitespace_is_local_and_changed_words_require_real_citation_repair()
-> Result<()> {
    for (refuses, changed_words) in [(false, false), (false, true), (true, true)] {
        let temp = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
        let library = store.create(&scope, "wiki", "Wiki", "")?;
        let source = store.import_text(
            &scope,
            &library.id,
            "source",
            "PDF text",
            "incremental\nconsistency",
        )?;
        let model = RepairModel {
            refuses,
            changed_words,
            stages: Mutex::new(vec![]),
        };
        let result = store
            .prepare_wiki_update(
                &scope,
                WikiIngestRequest {
                    library_id: &library.id,
                    source_id: &source.source_id,
                    source_revision: &source.revision_id,
                    after_chunk: 0,
                    output_language: "en",
                    context_tokens: 64000,
                },
                &model,
                &CancellationToken::new(),
            )
            .await;
        assert!(store.list_pages(&scope, &library.id, None, 100)?.is_empty());
        if refuses {
            let error = result.err().expect("invalid citations must fail");
            assert_eq!(
                KnowledgeCatalog::candidate_failure_code(&error),
                Some("wiki_evidence_quote_span")
            );
            assert!(
                format!("{error:#}")
                    .contains("wiki_evidence_quote_span at /pages/0/citations/0/quote")
            );
        } else {
            let prepared = result?;
            assert_eq!(
                prepared.proposal.pages[0].citations[0].quote,
                "incremental\nconsistency"
            );
            store.commit_generated_pages(
                &scope,
                &library.id,
                "publish",
                prepared.proposal.pages,
            )?;
        }
        assert_eq!(
            model
                .stages
                .lock()
                .unwrap()
                .iter()
                .filter(|stage| stage.as_str() == "citation_repair")
                .count(),
            if refuses {
                2
            } else {
                usize::from(changed_words)
            }
        );
        assert_eq!(
            model
                .stages
                .lock()
                .unwrap()
                .iter()
                .filter(|stage| stage.as_str() == "source_support")
                .count(),
            usize::from(!refuses)
        );
    }
    Ok(())
}

struct LargeModel {
    stages: Mutex<Vec<&'static str>>,
}
#[async_trait]
impl WikiModel for LargeModel {
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        self.stages.lock().unwrap().push(request.stage);
        assert!(
            self.stages.lock().unwrap().len() <= 3,
            "only analysis, generation and one bounded assessment are dispatched"
        );
        if request.stage == "analysis" {
            let input: Value = serde_json::from_str(&request.user)?;
            return Ok(organization_fixture::with_plan(
                &input,
                json!({"summary":"Evidence","queries":["Topic"],"conflicts":[]}),
            )
            .to_string());
        }
        let input: Value = serde_json::from_str(&request.user)?;
        if input["repairKind"] == "source_support" {
            assert_eq!(request.stage, "source_support");
            assert_eq!(
                request.max_output_tokens,
                kcoder_types::DEFAULT_MODEL_OUTPUT_TOKENS
            );
            assert!(
                input["existingPages"].as_array().unwrap().is_empty(),
                "unchanged old bodies remain in candidate, without duplication"
            );
            return Ok(organization_fixture::with_organization_support(&input,json!({"sourceCoverage":"complete","units":input["units"].as_array().unwrap().iter().map(|unit|
                json!({"pageId":unit["pageId"],"unit":unit["unit"],"verdict":"supported","citationIndices":[0]})
            ).collect::<Vec<_>>()} )).to_string());
        }
        let mut pages = input["existingPages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|page| page["draft"]["kind"] == "concept")
            .map(|page| {
                let mut draft = page["draft"].clone();
                draft["expectedRevision"] = page["revisionId"].clone();
                draft
            })
            .collect::<Vec<_>>();
        assert_eq!(pages.len(), 4);
        assert!(request.max_output_tokens > 4096);
        let source = &input["source"];
        let chunk = &source["chunks"][0];
        pages.push(json!({"pageId":input["newPageIds"][0],"expectedRevision":null,
            "kind":"concept","title":"Evidence addition","markdown":"Evidence",
            "citations":[{"sourceId":source["sourceId"],"revisionId":source["revisionId"],"chunkId":chunk["chunkId"],"quote":chunk["text"]}],"relatedPageIds":[]}));
        let output =
            organization_fixture::with_proof(&input, json!({"pages":pages,"reviewNotes":[]}))
                .to_string();
        assert!(
            output.len() > 1024 * 1024 && output.len() < kcoder_knowledge::WIKI_MAX_OUTPUT_BYTES
        );
        Ok(output)
    }
}
#[tokio::test]
async fn complete_existing_response_above_old_limit_survives_checkpoint_and_commit() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let library = store.create(&scope, "wiki", "Wiki", "")?;
    let source = store.import_text(&scope, &library.id, "source", "Paper", "Evidence")?;
    let seeds = (0..4).map(|index|serde_json::from_value(json!({
        "pageId":uuid::Uuid::new_v4().to_string(),"expectedRevision":null,"kind":"concept",
        "title":format!("Topic {index}"),"markdown":"Evidence ".repeat(40000),
        "citations":[{"sourceId":source.source_id,"revisionId":source.revision_id,"chunkId":"chunk-1","quote":"Evidence"}],"relatedPageIds":[]
    })).unwrap()).collect();
    store.commit_generated_pages(&scope, &library.id, "seed-existing-long-pages", seeds)?;
    // Fixture certification exercises bounded lifecycle and large-page CAS;
    // it is not evidence of a real Provider or semantic-quality pass.
    let model = LargeModel {
        stages: Mutex::new(vec![]),
    };
    let prepared = store
        .prepare_wiki_update(
            &scope,
            WikiIngestRequest {
                library_id: &library.id,
                source_id: &source.source_id,
                source_revision: &source.revision_id,
                after_chunk: 0,
                output_language: "en",
                context_tokens: 2_000_000,
            },
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    assert_eq!(
        *model.stages.lock().unwrap(),
        vec!["analysis", "generation", "source_support"]
    );
    let job = store.enqueue_ingest(
        &scope,
        &library.id,
        "job",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "en",
    )?;
    let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    store.save_job_checkpoint(
        &scope,
        &library.id,
        &lease,
        &WikiCheckpoint {
            through_chunk: prepared.through_chunk,
            has_more_chunks: prepared.has_more_chunks,
            proposal: prepared.proposal,
        },
    )?;
    let refs = store.commit_job_checkpoint(&scope, &library.id, &lease)?;
    assert!(refs.len() >= 4);
    assert_eq!(
        store
            .read_page(&scope, &library.id, &refs[0].page_id, None)?
            .draft
            .markdown
            .len(),
        360000
    );
    Ok(())
}

struct TruncatingModel {
    stage: &'static str,
    persistent: bool,
    attempts: std::sync::atomic::AtomicUsize,
}
#[async_trait]
impl WikiModel for TruncatingModel {
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        if request.stage == self.stage || request.stage == "truncation_retry" {
            let attempt = self
                .attempts
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if attempt == 0 || self.persistent {
                return Err(kcoder_knowledge::WikiOutputTruncated {
                    stage: request.stage,
                    text_bytes: 23,
                    reasoning_bytes: 128000,
                    requested_tokens: 81920,
                    reported_output_tokens: Some(81920),
                    stop_reason: "max_tokens".into(),
                }
                .into());
            }
            assert!(request.system.contains("Retry with compact JSON"));
        }
        if request.stage == "analysis"
            || (request.stage == "truncation_retry" && self.stage == "analysis")
        {
            return Ok(json!({"summary":"Evidence","queries":[],"conflicts":[]}).to_string());
        }
        let input: Value = serde_json::from_str(&request.user)?;
        let source = &input["source"];
        let chunk = &source["chunks"][0];
        Ok(json!({"pages":[{"pageId":input["newPageIds"][0],"kind":"source","title":"Evidence","markdown":"Evidence","citations":[{"sourceId":source["sourceId"],"revisionId":source["revisionId"],"chunkId":chunk["chunkId"],"quote":chunk["text"]}],"relatedPageIds":[]}],"reviewNotes":[]}).to_string())
    }
}
#[tokio::test]
async fn length_stops_get_one_compact_retry_without_publishing_partial_json() -> Result<()> {
    for (stage, persistent) in [
        ("analysis", false),
        ("generation", false),
        ("generation", true),
    ] {
        let temp = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("owner", "local")?;
        let library = store.create(&scope, "library", "Wiki", "")?;
        let source = store.import_text(&scope, &library.id, "source", "Paper", "Evidence")?;
        let model = TruncatingModel {
            stage,
            persistent,
            attempts: std::sync::atomic::AtomicUsize::new(0),
        };
        let result = store
            .prepare_wiki_update(
                &scope,
                WikiIngestRequest {
                    library_id: &library.id,
                    source_id: &source.source_id,
                    source_revision: &source.revision_id,
                    after_chunk: 0,
                    output_language: "en",
                    context_tokens: 64000,
                },
                &model,
                &CancellationToken::new(),
            )
            .await;
        assert_eq!(model.attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert!(store.list_pages(&scope, &library.id, None, 100)?.is_empty());
        if persistent {
            let error = result.err().expect("persistent truncation must fail");
            let details = error
                .downcast_ref::<kcoder_knowledge::WikiOutputTruncated>()
                .expect("preserve diagnostic");
            assert_eq!(details.requested_tokens, 81920);
            let job = store.enqueue_ingest(
                &scope,
                &library.id,
                "job",
                &source.source_id,
                &source.revision_id,
                "recipe",
                "en",
            )?;
            let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
            store.record_job_truncation_details(&scope, &library.id, &lease, details)?;
            let stored = store.read_job(&scope, &library.id, &job.id)?;
            let diagnostic: Value = serde_json::from_str(stored.error_detail.as_deref().unwrap())?;
            assert_eq!(diagnostic["requestedTokens"], 81920);
            assert_eq!(diagnostic["stopReason"], "max_tokens");
        } else {
            let prepared = result?;
            store.commit_generated_pages(
                &scope,
                &library.id,
                "publish",
                prepared.proposal.pages,
            )?;
        }
    }
    Ok(())
}
