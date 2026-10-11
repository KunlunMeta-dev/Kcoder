//! Owned deterministic fixtures for v9 repair/caching boundaries, not model quality.
use anyhow::Result;
use async_trait::async_trait;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, PreparedWikiUpdate, WikiAnalysis, WikiIngestRequest,
    WikiJobLease, WikiModel, WikiModelRequest, WikiProposal,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

const TEXT: &str =
    "Owned PDF-style evidence:\nincremen-\ntal  consistency\tA.\nVersion B contradicts A.";
const SUMMARY: &str = "Facts remain verbatim.\nVersion B contradicts A.";
const CONFLICT: &str = "Unresolved version contradiction";
#[derive(Clone, Copy)]
enum QueryResponse {
    Correct,
    RepeatInvalid,
    MalformedOnce,
    Missing,
}
struct FixtureModel {
    path: PathBuf,
    scope: KnowledgeScope,
    library: String,
    lease: Mutex<WikiJobLease>,
    queries: Vec<String>,
    response: QueryResponse,
    has_pages: bool,
    calls: Mutex<Vec<String>>,
    repair_calls: AtomicUsize,
    remembered: AtomicUsize,
    fail_generation_once: AtomicBool,
    wrong_id: bool,
    cancel_after_analysis: bool,
    revoke_during_repair: bool,
    cancellation: CancellationToken,
}
impl FixtureModel {
    fn key(request: &WikiModelRequest) -> String {
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!({
                    "stage":request.stage,"system":request.system,"user":request.user,
                }))
                .unwrap()
            )
        )
    }
    fn original(mut value: &Value) -> &Value {
        while let Some(input) = value.get("originalInput") {
            value = input;
        }
        value
    }
    fn proposal(&self, input: &Value) -> Result<String> {
        let bindings = &input["identityBindings"];
        assert_eq!(bindings["source"]["sourceId"], input["source"]["sourceId"]);
        assert_eq!(
            bindings["source"]["revisionId"],
            input["source"]["revisionId"]
        );
        assert_eq!(bindings["source"]["chunks"][0]["chunkId"], "chunk-1");
        assert_eq!(bindings["source"]["chunks"][0]["page"], 7);
        for page in bindings["exampleProposal"]["pages"].as_array().unwrap() {
            assert!(
                input["newPageIds"]
                    .as_array()
                    .unwrap()
                    .contains(&page["pageId"])
            );
            assert!(page["expectedRevision"].is_null());
            if page["kind"] == "overview" {
                assert_eq!(page["pageId"], input["overviewPageId"]);
            }
            for citation in page["citations"].as_array().unwrap() {
                assert_eq!(citation["sourceId"], input["source"]["sourceId"]);
                assert_eq!(citation["revisionId"], input["source"]["revisionId"]);
                assert_eq!(citation["chunkId"], "chunk-1");
                assert_eq!(citation["quote"], TEXT);
            }
        }
        for page in bindings["existingPageTargets"].as_array().unwrap() {
            assert!(
                input["existingPages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|existing| existing["draft"]["pageId"] == page["pageId"]
                        && existing["revisionId"] == page["expectedRevision"])
            );
        }
        assert_eq!(input["analysis"]["summary"], SUMMARY);
        assert_eq!(input["analysis"]["conflicts"], json!([CONFLICT]));
        let source = &input["source"];
        Ok(json!({"pages":[{"pageId":if self.wrong_id {json!("synthetic-unoffered-slug")} else {input["newPageIds"][0].clone()},
            "expectedRevision":null,"kind":"source","title":"Source","markdown":TEXT,
            "citations":[{"sourceId":source["sourceId"],"revisionId":source["revisionId"],
                "chunkId":"chunk-1","quote":TEXT}],"relatedPageIds":[]}],"reviewNotes":[]}).to_string())
    }
}
#[async_trait]
impl WikiModel for FixtureModel {
    fn batch_identity(&self) -> String {
        self.lease.lock().unwrap().job.id.clone()
    }
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        if request.stage == "analysis" {
            let lease = self.lease.lock().unwrap();
            if let Some(cached) = KnowledgeCatalog::open(&self.path)?.cached_analysis(
                &self.scope,
                &self.library,
                &lease,
                &Self::key(&request),
            )? {
                return Ok(cached);
            }
        }
        self.calls.lock().unwrap().push(request.stage.into());
        let input: Value = serde_json::from_str(&request.user)?;
        if request.stage == "analysis" {
            assert_eq!(
                input["wiki"],
                json!({"hasPages":self.has_pages,"indexProvided":false})
            );
            assert!(request.system.contains(if self.has_pages {
                "Wiki has existing pages"
            } else {
                "Wiki currently has no pages"
            }));
            if self.cancel_after_analysis {
                self.cancellation.cancel();
            }
            return Ok(
                json!({"summary":SUMMARY,"queries":self.queries,"conflicts":[CONFLICT]})
                    .to_string(),
            );
        }
        if request.system.contains("Repair only Wiki analysis queries") {
            assert_eq!(request.stage, "format_repair");
            let original = Self::original(&input);
            assert_eq!(original["source"]["chunks"][0]["text"], TEXT);
            assert_eq!(original["wiki"]["indexProvided"], false);
            let attempt = self.repair_calls.fetch_add(1, Ordering::Relaxed);
            if self.revoke_during_repair {
                let lease = self.lease.lock().unwrap();
                let mut store = KnowledgeCatalog::open(&self.path)?;
                store.pause_job(&self.scope, &self.library, &lease.job.id)?;
                store.resume_job(&self.scope, &self.library, &lease.job.id)?;
            }
            return Ok(match self.response {
                QueryResponse::Correct => {
                    json!({"queries":if self.has_pages {vec!["Evidence"]} else {vec![]}})
                        .to_string()
                }
                QueryResponse::RepeatInvalid => json!({"queries":self.queries}).to_string(),
                QueryResponse::MalformedOnce if attempt == 0 => "malformed query repair".into(),
                QueryResponse::MalformedOnce => json!({"queries":[]}).to_string(),
                QueryResponse::Missing => "{}".into(),
            });
        }
        assert!(!request.system.contains("copy an offered ID"));
        assert!(request.system.contains("This is an unfinished template"));
        if request.stage == "generation" && self.fail_generation_once.swap(false, Ordering::Relaxed)
        {
            anyhow::bail!("injected generation interruption");
        }
        self.proposal(Self::original(&input))
    }
    fn remember_analysis(&self, request: &WikiModelRequest, analysis: &WikiAnalysis) -> Result<()> {
        assert_eq!(
            request.stage, "analysis",
            "cache uses the original request identity"
        );
        assert_eq!(analysis.summary, SUMMARY);
        assert_eq!(analysis.conflicts, [CONFLICT]);
        assert!(analysis.queries.len() <= 3 && analysis.queries.iter().all(|q| q.len() <= 256));
        KnowledgeCatalog::open(&self.path)?.remember_analysis(
            &self.scope,
            &self.library,
            &self.lease.lock().unwrap(),
            &Self::key(request),
            analysis,
        )?;
        self.remembered.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
    fn remember_proposal(&self, request: &WikiModelRequest, proposal: &WikiProposal) -> Result<()> {
        KnowledgeCatalog::open(&self.path)?.remember_proposal(
            &self.scope,
            &self.library,
            &self.lease.lock().unwrap(),
            &Self::key(request),
            proposal,
        )
    }
    fn cached_proposal(&self, request: &WikiModelRequest) -> Result<Option<WikiProposal>> {
        KnowledgeCatalog::open(&self.path)?.cached_proposal(
            &self.scope,
            &self.library,
            &self.lease.lock().unwrap(),
            &Self::key(request),
        )
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    source: String,
    revision: String,
    model: FixtureModel,
}
impl Fixture {
    fn new(queries: Vec<String>, response: QueryResponse, has_pages: bool) -> Result<Self> {
        assert!(TEXT.len() <= 3000);
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("wiki.sqlite");
        let mut store = KnowledgeCatalog::open(&path)?;
        let scope = KnowledgeScope::from_authenticated_host("owned-fixture", "local")?;
        let library = store.create(&scope, "wiki", "Wiki", "Preserve facts and contradictions")?;
        let source = store.import_extracted(
            &scope,
            &library.id,
            "source",
            "Owned fixture",
            b"owned original",
            "pdf",
            vec![kcoder_knowledge::SourceChunk {
                ordinal: 1,
                chunk_id: "chunk-1".into(),
                first_line: 1,
                last_line: 5,
                text: TEXT.into(),
                page: Some(7),
            }],
        )?;
        if has_pages {
            store.commit_generated_pages(&scope, &library.id, "existing", vec![serde_json::from_value(json!({
                "pageId":uuid::Uuid::new_v4().to_string(),"expectedRevision":null,"kind":"concept",
                "title":"Evidence","markdown":TEXT,"citations":[{"sourceId":source.source_id,
                    "revisionId":source.revision_id,"chunkId":"chunk-1","quote":TEXT}],"relatedPageIds":[]
            }))?])?;
        }
        let job = store.enqueue_ingest(
            &scope,
            &library.id,
            "job",
            &source.source_id,
            &source.revision_id,
            "v9",
            "en",
        )?;
        let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
        Ok(Self {
            _temp: temp,
            source: source.source_id,
            revision: source.revision_id,
            model: FixtureModel {
                path,
                scope,
                library: library.id,
                lease: Mutex::new(lease),
                queries,
                response,
                has_pages,
                calls: Mutex::new(vec![]),
                repair_calls: AtomicUsize::new(0),
                remembered: AtomicUsize::new(0),
                fail_generation_once: AtomicBool::new(false),
                wrong_id: false,
                cancel_after_analysis: false,
                revoke_during_repair: false,
                cancellation: CancellationToken::new(),
            },
        })
    }
    async fn prepare(&self) -> Result<PreparedWikiUpdate> {
        KnowledgeCatalog::open(&self.model.path)?
            .prepare_wiki_update(
                &self.model.scope,
                WikiIngestRequest {
                    library_id: &self.model.library,
                    source_id: &self.source,
                    source_revision: &self.revision,
                    after_chunk: 0,
                    output_language: "en",
                    context_tokens: 64000,
                },
                &self.model,
                &self.model.cancellation,
            )
            .await
    }
}
fn too_many(count: usize) -> Vec<String> {
    (0..count).map(|i| format!("query-{i}")).collect()
}

#[tokio::test]
async fn query_count_and_utf8_bytes_repair_preserves_facts_conflicts_quotes_and_real_id_bindings()
-> Result<()> {
    for (queries, has_pages) in [
        (too_many(5), false),
        (too_many(6), true),
        (vec!["中".repeat(86)], false),
    ] {
        let fixture = Fixture::new(queries, QueryResponse::Correct, has_pages)?;
        let prepared = fixture.prepare().await?;
        assert_eq!(
            prepared.format_version,
            kcoder_knowledge::PREPARATION_VERSION
        );
        assert_eq!(prepared.analysis.summary, SUMMARY);
        assert_eq!(prepared.analysis.conflicts, [CONFLICT]);
        assert_eq!(
            prepared.analysis.queries,
            if has_pages { vec!["Evidence"] } else { vec![] }
        );
        assert_eq!(
            fixture.model.calls.lock().unwrap().as_slice(),
            ["analysis", "format_repair", "generation"]
        );
        for page in &prepared.proposal.pages {
            assert_eq!(page.citations[0].quote, TEXT);
        }
        let mut store = KnowledgeCatalog::open(&fixture.model.path)?;
        assert_eq!(prepared.proposal.review_notes.len(), 1);
        assert!(prepared.proposal.review_notes[0].contains("no validated purpose/source plan"));
        let lease = fixture.model.lease.lock().unwrap();
        store.save_job_checkpoint(
            &fixture.model.scope,
            &fixture.model.library,
            &lease,
            &kcoder_knowledge::WikiCheckpoint {
                through_chunk: prepared.through_chunk,
                has_more_chunks: prepared.has_more_chunks,
                proposal: prepared.proposal,
            },
        )?;
        store.stop_job_with_reason(
            &fixture.model.scope,
            &fixture.model.library,
            &lease,
            "awaiting_review",
            "review_required",
        )?;
        assert!(
            store
                .commit_job_checkpoint(&fixture.model.scope, &fixture.model.library, &lease)
                .is_err()
        );
    }
    Ok(())
}

#[tokio::test]
async fn repeated_invalid_queries_exhaust_shared_three_repairs_without_analysis_cache() -> Result<()>
{
    let fixture = Fixture::new(too_many(5), QueryResponse::RepeatInvalid, false)?;
    let error = fixture
        .prepare()
        .await
        .err()
        .expect("must reject excessive queries");
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
        fixture.model.calls.lock().unwrap().as_slice(),
        [
            "analysis",
            "format_repair",
            "format_repair",
            "format_repair"
        ]
    );
    assert_eq!(fixture.model.remembered.load(Ordering::Relaxed), 0);
    let mut store = KnowledgeCatalog::open(&fixture.model.path)?;
    let lease = fixture.model.lease.lock().unwrap();
    store.record_job_candidate_failure(
        &fixture.model.scope,
        &fixture.model.library,
        &lease,
        &error,
    )?;
    let detail = store
        .read_job(&fixture.model.scope, &fixture.model.library, &lease.job.id)?
        .error_detail
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&detail)?,
        json!({"stage":"analysis_validation","errorType":"wiki_analysis_query_bounds","field":"/queries"})
    );
    assert!(
        store
            .list_pages(&fixture.model.scope, &fixture.model.library, None, 100)?
            .is_empty()
    );
    Ok(())
}

