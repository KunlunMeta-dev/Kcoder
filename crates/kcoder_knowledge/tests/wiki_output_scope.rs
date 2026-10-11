use anyhow::Result;
use async_trait::async_trait;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, SourceChunk, WikiCheckpoint, WikiIngestRequest, WikiModel,
    WikiModelRequest,
};
use kcoder_types::knowledge::KnowledgePageKind;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

struct BoundaryModel;
#[async_trait]
impl WikiModel for BoundaryModel {
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        let input: Value = serde_json::from_str(&request.user)?;
        if request.stage == "analysis" {
            return Ok(
                json!({"summary":"Original boundary evidence","queries":[],"conflicts":[]})
                    .to_string(),
            );
        }
        assert_eq!(request.stage, "generation");
        assert_eq!(request.max_output_tokens, 256 * 1024);
        let source = &input["source"];
        let chunk = &source["chunks"][0];
        Ok(json!({"pages":[{"pageId":input["newPageIds"][0],"expectedRevision":null,
            "kind":"source","title":"Unsupported generalized source summary",
            "markdown":"These examples establish a unified rejection mechanism.",
            "citations":[{"sourceId":source["sourceId"],"revisionId":source["revisionId"],
                "chunkId":chunk["chunkId"],"quote":chunk["text"].as_str().unwrap().chars().take(160).collect::<String>()}],
            "relatedPageIds":[]}],"reviewNotes":[]}).to_string())
    }
}
fn chunk(index: usize, bytes: usize) -> SourceChunk {
    SourceChunk {
        ordinal: index,
        chunk_id: format!("chunk-{index}"),
        first_line: index,
        last_line: index,
        text: format!("Scope {index}: {}", "x".repeat(bytes - 9)),
        page: None,
    }
}
#[tokio::test]
async fn largest_legal_chunks_are_preserved_in_review_required_bounded_batches() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&temp.path().join("state.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "host")?;
    let library = store.create(&scope, "create", "Wiki", "")?;
    let chunks = (1..=8)
        .map(|index| chunk(index, 16 * 1024))
        .collect::<Vec<_>>();
    assert!(chunks.iter().all(|chunk| chunk.text.len() == 16 * 1024));
    let source = store.import_extracted(
        &scope,
        &library.id,
        "source",
        "Historical original",
        b"fixture",
        "text",
        chunks.clone(),
    )?;
    let mut through = 0;
    let mut preserved = Vec::new();
    loop {
        let prepared = store
            .prepare_wiki_update(
                &scope,
                WikiIngestRequest {
                    library_id: &library.id,
                    source_id: &source.source_id,
                    source_revision: &source.revision_id,
                    after_chunk: through,
                    output_language: "en",
                    context_tokens: 1_000_000,
                },
                &BoundaryModel,
                &CancellationToken::new(),
            )
            .await?;
        assert!(prepared.through_chunk > through);
        let raw = prepared
            .proposal
            .pages
            .iter()
            .find(|page| page.kind == KnowledgePageKind::Source)
            .unwrap();
        assert!(raw.title.starts_with("Historical original"));
        assert!(raw.markdown.len() <= kcoder_knowledge::WIKI_MAX_PAGE_BYTES);
        for citation in &raw.citations {
            let original = chunks
                .iter()
                .find(|chunk| chunk.chunk_id == citation.chunk_id)
                .unwrap();
            assert!(raw.markdown.contains(&original.text));
            assert!(citation.quote.len() <= 640 && original.text.contains(&citation.quote));
            assert_eq!(citation.revision_id, source.revision_id);
            preserved.push(original.ordinal);
        }
        assert_eq!(prepared.proposal.review_notes.len(), 1);
        assert!(prepared.proposal.review_notes[0].contains("no validated purpose/source plan"));
        let job = store.enqueue_ingest(
            &scope,
            &library.id,
            &format!("batch-{through}"),
            &source.source_id,
            &source.revision_id,
            kcoder_knowledge::PREPARATION_VERSION,
            "en",
        )?;
        let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
        through = prepared.through_chunk;
        let has_more = prepared.has_more_chunks;
        store.save_job_checkpoint(
            &scope,
            &library.id,
            &lease,
            &WikiCheckpoint {
                through_chunk: through,
                has_more_chunks: has_more,
                proposal: prepared.proposal,
            },
        )?;
        // The worker's actual blocking-note gate keeps this prepared raw source
        // private; this test must not publish a source-only candidate directly.
        store.stop_job_with_reason(
            &scope,
            &library.id,
            &lease,
            "awaiting_review",
            "review_required",
        )?;
        assert_eq!(
            store.read_job(&scope, &library.id, &job.id)?.status,
            "awaiting_review"
        );
        assert!(
            store
                .commit_job_checkpoint(&scope, &library.id, &lease)
                .is_err()
        );
        assert!(store.list_pages(&scope, &library.id, None, 100)?.is_empty());
        assert_eq!(
            store
                .job_checkpoint(&scope, &library.id, &job.id)?
                .unwrap()
                .proposal
                .review_notes
                .len(),
            1
        );
        if !has_more {
            break;
        }
    }
    assert_eq!(preserved, (1..=8).collect::<Vec<_>>());
    assert_eq!(through, 8);
    let too_large = chunk(1, 16 * 1024 + 1);
    assert!(
        store
            .import_extracted(
                &scope,
                &library.id,
                "oversize",
                "Rejected",
                b"fixture",
                "text",
                vec![too_large]
            )
            .is_err()
    );
    Ok(())
}
