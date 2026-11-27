#[path = "fixtures/organization.rs"]
mod organization_fixture;
use anyhow::Result;
use async_trait::async_trait;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, WikiIngestRequest, WikiModel, WikiModelRequest, WikiProposal,
};
use serde_json::{Value, json};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

struct UnusedRelatedModel {
    repairs_correctly: bool,
    blocking_review: bool,
    stages: Mutex<Vec<String>>,
    remembered: Mutex<Vec<Value>>,
}
#[async_trait]
impl WikiModel for UnusedRelatedModel {
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
        let repairing = request.stage == "format_repair";
        if repairing {
            assert!(
                input["validationError"]
                    .as_str()
                    .unwrap()
                    .contains("wiki_candidate_related_target_missing at /pages/0/relatedPageIds/0")
            );
            input = input["originalInput"].clone();
        }
        let source = &input["source"];
        let chunk = &source["chunks"][0];
        Ok(organization_fixture::with_proof(&input,json!({"pages":[{"pageId":input["newPageIds"][0],"expectedRevision":null,"kind":"concept",
            "title":"Evidence","markdown":"Supported evidence",
            "citations":[{"sourceId":source["sourceId"],"revisionId":source["revisionId"],"chunkId":chunk["chunkId"],"quote":chunk["text"]}],
            "relatedPageIds":if repairing && self.repairs_correctly {json!([])} else {json!([input["newPageIds"][1]])}}],
            "reviewNotes":if self.blocking_review && !repairing {json!(["Unresolved source scope"])} else {json!([])}})).to_string())
    }
    fn remember_proposal(
        &self,
        _request: &WikiModelRequest,
        proposal: &WikiProposal,
    ) -> Result<()> {
        self.remembered
            .lock()
            .unwrap()
            .push(serde_json::to_value(proposal)?);
        Ok(())
    }
}

#[tokio::test]
async fn unused_allocated_relation_is_repaired_before_cache_and_publishes_valid_evidence()
-> Result<()> {
    check(true, false).await
}

#[tokio::test]
async fn repeated_structural_refusal_exhausts_shared_budget_without_cache_or_publication()
-> Result<()> {
    check(false, false).await
}

#[tokio::test]
async fn successful_structure_repair_cannot_remove_blocking_review() -> Result<()> {
    check(true, true).await
}

async fn check(repairs_correctly: bool, blocking_review: bool) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let library = store.create(&scope, "wiki", "Wiki", "")?;
    let source = store.import_text(
        &scope,
        &library.id,
        "source",
        "Real source",
        "Supported evidence",
    )?;
    let model = UnusedRelatedModel {
        repairs_correctly,
        blocking_review,
        stages: Mutex::new(vec![]),
        remembered: Mutex::new(vec![]),
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
        .await;
    if repairs_correctly {
        let prepared = prepared?;
        assert_eq!(
            model.stages.lock().unwrap().as_slice(),
            if blocking_review {
                vec!["analysis", "generation", "format_repair"]
            } else {
                vec!["analysis", "generation", "format_repair", "source_support"]
            }
        );
        assert_eq!(
            model.remembered.lock().unwrap().len(),
            if blocking_review { 1 } else { 2 }
        );
        assert!(
            model.remembered.lock().unwrap()[0]["pages"][0]["relatedPageIds"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        if blocking_review {
            assert_eq!(prepared.proposal.review_notes, ["Unresolved source scope"]);
            assert!(store.list_pages(&scope, &library.id, None, 100)?.is_empty());
        } else {
            store.commit_generated_pages(
                &scope,
                &library.id,
                "publish",
                prepared.proposal.pages,
            )?;
            assert!(!store.list_pages(&scope, &library.id, None, 100)?.is_empty());
        }
    } else {
        let error = prepared.err().expect("invalid reference must fail");
        assert!(error.to_string().contains("shared repair budget exceeded"));
        assert_eq!(
            KnowledgeCatalog::candidate_failure_code(&error),
            Some("wiki_candidate_related_target_missing")
        );
        assert_eq!(
            model.stages.lock().unwrap().len(),
            5,
            "three shared repairs plus original analysis/generation"
        );
        assert!(model.remembered.lock().unwrap().is_empty());
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
            json!({"stage":"candidate_validation","errorType":"wiki_candidate_related_target_missing","field":"/pages/0/relatedPageIds/0"})
        );
        store.pause_job(&scope, &library.id, &job.id)?;
        store.resume_job(&scope, &library.id, &job.id)?;
        let new_lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
        store.record_job_candidate_failure(&scope, &library.id, &lease, &error)?;
        assert!(
            store
                .read_job(&scope, &library.id, &job.id)?
                .error_detail
                .is_none(),
            "revoked owner cannot write a new run's diagnostics"
        );
        store.record_job_candidate_failure(
            &scope,
            &library.id,
            &new_lease,
            &anyhow::anyhow!("PRIVATE_MODEL_RESPONSE_OR_CREDENTIAL"),
        )?;
        assert!(
            store
                .read_job(&scope, &library.id, &job.id)?
                .error_detail
                .is_none()
        );
    }
    Ok(())
}

#[tokio::test]
async fn analysis_bounds_fail_with_safe_field_diagnostic_before_analysis_cache() -> Result<()> {
    struct BadAnalysis {
        remembered: Mutex<bool>,
    }
    #[async_trait]
    impl WikiModel for BadAnalysis {
        async fn complete(&self, request: WikiModelRequest) -> Result<String> {
            if request.stage == "format_repair" {
                return Ok(json!({"queries":["q1","q2","q3","q4"]}).to_string());
            }
            assert_eq!(request.stage, "analysis");
            Ok(json!({"summary":"PRIVATE_RESPONSE_SENTINEL","queries":["q1","q2","q3","q4"],"conflicts":[]}).to_string())
        }
        fn remember_analysis(
            &self,
            _request: &WikiModelRequest,
            _analysis: &kcoder_knowledge::WikiAnalysis,
        ) -> Result<()> {
            *self.remembered.lock().unwrap() = true;
            Ok(())
        }
    }
    let temp = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let library = store.create(&scope, "wiki", "Wiki", "")?;
    let source = store.import_text(
        &scope,
        &library.id,
        "source",
        "Evidence",
        "Supported evidence",
    )?;
    let model = BadAnalysis {
        remembered: Mutex::new(false),
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
        .expect("invalid analysis must fail");
    assert_eq!(
        KnowledgeCatalog::candidate_failure_code(&error),
        Some("wiki_analysis_query_bounds")
    );
    assert!(!*model.remembered.lock().unwrap());
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
        json!({"stage":"analysis_validation","errorType":"wiki_analysis_query_bounds","field":"/queries"})
    );
    assert!(!detail.contains("PRIVATE_RESPONSE_SENTINEL"));
    Ok(())
}
