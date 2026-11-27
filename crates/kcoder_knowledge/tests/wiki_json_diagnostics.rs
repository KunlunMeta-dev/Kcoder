//! Synthetic parser failures; no upstream model or private materials are used.
use anyhow::Result;
use async_trait::async_trait;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, WikiAnalysis, WikiIngestRequest, WikiModel, WikiModelRequest,
    WikiProposal,
};
use serde_json::{Value, json};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

const PRIVATE: &str = "PRIVATE_VALUE_OR_UNKNOWN_KEY";
struct ParserModel {
    failed_stage: &'static str,
    bad: String,
    repair_success: bool,
    stages: Mutex<Vec<String>>,
    analyses: Mutex<usize>,
    proposals: Mutex<usize>,
}
fn valid_analysis() -> String {
    json!({"summary":"Owned evidence","queries":[],"conflicts":[]}).to_string()
}
fn valid_proposal(input: &Value) -> String {
    let source = &input["source"];
    let chunk = &source["chunks"][0];
    json!({"pages":[{"pageId":input["newPageIds"][0],"expectedRevision":null,
        "kind":"source","title":"Owned evidence","markdown":"Owned evidence",
        "citations":[{"sourceId":source["sourceId"],"revisionId":source["revisionId"],
            "chunkId":chunk["chunkId"],"quote":chunk["text"]}],"relatedPageIds":[]}],
        "reviewNotes":[]})
    .to_string()
}
#[async_trait]
impl WikiModel for ParserModel {
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        self.stages.lock().unwrap().push(request.stage.into());
        let input: Value = serde_json::from_str(&request.user)?;
        if request.stage == "format_repair" {
            assert_eq!(input["previousResponse"], self.bad);
            assert!(!input["validationError"].as_str().unwrap().is_empty());
            if self.bad.contains(PRIVATE) && self.bad.contains("UNKNOWN") {
                // The complete prior response remains private; the static diagnostic does not echo its values.
                assert!(!input["validationError"].as_str().unwrap().contains(PRIVATE));
            }
            return Ok(if !self.repair_success {
                self.bad.clone()
            } else if self.failed_stage == "analysis" {
                valid_analysis()
            } else {
                valid_proposal(&input["originalInput"])
            });
        }
        if request.stage == self.failed_stage {
            return Ok(self.bad.clone());
        }
        Ok(if request.stage == "analysis" {
            valid_analysis()
        } else {
            valid_proposal(&input)
        })
    }
    fn remember_analysis(&self, _: &WikiModelRequest, _: &WikiAnalysis) -> Result<()> {
        *self.analyses.lock().unwrap() += 1;
        Ok(())
    }
    fn remember_proposal(&self, _: &WikiModelRequest, _: &WikiProposal) -> Result<()> {
        *self.proposals.lock().unwrap() += 1;
        Ok(())
    }
}

fn page_with(page: &Value, name: &str, value: Value) -> Value {
    let mut page = page.clone();
    page[name] = value;
    page
}

