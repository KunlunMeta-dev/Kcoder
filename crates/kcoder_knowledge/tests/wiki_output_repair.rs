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
    stages: Mutex<Vec<String>>,
}
#[async_trait]
impl WikiModel for RepairModel {
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        self.stages.lock().unwrap().push(request.stage.into());
        if request.stage == "analysis" {
            return Ok(json!({"summary":"Evidence","queries":[],"conflicts":[]}).to_string());
        }
        let mut input: Value = serde_json::from_str(&request.user)?;
        let repair = request.stage == "citation_repair";
        if repair {
            assert!(
                input["validationErrors"]
                    .as_array()
                    .is_some_and(|errors| !errors.is_empty())
            );
            assert!(request.system.contains("exact contiguous quotes"));
            input = input["originalInput"].clone();
        }
        let source = &input["source"];
        let chunk = &source["chunks"][0];
        let quote = if repair && !self.refuses {
            chunk["text"].clone()
        } else {
            json!("incremental consistency")
        };
        Ok(json!({"pages":[{"pageId":input["newPageIds"][0],"kind":"concept","title":"Evidence","markdown":"Supported claim","citations":[{"sourceId":source["sourceId"],"revisionId":source["revisionId"],"chunkId":chunk["chunkId"],"quote":quote}],"relatedPageIds":[]}],"reviewNotes":[]}).to_string())
    }
}
#[tokio::test]
async fn invalid_pdf_quote_is_repaired_then_committed_or_rejected_without_writes() -> Result<()> {
    for refuses in [false, true] {
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
            assert!(
                result
                    .err()
                    .expect("invalid citations must fail")
                    .to_string()
                    .contains("two evidence repairs")
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
            if refuses { 2 } else { 1 }
        );
    }
    Ok(())
}

struct LargeModel;
#[async_trait]
impl WikiModel for LargeModel {
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        if request.stage == "analysis" {
            return Ok(json!({"summary":"Evidence","queries":[],"conflicts":[]}).to_string());
        }
        let input: Value = serde_json::from_str(&request.user)?;
        let source = &input["source"];
        let chunk = &source["chunks"][0];
        let pages=(0..4).map(|index|json!({"pageId":input["newPageIds"][index],"kind":"concept","title":format!("Topic {index}"),"markdown":"Evidence ".repeat(40000),"citations":[{"sourceId":source["sourceId"],"revisionId":source["revisionId"],"chunkId":chunk["chunkId"],"quote":chunk["text"]}],"relatedPageIds":[]})).collect::<Vec<_>>();
        let output = json!({"pages":pages,"reviewNotes":[]}).to_string();
        assert!(
            output.len() > 1024 * 1024 && output.len() < kcoder_knowledge::WIKI_MAX_OUTPUT_BYTES
        );
        Ok(output)
    }
}
#[tokio::test]
async fn response_above_old_limit_survives_validation_checkpoint_and_commit() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let library = store.create(&scope, "wiki", "Wiki", "")?;
    let source = store.import_text(&scope, &library.id, "source", "Paper", "Evidence")?;
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
            &LargeModel,
            &CancellationToken::new(),
        )
        .await?;
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
        if request.stage == self.stage {
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
        if request.stage == "analysis" {
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