#[tokio::test]
async fn query_json_repairs_and_generation_identity_repairs_share_one_budget() -> Result<()> {
    let mut fixture = Fixture::new(too_many(6), QueryResponse::MalformedOnce, false)?;
    fixture.model.wrong_id = true;
    let error = fixture
        .prepare()
        .await
        .err()
        .expect("unoffered IDs must remain rejected");
    assert_eq!(
        KnowledgeCatalog::candidate_failure_code(&error),
        Some("wiki_candidate_unallocated_page_id")
    );
    assert!(
        error
            .to_string()
            .contains("Wiki shared repair budget exceeded")
    );
    assert_eq!(
        fixture.model.calls.lock().unwrap().as_slice(),
        [
            "analysis",
            "format_repair",
            "format_repair",
            "generation",
            "format_repair"
        ]
    );
    assert_eq!(fixture.model.remembered.load(Ordering::Relaxed), 1);
    let store = KnowledgeCatalog::open(&fixture.model.path)?;
    assert_eq!(
        store.source_chunks(
            &fixture.model.scope,
            &fixture.model.library,
            &fixture.source,
            &fixture.revision,
            0,
            9
        )?[0]
            .text,
        TEXT
    );
    assert!(
        store
            .list_pages(&fixture.model.scope, &fixture.model.library, None, 100)?
            .is_empty()
    );
    Ok(())
}

