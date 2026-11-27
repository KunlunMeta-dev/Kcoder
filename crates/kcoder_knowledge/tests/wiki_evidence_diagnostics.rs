//! Model-independent fault injection: diagnostic safety, recovery gates and
//! finite repair limits. These fixtures make no model quality claims.
use anyhow::Result;
use async_trait::async_trait;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, WikiIngestRequest, WikiModel, WikiModelRequest, WikiProposal,
};
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
use serde_json::{Value, json};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

const PRIVATE: &str = "PRIVATE_RESPONSE_CREDENTIAL_TITLE_PATH";
const CASES: &[(&str, &str, &str)] = &[
    ("sourceId", "wiki_evidence_source_not_supplied", "sourceId"),
    (
        "revisionId",
        "wiki_evidence_revision_not_supplied",
        "revisionId",
    ),
    ("chunkId", "wiki_evidence_chunk_not_supplied", "chunkId"),
    ("quote", "wiki_evidence_quote_span", "quote"),
    ("empty", "wiki_evidence_quote_bounds", "quote"),
    ("large", "wiki_evidence_quote_bounds", "quote"),
    ("citations", "wiki_evidence_citations_bounds", "citations"),
];

struct InvalidEvidence {
    invalid: &'static str,
    restore_generation: bool,
    host_budget_exhausted: bool,
    stages: Mutex<Vec<&'static str>>,
    remembered: Mutex<usize>,
}
impl InvalidEvidence {
    fn proposal(&self, request: &WikiModelRequest) -> Result<WikiProposal> {
        let input: Value = serde_json::from_str(&request.user)?;
        let input = if request.stage == "citation_repair" {
            &input["originalInput"]
        } else {
            &input
        };
        let source = &input["source"];
        let chunk = &source["chunks"][0];
        let mut citation = json!({"sourceId":source["sourceId"],"revisionId":source["revisionId"],
            "chunkId":chunk["chunkId"],"quote":chunk["text"]});
        match self.invalid {
            "empty" => citation["quote"] = json!(" \n"),
            "large" => citation["quote"] = json!(PRIVATE.repeat(1024)),
            "citations" => {}
            key => citation[key] = json!(PRIVATE),
        }
        Ok(serde_json::from_value(
            json!({"pages":[{"pageId":input["newPageIds"][0],
            "expectedRevision":null,"kind":"concept","title":PRIVATE,"markdown":PRIVATE,
            "citations":if self.invalid == "citations" {json!([])} else {json!([citation])},
            "relatedPageIds":[]}],"reviewNotes":[]}),
        )?)
    }
}
#[async_trait]
impl WikiModel for InvalidEvidence {
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        self.stages.lock().unwrap().push(request.stage);
        if request.stage == "analysis" {
            return Ok(json!({"summary":"Evidence","queries":[],"conflicts":[]}).to_string());
        }
        if self.host_budget_exhausted {
            anyhow::bail!("Wiki shared repair budget exceeded");
        }
        Ok(serde_json::to_string(&self.proposal(&request)?)?)
    }
    fn cached_proposal(&self, request: &WikiModelRequest) -> Result<Option<WikiProposal>> {
        if self.restore_generation && request.stage == "generation" {
            Ok(Some(self.proposal(request)?))
        } else {
            Ok(None)
        }
    }
    fn remember_proposal(&self, _: &WikiModelRequest, _: &WikiProposal) -> Result<()> {
        *self.remembered.lock().unwrap() += 1;
        Ok(())
    }
}

