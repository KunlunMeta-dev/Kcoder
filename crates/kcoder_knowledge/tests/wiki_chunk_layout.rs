//! Chunk-layout compatibility: 32 KiB chunks for new revisions, while stored
//! revisions keep their original layout, citations, batch windows and receipts.
use anyhow::Result;
use async_trait::async_trait;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, MAX_SOURCE_CHUNK_BYTES, SourceChunk, WikiIngestRequest,
    WikiModel, WikiModelRequest, WikiSourceChunkExceedsContext,
};
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio_util::sync::CancellationToken;

const LEGACY_CHUNK_BYTES: usize = 8 * 1024;

/// Returns a minimal valid analysis and a source-only proposal. Optionally
/// estimates tokens like the host rough counter (about three bytes per token).
#[derive(Default)]
struct LayoutModel {
    calls: AtomicUsize,
    rough_tokens: bool,
    restored_through: Option<usize>,
}
#[async_trait]
impl WikiModel for LayoutModel {
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let input: Value = serde_json::from_str(&request.user)?;
        if request.stage == "analysis" {
            return Ok(
                json!({"summary":"Layout evidence","queries":[],"conflicts":[]}).to_string(),
            );
        }
        assert_eq!(request.stage, "generation");
        let source = &input["source"];
        let chunk = &source["chunks"][0];
        Ok(
            json!({"pages":[{"pageId":input["newPageIds"][0],"expectedRevision":null,
            "kind":"source","title":"Source","markdown":"Source evidence.",
            "citations":[{"sourceId":source["sourceId"],"revisionId":source["revisionId"],
                "chunkId":chunk["chunkId"],
                "quote":chunk["text"].as_str().unwrap().chars().take(160).collect::<String>()}],
            "relatedPageIds":[]}],"reviewNotes":[]})
            .to_string(),
        )
    }
    fn estimate_input_tokens(&self, request: &WikiModelRequest) -> usize {
        let bytes = request.system.len() + request.user.len() + 512;
        if self.rough_tokens {
            bytes.div_ceil(3)
        } else {
            bytes
        }
    }
    fn restored_through_chunk(&self) -> Result<Option<usize>> {
        Ok(self.restored_through)
    }
}