#[tokio::test]
async fn omitted_optional_repair_queries_default_to_empty_without_rebuying_a_repair() -> Result<()>
{
    let fixture = Fixture::new(too_many(5), QueryResponse::Missing, false)?;
    let prepared = fixture.prepare().await?;
    assert!(prepared.analysis.queries.is_empty());
    assert_eq!(
        fixture.model.calls.lock().unwrap().as_slice(),
        ["analysis", "format_repair", "generation"]
    );
    assert_eq!(fixture.model.remembered.load(Ordering::Relaxed), 1);
    Ok(())
}

#[tokio::test]
async fn cancellation_and_revoked_lease_stop_repair_before_cache_or_publication() -> Result<()> {
    let mut cancelled = Fixture::new(too_many(5), QueryResponse::Correct, false)?;
    cancelled.model.cancel_after_analysis = true;
    let error = cancelled.prepare().await.err().expect("must cancel");
    assert!(error.to_string().contains("cancelled"));
    assert_eq!(
        cancelled.model.calls.lock().unwrap().as_slice(),
        ["analysis"]
    );
    assert_eq!(cancelled.model.remembered.load(Ordering::Relaxed), 0);
    let mut revoked = Fixture::new(too_many(5), QueryResponse::Correct, false)?;
    revoked.model.revoke_during_repair = true;
    let error = revoked
        .prepare()
        .await
        .err()
        .expect("must revoke cache ownership");
    assert!(error.to_string().contains("lease lost"));
    assert_eq!(
        revoked.model.calls.lock().unwrap().as_slice(),
        ["analysis", "format_repair"]
    );
    assert_eq!(revoked.model.remembered.load(Ordering::Relaxed), 0);
    let store = KnowledgeCatalog::open(&revoked.model.path)?;
    assert!(
        store
            .list_pages(&revoked.model.scope, &revoked.model.library, None, 100)?
            .is_empty()
    );
    Ok(())
}