#[tokio::test]
async fn citation_failure_fields_survive_exhaustion_and_cached_candidates_still_revalidate()
-> Result<()> {
    for &(invalid, code, field) in CASES {
        for restore_generation in [false, true] {
            let root = tempfile::tempdir()?;
            let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
            let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
            let library = store.create(&scope, "wiki", PRIVATE, "")?;
            let source = store.import_text(
                &scope,
                &library.id,
                "source",
                PRIVATE,
                "original\ncontiguous evidence",
            )?;
            let model = InvalidEvidence {
                invalid,
                restore_generation,
                host_budget_exhausted: false,
                stages: Mutex::new(vec![]),
                remembered: Mutex::new(0),
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
                .expect("unsupported evidence must fail");
            assert_eq!(KnowledgeCatalog::candidate_failure_code(&error), Some(code));
            let pointer = if field == "citations" {
                "/pages/0/citations".into()
            } else {
                format!("/pages/0/citations/0/{field}")
            };
            assert_eq!(error.to_string(), format!("{code} at {pointer}"));
            assert!(!format!("{error:#}").contains(PRIVATE));
            assert_eq!(
                *model.stages.lock().unwrap(),
                if restore_generation {
                    vec!["analysis", "citation_repair", "citation_repair"]
                } else {
                    vec![
                        "analysis",
                        "generation",
                        "citation_repair",
                        "citation_repair",
                    ]
                }
            );
            assert_eq!(
                *model.remembered.lock().unwrap(),
                3,
                "private structural candidates remain resumable"
            );
            assert!(store.list_pages(&scope, &library.id, None, 100)?.is_empty());
            record_safe_failure(
                &mut store,
                &scope,
                &library.id,
                &source.source_id,
                &source.revision_id,
                &error,
                "citation_repair",
                code,
                &pointer,
            )?;
        }
    }
    Ok(())
}

#[tokio::test]
async fn durable_host_budget_retains_pending_citation_field_without_spending_another_call()
-> Result<()> {
    let root = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let library = store.create(&scope, "wiki", PRIVATE, "")?;
    let source = store.import_text(&scope, &library.id, "source", PRIVATE, "Evidence")?;
    let model = InvalidEvidence {
        invalid: "quote",
        restore_generation: true,
        host_budget_exhausted: true,
        stages: Mutex::new(vec![]),
        remembered: Mutex::new(0),
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
        .unwrap();
    assert!(format!("{error:#}").contains("Wiki shared repair budget exceeded"));
    assert!(!format!("{error:#}").contains(PRIVATE));
    assert_eq!(
        KnowledgeCatalog::candidate_failure_code(&error),
        Some("wiki_evidence_quote_span")
    );
    assert_eq!(
        *model.stages.lock().unwrap(),
        ["analysis", "citation_repair"]
    );
    record_safe_failure(
        &mut store,
        &scope,
        &library.id,
        &source.source_id,
        &source.revision_id,
        &error,
        "citation_repair",
        "wiki_evidence_quote_span",
        "/pages/0/citations/0/quote",
    )?;
    Ok(())
}

#[test]
fn commit_diagnostics_resolve_only_authorized_library_evidence_and_never_publish() -> Result<()> {
    let root = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let library = store.create(&scope, "wiki", PRIVATE, "")?;
    let other = store.create(&scope, "other", PRIVATE, "")?;
    let source = store.import_text(&scope, &library.id, "source", PRIVATE, "Evidence")?;
    let foreign = store.import_text(&scope, &other.id, "foreign", PRIVATE, "Evidence")?;
    let chunk = store.source_chunks(
        &scope,
        &library.id,
        &source.source_id,
        &source.revision_id,
        0,
        100,
    )?;
    for (invalid, code, field) in [
        (
            "sourceId",
            "wiki_evidence_source_missing",
            "citations/0/sourceId",
        ),
        (
            "revisionId",
            "wiki_evidence_revision_missing",
            "citations/0/revisionId",
        ),
        (
            "chunkId",
            "wiki_evidence_chunk_missing",
            "citations/0/chunkId",
        ),
        ("quote", "wiki_evidence_quote_span", "citations/0/quote"),
        ("empty", "wiki_evidence_quote_bounds", "citations/0/quote"),
        ("citations", "wiki_evidence_citations_bounds", "citations"),
        (
            "missingRelation",
            "wiki_candidate_related_target_missing",
            "relatedPageIds/0",
        ),
        (
            "selfRelation",
            "wiki_candidate_self_reference",
            "relatedPageIds/0",
        ),
        (
            "largeRelations",
            "wiki_candidate_relations_bounds",
            "relatedPageIds",
        ),
    ] {
        let mut page = KnowledgePageDraft {
            page_id: uuid::Uuid::new_v4().to_string(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: PRIVATE.into(),
            markdown: PRIVATE.into(),
            citations: vec![KnowledgeCitation {
                source_id: source.source_id.clone(),
                revision_id: source.revision_id.clone(),
                chunk_id: chunk[0].chunk_id.clone(),
                quote: "Evidence".into(),
            }],
            related_page_ids: vec![],
        };
        match invalid {
            "sourceId" => {
                // Real foreign identities must not resolve through the other library.
                page.citations[0].source_id = foreign.source_id.clone();
                page.citations[0].revision_id = foreign.revision_id.clone();
            }
            "revisionId" => page.citations[0].revision_id = PRIVATE.into(),
            "chunkId" => page.citations[0].chunk_id = PRIVATE.into(),
            "quote" => page.citations[0].quote = PRIVATE.into(),
            "empty" => page.citations[0].quote.clear(),
            "citations" => page.citations.clear(),
            "missingRelation" => page.related_page_ids.push(PRIVATE.into()),
            "selfRelation" => page.related_page_ids.push(page.page_id.clone()),
            "largeRelations" => page.related_page_ids = vec![PRIVATE.into(); 129],
            _ => unreachable!(),
        }
        let error = store
            .commit_generated_pages(&scope, &library.id, "failed-commit", vec![page])
            .unwrap_err();
        let pointer = format!("/pages/0/{field}");
        assert_eq!(error.to_string(), format!("{code} at {pointer}"));
        assert!(!format!("{error:#}").contains(PRIVATE));
        assert!(store.list_pages(&scope, &library.id, None, 100)?.is_empty());
        record_safe_failure(
            &mut store,
            &scope,
            &library.id,
            &source.source_id,
            &source.revision_id,
            &error,
            "commit_validation",
            code,
            &pointer,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn record_safe_failure(
    store: &mut KnowledgeCatalog,
    scope: &KnowledgeScope,
    library: &str,
    source: &str,
    revision: &str,
    error: &anyhow::Error,
    stage: &str,
    code: &str,
    field: &str,
) -> Result<()> {
    let job = store.enqueue_ingest(
        scope,
        library,
        &uuid::Uuid::new_v4().to_string(),
        source,
        revision,
        "recipe",
        "en",
    )?;
    let lease = store.claim_job(scope, library, &job.id)?.unwrap();
    store.record_job_candidate_failure(scope, library, &lease, error)?;
    let detail = store
        .read_job(scope, library, &job.id)?
        .error_detail
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&detail)?,
        json!({"stage":stage,"errorType":code,"field":field})
    );
    assert!(!detail.contains(PRIVATE));
    let public_code = if error
        .chain()
        .any(|cause| cause.to_string() == "Wiki shared repair budget exceeded")
    {
        "repair_budget_exceeded"
    } else {
        match code {
            "wiki_candidate_self_reference" | "wiki_candidate_related_target_missing" => {
                "invalid_model_output"
            }
            "wiki_candidate_relations_bounds" => "ingest_failed",
            _ => "invalid_evidence",
        }
    };
    store.stop_job_with_reason(scope, library, &lease, "failed", public_code)?;
    assert_eq!(
        store
            .read_job(scope, library, &job.id)?
            .error_code
            .as_deref(),
        Some(public_code)
    );
    Ok(())
}
