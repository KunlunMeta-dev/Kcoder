//! Deterministic contract and evidence-transfer checks, not a real-model quality gate.
use anyhow::Result;
use async_trait::async_trait;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, SourceChunk, WikiIngestRequest, WikiModel, WikiModelRequest,
};
use serde_json::{Value, json};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

struct ContractModel {
    text: String,
    page: Option<u32>,
    query: String,
    stages: Mutex<Vec<String>>,
}
#[async_trait]
impl WikiModel for ContractModel {
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        self.stages.lock().unwrap().push(request.stage.into());
        let mut input: Value = serde_json::from_str(&request.user)?;
        if request.stage == "format_repair" {
            input = input["originalInput"].clone();
            assert_eq!(input["source"]["chunks"][0]["text"], self.text);
            return Ok(json!({"queries":[self.query]}).to_string());
        }
        let chunk = &input["source"]["chunks"][0];
        // Serialization must not alter the persisted extraction representation,
        // even when analysis prose is deliberately formatted differently.
        assert_eq!(chunk["text"], self.text);
        assert_eq!(chunk["page"], json!(self.page));
        assert_eq!(chunk["chunkId"], "chunk-1");
        if request.stage == "analysis" {
            for limit in [
                "at most 16384 UTF-8 bytes",
                "at most 3 strings, each at most 256 UTF-8 bytes",
                "at most 16 strings, each at most 1024 UTF-8 bytes",
                "decoded strings, not JSON escape spelling",
                "86 do not",
            ] {
                assert!(request.system.contains(limit), "missing contract: {limit}");
            }
            assert!(request.system.contains("not the citation source"));
            return Ok(json!({
                "summary": "Reformatted prose without the original table or PDF whitespace.",
                "queries": [self.query], "conflicts": []
            })
            .to_string());
        }
        assert_eq!(request.stage, "generation");
        for contract in [
            "pages is an array of 1 to 8 objects",
            "citations is an array of 1 to 128 citation objects",
            "relatedPageIds is an array of at most 64 ID strings",
            "reviewNotes is an array of at most 16 strings, each at most 2048 UTF-8 bytes",
            "at most 240 Unicode characters and at most 1024 UTF-8 bytes",
            "at most 1048576 UTF-8 bytes",
            "not the analysis summary",
        ] {
            assert!(
                request.system.contains(contract),
                "missing contract: {contract}"
            );
        }
        let source = &input["source"];
        Ok(json!({"pages":[{
            "pageId": input["newPageIds"][0], "expectedRevision": null,
            "kind": "source", "title": "Evidence", "markdown": self.text,
            "citations": [{"sourceId": source["sourceId"], "revisionId": source["revisionId"],
                "chunkId": chunk["chunkId"], "quote": chunk["text"]}],
            "relatedPageIds": []
        }], "reviewNotes": []})
        .to_string())
    }
}

#[tokio::test]
async fn extracted_text_reaches_both_stages_and_private_checkpoint_byte_exact() -> Result<()> {
    // These are owned synthetic extraction fixtures. HTML is already extracted;
    // this test does not claim to validate the extractor or model intelligence.
    for (format, text, page) in [
        ("text", "中文原始引文：版本 A\t保留空格。\n版本 B。", None),
        (
            "markdown",
            "| 字段 | 类型 |\n| --- | --- |\n| id | TEXT PRIMARY KEY |\n",
            None,
        ),
        ("html", "Heading\nField\tType\t\nid\tTEXT\t\n", None),
        (
            "pdf",
            "The incremental\nconsis-\ntency  result\t\"A\".\n",
            Some(7),
        ),
    ] {
        assert!(text.len() <= 3000);
        let temp = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&temp.path().join("catalog.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("owned-fixture", "local")?;
        let library = store.create(&scope, "create", "Wiki", "Preserve evidence")?;
        let source = store.import_extracted(
            &scope,
            &library.id,
            "source",
            "Owned fixture",
            b"owned original",
            format,
            vec![SourceChunk {
                ordinal: 1,
                chunk_id: "chunk-1".into(),
                first_line: 1,
                last_line: 5,
                text: text.into(),
                page,
            }],
        )?;
        let model = ContractModel {
            text: text.into(),
            page,
            query: "中".repeat(85),
            stages: Mutex::new(Vec::new()),
        };
        let prepared = store
            .prepare_wiki_update(
                &scope,
                WikiIngestRequest {
                    library_id: &library.id,
                    source_id: &source.source_id,
                    source_revision: &source.revision_id,
                    after_chunk: 0,
                    output_language: "简体中文",
                    context_tokens: 64000,
                },
                &model,
                &CancellationToken::new(),
            )
            .await?;
        assert_eq!(prepared.proposal.review_notes.len(), 1);
        assert!(prepared.proposal.review_notes[0].contains("no validated purpose/source plan"));
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
        store.save_job_checkpoint(
            &scope,
            &library.id,
            &lease,
            &kcoder_knowledge::WikiCheckpoint {
                through_chunk: prepared.through_chunk,
                has_more_chunks: prepared.has_more_chunks,
                proposal: prepared.proposal,
            },
        )?;
        store.stop_job_with_reason(
            &scope,
            &library.id,
            &lease,
            "awaiting_review",
            "review_required",
        )?;
        assert!(
            store
                .commit_job_checkpoint(&scope, &library.id, &lease)
                .is_err()
        );
        let checkpoint = store.job_checkpoint(&scope, &library.id, &job.id)?.unwrap();
        for page in checkpoint.proposal.pages {
            assert_eq!(page.citations[0].quote, text);
            assert_eq!(page.citations[0].source_id, source.source_id);
            assert_eq!(page.citations[0].revision_id, source.revision_id);
            let (_, chunk) = store.resolve_citation(
                &scope,
                &library.id,
                &source.source_id,
                &source.revision_id,
                &page.citations[0].chunk_id,
            )?;
            assert_eq!(chunk.text, text);
        }
        assert!(store.list_pages(&scope, &library.id, None, 100)?.is_empty());
        assert_eq!(
            model.stages.lock().unwrap().as_slice(),
            ["analysis", "generation"]
        );
    }
    Ok(())
}

#[tokio::test]
async fn eighty_six_chinese_query_characters_still_fail_after_three_shared_repairs() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&temp.path().join("catalog.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("owned-fixture", "local")?;
    let library = store.create(&scope, "create", "Wiki", "Preserve evidence")?;
    let text = "中文证据";
    let source = store.import_text(&scope, &library.id, "source", "Owned fixture", text)?;
    let model = ContractModel {
        text: text.into(),
        page: None,
        query: "中".repeat(86),
        stages: Mutex::new(Vec::new()),
    };
    let error = store
        .prepare_wiki_update(
            &scope,
            WikiIngestRequest {
                library_id: &library.id,
                source_id: &source.source_id,
                source_revision: &source.revision_id,
                after_chunk: 0,
                output_language: "简体中文",
                context_tokens: 64000,
            },
            &model,
            &CancellationToken::new(),
        )
        .await
        .err()
        .expect("258 UTF-8 bytes must fail");
    assert_eq!(
        KnowledgeCatalog::candidate_failure_code(&error),
        Some("wiki_analysis_query_bounds")
    );
    assert!(
        error
            .to_string()
            .contains("Wiki shared repair budget exceeded")
    );
    assert_eq!(
        model.stages.lock().unwrap().as_slice(),
        [
            "analysis",
            "format_repair",
            "format_repair",
            "format_repair"
        ]
    );
    Ok(())
}