fn store() -> Result<(tempfile::TempDir, KnowledgeCatalog, KnowledgeScope, String)> {
    let temp = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&temp.path().join("state.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "host")?;
    let library = store.create(&scope, "create", "Wiki", "")?.id;
    Ok((temp, store, scope, library))
}

/// The exact layout the released 8 KiB extractor stored for one-line text.
fn legacy_chunks(count: usize) -> Vec<SourceChunk> {
    (1..=count)
        .map(|ordinal| {
            let prefix = format!("Legacy fact {ordinal:02}: ");
            SourceChunk {
                ordinal,
                chunk_id: format!("chunk-{ordinal}"),
                first_line: 1,
                last_line: 1,
                text: format!("{prefix}{}", "y".repeat(LEGACY_CHUNK_BYTES - prefix.len())),
                page: None,
            }
        })
        .collect()
}

async fn prepare(
    store: &mut KnowledgeCatalog,
    scope: &KnowledgeScope,
    library: &str,
    source: &kcoder_knowledge::SourceRevision,
    after_chunk: usize,
    context_tokens: usize,
    model: &LayoutModel,
) -> Result<kcoder_knowledge::PreparedWikiUpdate> {
    store
        .prepare_wiki_update(
            scope,
            WikiIngestRequest {
                library_id: library,
                source_id: &source.source_id,
                source_revision: &source.revision_id,
                after_chunk,
                output_language: "en",
                context_tokens,
            },
            model,
            &CancellationToken::new(),
        )
        .await
}

#[tokio::test]
async fn legacy_8_kib_revision_keeps_layout_citations_batches_and_receipt() -> Result<()> {
    let (_temp, mut store, scope, library) = store()?;
    let chunks = legacy_chunks(10);
    let text = chunks
        .iter()
        .map(|chunk| chunk.text.as_str())
        .collect::<String>();
    let legacy = store.import_extracted(
        &scope,
        &library,
        "legacy",
        "Legacy.txt",
        text.as_bytes(),
        "text",
        chunks.clone(),
    )?;
    let read = |store: &KnowledgeCatalog| {
        store.source_chunks(
            &scope,
            &library,
            &legacy.source_id,
            &legacy.revision_id,
            0,
            100,
        )
    };
    assert_eq!(read(&store)?, chunks);

    // A lost-receipt retry after the chunk-rule change re-chunks the same text
    // at 32 KiB; it must return the stored revision, never re-chunk it.
    let replay = store.import_text(&scope, &library, "legacy", "Legacy.txt", &text)?;
    assert_eq!(replay, legacy);
    assert_eq!(read(&store)?, chunks);
    assert!(
        store
            .import_text(&scope, &library, "legacy", "Legacy.txt", &text[1..])
            .is_err()
    );

    // Historical chunk IDs keep resolving and whole-chunk quotes stay legal.
    let (_, cited) = store.resolve_citation(
        &scope,
        &library,
        &legacy.source_id,
        &legacy.revision_id,
        "chunk-3",
    )?;
    assert_eq!(cited, chunks[2]);
    store.commit_generated_pages(
        &scope,
        &library,
        "legacy-page",
        vec![KnowledgePageDraft {
            page_id: uuid::Uuid::new_v4().to_string(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "Legacy concept".into(),
            markdown: "Legacy fact 03 is recorded.".into(),
            citations: vec![KnowledgeCitation {
                source_id: legacy.source_id.clone(),
                revision_id: legacy.revision_id.clone(),
                chunk_id: "chunk-3".into(),
                quote: cited.text.clone(),
            }],
            related_page_ids: vec![],
        }],
    )?;

    // The batch byte bound never binds a pre-32 KiB layout: windows stay 8 chunks.
    let model = LayoutModel::default();
    let first = prepare(&mut store, &scope, &library, &legacy, 0, 1_000_000, &model).await?;
    assert_eq!((first.through_chunk, first.has_more_chunks), (8, true));
    let rest = prepare(&mut store, &scope, &library, &legacy, 8, 1_000_000, &model).await?;
    assert_eq!((rest.through_chunk, rest.has_more_chunks), (10, false));
    Ok(())
}

#[tokio::test]
async fn new_revisions_chunk_at_32_kib_and_keep_whole_chunk_quotes() -> Result<()> {
    let (_temp, mut store, scope, library) = store()?;
    let text = "z".repeat(MAX_SOURCE_CHUNK_BYTES + LEGACY_CHUNK_BYTES);
    let source = store.import_text(&scope, &library, "new", "New.txt", &text)?;
    let chunks = store.source_chunks(
        &scope,
        &library,
        &source.source_id,
        &source.revision_id,
        0,
        100,
    )?;
    assert_eq!(
        chunks
            .iter()
            .map(|chunk| chunk.text.len())
            .collect::<Vec<_>>(),
        [MAX_SOURCE_CHUNK_BYTES, LEGACY_CHUNK_BYTES]
    );
    store.commit_generated_pages(
        &scope,
        &library,
        "new-page",
        vec![KnowledgePageDraft {
            page_id: uuid::Uuid::new_v4().to_string(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "New concept".into(),
            markdown: "The whole first chunk is cited.".into(),
            citations: vec![KnowledgeCitation {
                source_id: source.source_id.clone(),
                revision_id: source.revision_id.clone(),
                chunk_id: "chunk-1".into(),
                quote: chunks[0].text.clone(),
            }],
            related_page_ids: vec![],
        }],
    )?;
    Ok(())
}

#[tokio::test]
async fn resumed_legacy_window_is_pinned_and_updated_source_rejects_old_job_cache() -> Result<()> {
    let (_temp, mut store, scope, library) = store()?;
    let chunks = legacy_chunks(6);
    let text = chunks
        .iter()
        .map(|chunk| chunk.text.as_str())
        .collect::<String>();
    let legacy = store.import_extracted(
        &scope,
        &library,
        "legacy",
        "Legacy.txt",
        text.as_bytes(),
        "text",
        chunks.clone(),
    )?;
    // A recovered source-read receipt pins the original 8 KiB window exactly.
    let model = LayoutModel {
        restored_through: Some(3),
        ..LayoutModel::default()
    };
    let prepared = prepare(&mut store, &scope, &library, &legacy, 0, 1_000_000, &model).await?;
    assert_eq!(
        (prepared.through_chunk, prepared.has_more_chunks),
        (3, true)
    );

    let job = store.enqueue_ingest(
        &scope,
        &library,
        "legacy-job",
        &legacy.source_id,
        &legacy.revision_id,
        kcoder_knowledge::PREPARATION_VERSION,
        "en",
    )?;
    let lease = store.claim_job(&scope, &library, &job.id)?.unwrap();
    let key = "a".repeat(64);
    let raw = json!({"summary":"Legacy analysis","queries":[],"conflicts":[]}).to_string();
    store.remember_json_response(&scope, &library, &lease, &key, &raw)?;
    assert_eq!(
        store.cached_json_response(&scope, &library, &lease, &key)?,
        Some(raw)
    );

    // A new revision of the same text uses the 32 KiB layout. The old job is
    // bound to its own revision: it pauses and cannot read its cache against
    // the differently chunked current text, while its evidence stays readable.
    let updated = store.update_source(
        &scope,
        &library,
        &legacy.source_id,
        &legacy.revision_id,
        "updated",
        "Legacy.txt",
        format!("{text}\n").as_bytes(),
        "text",
        vec![
            SourceChunk {
                ordinal: 1,
                chunk_id: "chunk-1".into(),
                first_line: 1,
                last_line: 1,
                text: text[..MAX_SOURCE_CHUNK_BYTES].to_owned(),
                page: None,
            },
            SourceChunk {
                ordinal: 2,
                chunk_id: "chunk-2".into(),
                first_line: 1,
                last_line: 2,
                text: format!("{}\n", &text[MAX_SOURCE_CHUNK_BYTES..]),
                page: None,
            },
        ],
    )?;
    assert_ne!(updated.revision_id, legacy.revision_id);
    let paused = store.read_job(&scope, &library, &job.id)?;
    assert_eq!(
        (paused.status.as_str(), paused.error_code.as_deref()),
        ("paused", Some("source_updated"))
    );
    assert!(
        store
            .cached_json_response(&scope, &library, &lease, &key)
            .is_err()
    );
    assert!(
        prepare(&mut store, &scope, &library, &legacy, 0, 1_000_000, &model)
            .await
            .is_err()
    );
    assert_eq!(
        store.source_chunks(
            &scope,
            &library,
            &legacy.source_id,
            &legacy.revision_id,
            0,
            100
        )?,
        chunks
    );
    Ok(())
}

fn dense_text(unit: &str) -> String {
    let mut text = String::new();
    let mut index = 0;
    loop {
        let paragraph = format!("{unit} {index}.\n\n");
        if text.len() + paragraph.len() > MAX_SOURCE_CHUNK_BYTES {
            return text;
        }
        text.push_str(&paragraph);
        index += 1;
    }
}

#[tokio::test]
async fn full_32_kib_chunk_progresses_on_32k_context_and_fails_typed_when_it_cannot_fit()
-> Result<()> {
    for unit in [
        "Prose fact with several ordinary English words",
        "中文资料事实包含多个汉字",
    ] {
        let (_temp, mut store, scope, library) = store()?;
        let text = dense_text(unit);
        assert!(text.len() > MAX_SOURCE_CHUNK_BYTES - 64);
        let source = store.import_text(&scope, &library, "dense", "Dense.md", &text)?;
        let model = LayoutModel {
            rough_tokens: true,
            ..LayoutModel::default()
        };
        let prepared = prepare(&mut store, &scope, &library, &source, 0, 32_768, &model).await?;
        assert_eq!(prepared.through_chunk, 1);
        assert!(model.calls.load(Ordering::SeqCst) >= 2);

        let tiny = LayoutModel {
            rough_tokens: true,
            ..LayoutModel::default()
        };
        let Err(error) = prepare(&mut store, &scope, &library, &source, 0, 8_192, &tiny).await
        else {
            panic!("a 32 KiB chunk cannot fit an 8K-token context");
        };
        let typed = error
            .downcast_ref::<WikiSourceChunkExceedsContext>()
            .expect("typed context error");
        assert_eq!(typed.chunk_id, "chunk-1");
        assert_eq!(typed.chunk_bytes, text.len());
        assert_eq!(typed.context_tokens, 8_192);
        assert!(typed.estimated_input_tokens > 8_192);
        assert!(error.to_string().contains("context budget exceeded"));
        assert_eq!(tiny.calls.load(Ordering::SeqCst), 0, "no paid request");
    }
    Ok(())
}