#[tokio::test]
async fn resumed_job_reuses_repaired_analysis_under_original_request_key() -> Result<()> {
    let fixture = Fixture::new(too_many(5), QueryResponse::Correct, false)?;
    fixture
        .model
        .fail_generation_once
        .store(true, Ordering::Relaxed);
    assert!(fixture.prepare().await.is_err());
    assert_eq!(fixture.model.remembered.load(Ordering::Relaxed), 1);
    let mut store = KnowledgeCatalog::open(&fixture.model.path)?;
    {
        let mut old_lease = fixture.model.lease.lock().unwrap();
        store.pause_job(
            &fixture.model.scope,
            &fixture.model.library,
            &old_lease.job.id,
        )?;
        store.resume_job(
            &fixture.model.scope,
            &fixture.model.library,
            &old_lease.job.id,
        )?;
        *old_lease = store
            .claim_job(
                &fixture.model.scope,
                &fixture.model.library,
                &old_lease.job.id,
            )?
            .unwrap();
    }
    let prepared = fixture.prepare().await?;
    assert_eq!(prepared.analysis.summary, SUMMARY);
    assert_eq!(prepared.analysis.conflicts, [CONFLICT]);
    assert_eq!(
        fixture.model.calls.lock().unwrap().as_slice(),
        ["analysis", "format_repair", "generation", "generation"]
    );
    assert_eq!(fixture.model.repair_calls.load(Ordering::Relaxed), 1);
    Ok(())
}