#[tokio::test]
async fn syntax_eof_and_schema_types_have_safe_diagnostics_and_one_format_repair() -> Result<()> {
    let page = json!({"pageId":"unused","kind":"source","title":"Evidence","markdown":"Evidence"});
    let citation = json!({"sourceId":"s","revisionId":"r","chunkId":"c","quote":7});
    let cases = vec![
        (
            "analysis",
            "{\"summary\":,}".into(),
            "wiki_json_syntax",
            "/",
        ),
        (
            "analysis",
            "{\"summary\":\"unfinished".into(),
            "wiki_json_eof",
            "/",
        ),
        ("analysis", "false".into(), "wiki_json_type", "/"),
        (
            "analysis",
            json!({"summary":true,"queries":[]}).to_string(),
            "wiki_json_type",
            "/summary",
        ),
        (
            "analysis",
            json!({"summary":7,"queries":[]}).to_string(),
            "wiki_json_type",
            "/summary",
        ),
        (
            "analysis",
            json!({"summary":[],"queries":[]}).to_string(),
            "wiki_json_type",
            "/summary",
        ),
        (
            "analysis",
            json!({"summary":"Evidence","queries":[false]}).to_string(),
            "wiki_json_type",
            "/queries/0",
        ),
        (
            "generation",
            json!({"pages":7}).to_string(),
            "wiki_json_type",
            "/pages",
        ),
        (
            "generation",
            json!({"pages":[false]}).to_string(),
            "wiki_json_type",
            "/pages/0",
        ),
        (
            "generation",
            json!({"pages":[page_with(&page, "title", json!(false))]}).to_string(),
            "wiki_json_type",
            "/pages/0/title",
        ),
        (
            "generation",
            json!({"pages":[page_with(&page, "citations", json!(true))]}).to_string(),
            "wiki_json_type",
            "/pages/0/citations",
        ),
        (
            "generation",
            json!({"pages":[page_with(&page, "citations", json!([citation]))]}).to_string(),
            "wiki_json_type",
            "/pages/0/citations/0/quote",
        ),
        (
            "generation",
            json!({"pages":[page.clone()],"reviewNotes":true}).to_string(),
            "wiki_json_type",
            "/reviewNotes",
        ),
        (
            "generation",
            json!({"pages":[page_with(&page, "kind", json!(PRIVATE))]}).to_string(),
            "wiki_json_schema",
            "/pages/0/kind",
        ),
    ];
    for (stage, bad, code, field) in cases {
        assert!(bad.len() <= 3000);
        let temp = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("owned-fixture", "local")?;
        let library = store.create(&scope, "wiki", "Wiki", "")?;
        let source =
            store.import_text(&scope, &library.id, "source", "Evidence", "Owned evidence")?;
        let model = ParserModel {
            failed_stage: stage,
            bad,
            repair_success: false,
            stages: Mutex::new(vec![]),
            analyses: Mutex::new(0),
            proposals: Mutex::new(0),
        };
        let error = store
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
            .await
            .err()
            .expect("parser must reject");
        assert_eq!(KnowledgeCatalog::candidate_failure_code(&error), Some(code));
        assert_eq!(error.to_string(), format!("{code} at {field}"));
        assert!(!format!("{error:?}").contains(PRIVATE));
        assert_eq!(*model.proposals.lock().unwrap(), 0);
        assert_eq!(
            *model.analyses.lock().unwrap(),
            usize::from(stage == "generation")
        );
        assert_eq!(
            model
                .stages
                .lock()
                .unwrap()
                .iter()
                .filter(|s| *s == "format_repair")
                .count(),
            1
        );
        assert!(store.list_pages(&scope, &library.id, None, 100)?.is_empty());
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
        store.record_job_candidate_failure(&scope, &library.id, &lease, &error)?;
        let detail = store
            .read_job(&scope, &library.id, &job.id)?
            .error_detail
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&detail)?,
            json!({"stage":"format_repair","errorType":code,"field":field})
        );
        assert!(!detail.contains(PRIVATE));
        store.pause_job(&scope, &library.id, &job.id)?;
        store.resume_job(&scope, &library.id, &job.id)?;
        let current = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
        store.record_job_candidate_failure(&scope, &library.id, &lease, &error)?;
        assert!(
            store
                .read_job(&scope, &library.id, &job.id)?
                .error_detail
                .is_none()
        );
        store.record_job_candidate_failure(&scope, &library.id, &current, &error)?;
        assert!(
            store
                .read_job(&scope, &library.id, &job.id)?
                .error_detail
                .is_some()
        );
    }
    Ok(())
}

#[tokio::test]
async fn repaired_output_uses_original_serde_compatibility_and_is_cached_only_after_validation()
-> Result<()> {
    for stage in ["analysis", "generation"] {
        let temp = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("owned-fixture", "local")?;
        let library = store.create(&scope, "wiki", "Wiki", "")?;
        let source =
            store.import_text(&scope, &library.id, "source", "Evidence", "Owned evidence")?;
        let model = ParserModel {
            failed_stage: stage,
            bad: "{malformed".into(),
            repair_success: true,
            stages: Mutex::new(vec![]),
            analyses: Mutex::new(0),
            proposals: Mutex::new(0),
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
                    context_tokens: 64000,
                },
                &model,
                &CancellationToken::new(),
            )
            .await?;
        assert_eq!(*model.analyses.lock().unwrap(), 1);
        assert_eq!(*model.proposals.lock().unwrap(), 1);
        assert_eq!(model.stages.lock().unwrap().len(), 3);
        assert!(store.list_pages(&scope, &library.id, None, 100)?.is_empty());
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
        assert!(store.list_pages(&scope, &library.id, None, 100)?.is_empty());
    }
    Ok(())
}
