//! Owned deterministic organization fixtures; no Provider quality/cost claim.
use anyhow::Result;
use async_trait::async_trait;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, WikiAnalysis, WikiIngestRequest, WikiJobLease, WikiModel,
    WikiModelRequest, WikiProposal,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

struct Model {
    path: PathBuf,
    scope: KnowledgeScope,
    library: String,
    lease: WikiJobLease,
    calls: Arc<Mutex<Vec<String>>>,
    missing: bool,
    refuse: bool,
    remaining: u32,
    interrupt: AtomicBool,
    fault: Option<&'static str>,
    reports: bool,
    existing_copy: bool,
    omit_inverse: bool,
    all_lines: bool,
    plan_fault: Option<&'static str>,
    requests: Mutex<Vec<WikiModelRequest>>,
    requested: Mutex<Vec<(String, u32, u32)>>,
    provider_cap: Option<u32>,
    omit_refs: bool,
    split_topics: bool,
    cancel_on_repair: Option<CancellationToken>,
}
impl Model {
    fn key(&self, request: &WikiModelRequest) -> String {
        format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "{}\0{}\0{}\0{}\0{}",
                    self.lease.job.recipe_key,
                    request.stage,
                    request.system,
                    request.user,
                    request.max_output_tokens
                )
                .as_bytes()
            )
        )
    }
    fn proposal(&self, input: &Value, complete: bool, pending: Option<&Value>) -> Value {
        let inventory = &input["sourceInventory"];
        let source = &input["source"];
        let required = inventory["units"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|unit| unit["kind"] != "heading")
            .collect::<Vec<_>>();
        let chosen = required
            .iter()
            .take(if complete { required.len() } else { 1 })
            .copied()
            .collect::<Vec<_>>();
        let mut body = String::new();
        let mut citations = Vec::new();
        let mut placements = Vec::new();
        let page_id = pending
            .map(|draft| draft["pages"][0]["pageId"].clone())
            .unwrap_or_else(|| input["newPageIds"][0].clone());
        for unit in chosen {
            let chunk = source["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|chunk| chunk["chunkId"] == unit["chunkId"])
                .unwrap();
            let text = &chunk["text"].as_str().unwrap()[unit["startByte"].as_u64().unwrap() as usize
                ..unit["endByte"].as_u64().unwrap() as usize];
            let first = body.lines().count() + 1;
            body.push_str(text);
            if !body.ends_with('\n') {
                body.push('\n');
            }
            let last = body.lines().count();
            let mut refs = vec![unit["reference"].clone()];
            refs.extend(unit["contextRefs"].as_array().unwrap().iter().cloned());
            for reference in &refs {
                if !citations
                    .iter()
                    .any(|citation: &Value| citation["ref"] == *reference)
                {
                    citations.push(json!({"ref":reference}));
                }
            }
            placements.push(json!({"unitId":unit["id"],"pageId":page_id,"firstLine":first,"lastLine":last,"citationRefs":refs}));
        }
        json!({"pages":[{"pageId":page_id,"expectedRevision":null,"kind":"concept","title":"Requested state guarantees",
            "markdown":body,"citations":citations,"relatedPageIds":[]}],"reviewNotes":[],
            "organizationProof":{"binding":inventory["binding"],"placements":placements}})
    }
}
#[async_trait]
impl WikiModel for Model {
    fn output_token_budget(&self, suggested: u32) -> Result<u32> {
        Ok(self
            .provider_cap
            .map_or(suggested, |cap| suggested.min(cap)))
    }
    async fn complete_with_output_limit(
        &self,
        mut request: WikiModelRequest,
        limit: u32,
    ) -> Result<String> {
        self.requested.lock().unwrap().push((
            request.stage.into(),
            request.max_output_tokens,
            limit,
        ));
        if request.stage == "analysis"
            && let Some(cached) = KnowledgeCatalog::open(&self.path)?.cached_analysis(
                &self.scope,
                &self.library,
                &self.lease,
                &self.key(&request),
            )?
        {
            return Ok(cached);
        }
        self.requests.lock().unwrap().push(request.clone());
        request.max_output_tokens = request.max_output_tokens.min(limit);
        self.complete(request).await
    }
    fn remaining_shared_repairs(&self) -> Result<u32> {
        Ok(self.remaining)
    }
    fn batch_identity(&self) -> String {
        self.lease.job.id.clone()
    }
    fn cached_proposal(&self, request: &WikiModelRequest) -> Result<Option<WikiProposal>> {
        KnowledgeCatalog::open(&self.path)?.cached_proposal(
            &self.scope,
            &self.library,
            &self.lease,
            &self.key(request),
        )
    }
    fn remember_proposal(&self, request: &WikiModelRequest, proposal: &WikiProposal) -> Result<()> {
        KnowledgeCatalog::open(&self.path)?.remember_proposal(
            &self.scope,
            &self.library,
            &self.lease,
            &self.key(request),
            proposal,
        )?;
        if request.stage == "organization_repair" && self.interrupt.swap(false, Ordering::SeqCst) {
            anyhow::bail!("interruption after completed complement cache");
        }
        Ok(())
    }
    fn remember_analysis(&self, request: &WikiModelRequest, analysis: &WikiAnalysis) -> Result<()> {
        KnowledgeCatalog::open(&self.path)?.remember_analysis(
            &self.scope,
            &self.library,
            &self.lease,
            &self.key(request),
            analysis,
        )
    }
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        let mut store = KnowledgeCatalog::open(&self.path)?;
        if request.stage == "analysis"
            && let Some(cached) = store.cached_analysis(
                &self.scope,
                &self.library,
                &self.lease,
                &self.key(&request),
            )?
        {
            return Ok(cached);
        }
        let reservation = store
            .budget_reserve_for_stage(
                &self.scope,
                &self.library,
                &self.lease,
                64,
                request.stage,
                None,
            )?
            .unwrap();
        self.calls.lock().unwrap().push(request.stage.into());
        let input: Value = serde_json::from_str(&request.user)?;
        if request.stage == "analysis" {
            let shape = request
                .system
                .split("actual offered source/purpose IDs: ")
                .nth(1)
                .unwrap()
                .split(". The example organizationPlan")
                .next()
                .unwrap();
            let parsed: WikiAnalysis = serde_json::from_str(shape)?;
            assert_eq!(
                serde_json::to_value(parsed.organization_plan.unwrap())?["binding"],
                input["sourceInventory"]["binding"]
            );
            let template: WikiAnalysis =
                serde_json::from_value(json!({"summary":"shape","queries":[],"conflicts":[],
                "organizationPlan":input["sourceInventory"]["planTemplate"]}))?;
            assert!(
                template.organization_plan.unwrap().units.is_empty(),
                "empty template is not a claimed complete plan"
            );
        }
        if request.stage == "generation" {
            let shape = request
                .system
                .split("copyable IDs/binding is: ")
                .nth(1)
                .unwrap()
                .split(". This is an unfinished template")
                .next()
                .unwrap();
            let parsed: WikiProposal = serde_json::from_str(shape)?;
            assert_eq!(parsed.pages[0].page_id, input["newPageIds"][0]);
            assert_eq!(
                serde_json::to_value(parsed.organization_proof.unwrap())?["binding"],
                input["sourceInventory"]["binding"]
            );
        }
        let mut response = if request.stage == "analysis" {
            let inventory = &input["sourceInventory"];
            let units = inventory["units"].as_array().unwrap();
            let required = units
                .iter()
                .filter(|unit| unit["kind"] != "heading")
                .map(|unit| unit["id"].clone())
                .collect::<Vec<_>>();
            let aspects = inventory["aspects"].as_array().unwrap();
            json!({"summary":"Organize each literal purpose with its original source evidence","queries":if self.existing_copy {vec!["Long"]} else {vec![]},"conflicts":[],
                "organizationPlan":{"binding":inventory["binding"],
                    "aspects":aspects.iter().map(|aspect|json!({"aspectId":aspect["id"],"unitIds":required})).collect::<Vec<_>>(),
                    "units":units.iter().map(|unit|json!({"unitId":unit["id"],"disposition":if unit["kind"]=="heading" {"context"} else {"required"},
                        "purposeAspectIds":if unit["kind"]=="heading" {vec![]} else {aspects.iter().map(|aspect|aspect["id"].clone()).collect()},
                        "reason":if unit["kind"]=="heading" {"Preserved section context"} else {""}})).collect::<Vec<_>>()}})
        } else if request.stage == "format_repair" && input["repairKind"] == "organization_plan" {
            assert!(
                input["validationError"]["field"]
                    .as_str()
                    .unwrap()
                    .starts_with("/organizationPlan")
            );
            let original = &input["originalInput"];
            let inventory = &original["sourceInventory"];
            let repaired = organization_fixture_plan(inventory);
            json!({"organizationPlan":repaired})
        } else if request.stage == "organization_repair" {
            if let Some(cancel) = &self.cancel_on_repair {
                cancel.cancel();
            }
            if input["repairKind"] == "organization_proof" {
                assert!(
                    [
                        "wiki_organization_target_lines",
                        "wiki_organization_page_kind"
                    ]
                    .contains(&input["validationError"]["errorType"].as_str().unwrap())
                );
                assert!(
                    input.get("pendingProposal").is_none(),
                    "proof-only repair does not resend full mutable proposal"
                );
                let mut proof = input["previousProof"].clone();
                proof.as_object_mut().unwrap().remove("hostBodyHashes");
                for placement in proof["placements"].as_array_mut().unwrap() {
                    placement.as_object_mut().unwrap().remove("firstLine");
                    placement.as_object_mut().unwrap().remove("lastLine");
                    placement["allLines"] = json!(true);
                    if self.fault == Some("role_target") {
                        let topic = input["pageLineBindings"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|page| page["kind"] == "concept")
                            .unwrap();
                        assert!(placement["citationRefs"].as_array().unwrap().iter().all(
                            |reference| {
                                topic["citationRefs"]
                                    .as_array()
                                    .unwrap()
                                    .contains(reference)
                            }
                        ));
                        placement["pageId"] = topic["pageId"].clone();
                    }
                }
                json!({"organizationProof":proof})
            } else {
                assert!(input["missingUnitIds"].as_array().unwrap().len() >= 2);
                self.proposal(
                    &input["originalInput"],
                    !self.refuse,
                    Some(&input["pendingProposal"]),
                )
            }
        } else if request.stage == "source_support" {
            let shape = request
                .system
                .split("valid actual-ID shape: ")
                .nth(1)
                .unwrap()
                .split(". This is a shape example")
                .next()
                .unwrap();
            let parsed: Value = serde_json::from_str(shape)?;
            assert!(parsed["units"][0].is_object() && parsed["organizationUnits"][0].is_object());
            assert_eq!(
                parsed["organizationUnits"][0]["unitId"],
                input["organizationInventory"]["units"][0]["id"]
            );
            let inventory = &input["organizationInventory"];
            let placements = &input["candidate"]["organizationProof"]["placements"];
            json!({"sourceCoverage":"complete","units":input["units"].as_array().unwrap().iter().map(|unit|
                json!({"pageId":unit["pageId"],"unit":unit["unit"],"verdict":"supported","citationIndices":[input["citationBindings"].as_array().unwrap().iter().find(|binding|binding["pageId"]==unit["pageId"]).unwrap()["citations"].as_array().unwrap().iter()
                    .position(|citation|citation["quote"].as_str().unwrap().contains(unit["text"].as_str().unwrap())).unwrap_or(0)]})).collect::<Vec<_>>(),
                "organizationUnits":inventory["units"].as_array().unwrap().iter().map(|unit|json!({"unitId":unit["id"],"verdict":"supported",
                    "placementIndices":placements.as_array().unwrap().iter().enumerate().filter(|(_,placement)|placement["unitId"]==unit["id"]).map(|(index,_)|index).collect::<Vec<_>>()})).collect::<Vec<_>>()})
        } else {
            assert_eq!(request.stage, "generation");
            self.proposal(&input, !self.missing, None)
        };
        if request.stage == "analysis" {
            if self.omit_inverse {
                response["organizationPlan"]
                    .as_object_mut()
                    .unwrap()
                    .remove("aspects");
            }
            if let Some(fault) = self.plan_fault {
                match fault {
                    "missing_unit" => {
                        response["organizationPlan"]["units"]
                            .as_array_mut()
                            .unwrap()
                            .pop();
                    }
                    "wrong_inverse" => {
                        response["organizationPlan"]["aspects"][0]["unitIds"] = json!([])
                    }
                    "foreign" => {
                        response["organizationPlan"]["units"][0]["unitId"] = json!("foreign-unit")
                    }
                    _ => unreachable!(),
                }
            }
        }
        if request.stage == "generation" && self.split_topics {
            let middle = response["organizationProof"]["placements"]
                .as_array()
                .unwrap()
                .len()
                / 2;
            let boundary = response["organizationProof"]["placements"][middle]["firstLine"]
                .as_u64()
                .unwrap() as usize
                - 1;
            let body = response["pages"][0]["markdown"]
                .as_str()
                .unwrap()
                .to_string();
            let lines: Vec<_> = body.lines().collect();
            let mut second = response["pages"][0].clone();
            second["pageId"] = input["newPageIds"][1].clone();
            second["markdown"] = json!(format!("{}\n", lines[boundary..].join("\n")));
            response["pages"][0]["markdown"] = json!(format!("{}\n", lines[..boundary].join("\n")));
            for placement in response["organizationProof"]["placements"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .skip(middle)
            {
                placement["pageId"] = second["pageId"].clone();
                for field in ["firstLine", "lastLine"] {
                    placement[field] =
                        json!(placement[field].as_u64().unwrap() as usize - boundary);
                }
            }
            response["pages"].as_array_mut().unwrap().push(second);
        }
        if request.stage == "generation" && self.omit_refs {
            for placement in response["organizationProof"]["placements"]
                .as_array_mut()
                .unwrap()
            {
                placement.as_object_mut().unwrap().remove("citationRefs");
            }
            for page in response["pages"].as_array_mut().unwrap() {
                page["citations"] = json!([]);
            }
        }
        if request.stage == "generation" && self.all_lines {
            for placement in response["organizationProof"]["placements"]
                .as_array_mut()
                .unwrap()
            {
                placement.as_object_mut().unwrap().remove("firstLine");
                placement.as_object_mut().unwrap().remove("lastLine");
                placement["allLines"] = json!(true);
            }
        }
        if request.stage == "generation" && self.existing_copy {
            assert!(
                request.max_output_tokens > 4096,
                "existing complete bodies retain their sized output allowance"
            );
            let mut retained = input["existingPages"]
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
            assert_eq!(retained.len(), 4);
            retained.extend(response["pages"].as_array().unwrap().iter().cloned());
            response["pages"] = json!(retained);
        }
        if request.stage == "generation"
            && let Some(fault) = self.fault
        {
            match fault {
                "source_target" => response["pages"][0]["kind"] = json!("source"),
                "foreign_page" => {
                    response["organizationProof"]["placements"][0]["pageId"] = json!("foreign-page")
                }
                "role_target" => {
                    let mut overview = response["pages"][0].clone();
                    overview["pageId"] = input["overviewPageId"].clone();
                    overview["kind"] = json!("overview");
                    overview["title"] = json!("Source index");
                    overview["markdown"] = json!("Source index");
                    response["pages"].as_array_mut().unwrap().push(overview);
                    for placement in response["organizationProof"]["placements"]
                        .as_array_mut()
                        .unwrap()
                    {
                        placement["pageId"] = input["overviewPageId"].clone();
                    }
                }
                "uncertain_compound" => {}
                "bad_line" => {
                    response["organizationProof"]["placements"][0]["firstLine"] = json!(0)
                }
                "bad_ref" => {
                    response["organizationProof"]["placements"][0]["citationRefs"] = json!([input
                        ["citationSpans"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|span| span["wholeChunk"] == true)
                        .unwrap()["ref"]])
                }
                "unknown_unit" => {
                    response["organizationProof"]["placements"][0]["unitId"] =
                        json!("unoffered-unit")
                }
                "unrelated_body" => {
                    response["pages"][0]["markdown"] = json!("Unrelated benchmark only.");
                    for placement in response["organizationProof"]["placements"]
                        .as_array_mut()
                        .unwrap()
                    {
                        placement["firstLine"] = json!(1);
                        placement["lastLine"] = json!(1);
                    }
                }
                "missing_proof" => {
                    response
                        .as_object_mut()
                        .unwrap()
                        .remove("organizationProof");
                }
                _ => unreachable!(),
            }
        }
        if request.stage == "source_support" && self.fault == Some("uncertain_compound") {
            response["organizationUnits"][0]["verdict"] = json!("uncertain");
            response["units"][1]["verdict"] = json!("unsupported");
        }
        if request.stage == "source_support" && !self.reports {
            response
                .as_object_mut()
                .unwrap()
                .remove("organizationUnits");
        }
        store.budget_record_usage(&self.scope, &self.library, &reservation, None)?;
        Ok(response.to_string())
    }
}
fn setup() -> Result<(tempfile::TempDir, KnowledgeCatalog, Model)> {
    setup_with_source(
        "R1 identity; Q2 unknown usage; S3 transaction",
        "# State\n\nR1 identity remains stable.\n\nQ2 usage remains unknown without a final report.\n\nS3 transactions commit all or none.",
    )
}
fn setup_with_source(
    purpose: &str,
    text: &str,
) -> Result<(tempfile::TempDir, KnowledgeCatalog, Model)> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("wiki.sqlite");
    let mut store = KnowledgeCatalog::open(&path)?;
    let scope = KnowledgeScope::from_authenticated_host("organization-fixture", "target")?;
    let library = store.create(&scope, "create", "Wiki", purpose)?;
    let source = store.import_text(&scope, &library.id, "source", "Required source", text)?;
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
    Ok((
        temp,
        store,
        Model {
            path,
            scope,
            library: library.id,
            lease,
            calls: Arc::new(Mutex::new(vec![])),
            missing: false,
            refuse: false,
            remaining: 3,
            interrupt: AtomicBool::new(false),
            fault: None,
            reports: true,
            existing_copy: false,
            omit_inverse: false,
            all_lines: false,
            plan_fault: None,
            requests: Mutex::new(vec![]),
            requested: Mutex::new(vec![]),
            provider_cap: None,
            omit_refs: false,
            split_topics: false,
            cancel_on_repair: None,
        },
    ))
}
fn input(model: &Model) -> WikiIngestRequest<'_> {
    WikiIngestRequest {
        library_id: &model.library,
        source_id: &model.lease.job.source_id,
        source_revision: &model.lease.job.source_revision,
        after_chunk: 0,
        output_language: "en",
        context_tokens: 256_000,
    }
}
#[tokio::test]
async fn complete_purpose_placements_automatically_commit_without_an_extra_model_call() -> Result<()>
{
    let (_temp, mut store, model) = setup()?;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    assert!(prepared.analysis.organization_plan.is_some());
    assert_eq!(
        *model.calls.lock().unwrap(),
        vec!["analysis", "generation", "source_support"]
    );
    let checkpoint = kcoder_knowledge::WikiCheckpoint {
        through_chunk: prepared.through_chunk,
        has_more_chunks: prepared.has_more_chunks,
        proposal: prepared.proposal,
    };
    store.save_job_checkpoint(&model.scope, &model.library, &model.lease, &checkpoint)?;
    store.commit_job_checkpoint(&model.scope, &model.library, &model.lease)?;
    assert_eq!(
        store
            .list_pages(&model.scope, &model.library, None, 100)?
            .len(),
        3
    );
    Ok(())
}
#[tokio::test]
async fn missing_requested_units_are_completed_once_before_support_and_atomic_commit() -> Result<()>
{
    let (_temp, mut store, mut model) = setup()?;
    model.missing = true;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    assert_eq!(
        *model.calls.lock().unwrap(),
        vec![
            "analysis",
            "generation",
            "organization_repair",
            "source_support"
        ]
    );
    for term in ["R1", "Q2", "S3"] {
        assert!(prepared.proposal.pages[0].markdown.contains(term));
    }
    assert_eq!(
        store.job_repair_calls(&model.scope, &model.library, &model.lease.job.id)?,
        1
    );
    let checkpoint = kcoder_knowledge::WikiCheckpoint {
        through_chunk: prepared.through_chunk,
        has_more_chunks: prepared.has_more_chunks,
        proposal: prepared.proposal,
    };
    store.save_job_checkpoint(&model.scope, &model.library, &model.lease, &checkpoint)?;
    store.commit_job_checkpoint(&model.scope, &model.library, &model.lease)?;
    Ok(())
}
#[tokio::test]
async fn refusal_or_insufficient_shared_allowance_keeps_missing_knowledge_private() -> Result<()> {
    for refusal in [false, true] {
        let (_temp, mut store, mut model) = setup()?;
        model.missing = true;
        model.refuse = refusal;
        if !refusal {
            model.remaining = 0;
        }
        let prepared = store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new(),
            )
            .await?;
        assert!(!prepared.proposal.review_notes.is_empty());
        assert_eq!(
            model.calls.lock().unwrap().len(),
            if refusal { 3 } else { 2 }
        );
        assert!(
            store
                .list_pages(&model.scope, &model.library, None, 100)?
                .is_empty()
        );
    }
    Ok(())
}
#[tokio::test]
async fn completed_complement_and_analysis_replay_after_reopen_without_repeat_calls() -> Result<()>
{
    let (_temp, mut store, mut model) = setup()?;
    model.missing = true;
    model.interrupt = AtomicBool::new(true);
    assert!(
        store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(model.calls.lock().unwrap().len(), 3);
    store.pause_job(&model.scope, &model.library, &model.lease.job.id)?;
    store.resume_job(&model.scope, &model.library, &model.lease.job.id)?;
    model.lease = store
        .claim_job(&model.scope, &model.library, &model.lease.job.id)?
        .unwrap();
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    assert_eq!(
        *model.calls.lock().unwrap(),
        vec![
            "analysis",
            "generation",
            "organization_repair",
            "source_support"
        ]
    );
    assert!(
        store
            .list_pages(&model.scope, &model.library, None, 100)?
            .is_empty()
    );
    Ok(())
}

#[tokio::test]
async fn source_navigation_unoffered_refs_and_false_line_mappings_never_publish() -> Result<()> {
    for (fault, code) in [
        ("foreign_page", "wiki_organization_page_target"),
        ("bad_ref", "wiki_organization_ref_scope"),
        ("unknown_unit", "wiki_organization_unit_identity"),
    ] {
        let (_temp, mut store, mut model) = setup()?;
        model.fault = Some(fault);
        let error = store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new(),
            )
            .await
            .err()
            .unwrap();
        assert_eq!(KnowledgeCatalog::candidate_failure_code(&error), Some(code));
        assert_eq!(model.calls.lock().unwrap().len(), 2);
        assert!(
            store
                .list_pages(&model.scope, &model.library, None, 100)?
                .is_empty()
        );
    }
    Ok(())
}
#[tokio::test]
async fn literal_purpose_and_actual_body_gaps_cannot_use_a_complete_vote_as_evidence() -> Result<()>
{
    for fault in ["unrelated_body"] {
        let (_temp, mut store, mut model) = setup()?;
        model.fault = Some(fault);
        model.remaining = 0;
        let prepared = store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new(),
            )
            .await?;
        assert!(!prepared.proposal.review_notes.is_empty());
        assert_eq!(model.calls.lock().unwrap().len(), 2);
        assert!(
            store
                .list_pages(&model.scope, &model.library, None, 100)?
                .is_empty()
        );
    }
    // Missing organization bookkeeping can be derived from the citations on
    // the complete actual topic. It still buys the final semantic assessment.
    let (_temp, mut store, mut model) = setup()?;
    model.fault = Some("missing_proof");
    model.remaining = 1;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    assert!(prepared.proposal.organization_proof.is_some());
    assert_eq!(
        model.calls.lock().unwrap().as_slice(),
        ["analysis", "generation", "source_support"]
    );
    let (_temp, mut store, mut model) = setup()?;
    model.reports = false;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(
        prepared
            .proposal
            .review_notes
            .iter()
            .any(|note| note.contains("complete purpose/source inventory"))
    );
    assert_eq!(model.calls.lock().unwrap().len(), 3);
    assert!(
        store
            .list_pages(&model.scope, &model.library, None, 100)?
            .is_empty()
    );
    Ok(())
}
#[tokio::test]
async fn typed_analysis_and_proof_cache_reject_changed_purpose_and_body_without_new_calls()
-> Result<()> {
    let (_temp, mut store, mut model) = setup()?;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    let requests = model.requests.lock().unwrap().clone();
    let analysis = requests
        .iter()
        .find(|request| request.stage == "analysis")
        .unwrap();
    let generation = requests
        .iter()
        .find(|request| request.stage == "generation")
        .unwrap();
    assert!(
        store
            .cached_analysis(
                &model.scope,
                &model.library,
                &model.lease,
                &model.key(analysis)
            )?
            .unwrap()
            .contains("organizationPlan")
    );
    let mut wrong = prepared.proposal;
    wrong.pages[0].markdown.push_str("Changed unbound body.");
    assert!(
        store
            .remember_proposal(
                &model.scope,
                &model.library,
                &model.lease,
                &"f".repeat(64),
                &wrong
            )
            .is_err()
    );
    let library = store.read(&model.scope, &model.library)?;
    store.update_library(
        &model.scope,
        &model.library,
        library.revision,
        &library.name,
        "Different purpose",
    )?;
    store.resume_job(&model.scope, &model.library, &model.lease.job.id)?;
    model.lease = store
        .claim_job(&model.scope, &model.library, &model.lease.job.id)?
        .unwrap();
    assert!(
        store
            .cached_analysis(
                &model.scope,
                &model.library,
                &model.lease,
                &model.key(analysis)
            )
            .is_err()
    );
    assert!(
        store
            .cached_proposal(
                &model.scope,
                &model.library,
                &model.lease,
                &model.key(generation)
            )
            .is_err()
    );
    assert_eq!(model.calls.lock().unwrap().len(), 3);
    Ok(())
}
#[tokio::test]
async fn cancellation_during_complement_never_stages_or_publishes_the_response() -> Result<()> {
    let (_temp, mut store, mut model) = setup()?;
    model.missing = true;
    let cancel = CancellationToken::new();
    model.cancel_on_repair = Some(cancel.clone());
    assert!(
        store
            .prepare_wiki_update(&model.scope, input(&model), &model, &cancel)
            .await
            .is_err()
    );
    assert!(
        store
            .list_pages(&model.scope, &model.library, None, 100)?
            .is_empty()
    );
    assert!(
        store
            .job_checkpoint(&model.scope, &model.library, &model.lease.job.id)?
            .is_none()
    );
    assert_eq!(model.calls.lock().unwrap().len(), 3);
    Ok(())
}

#[tokio::test]
async fn one_mebibyte_aggregate_preserves_complete_existing_bodies_and_new_goal_proof() -> Result<()>
{
    let (_temp, mut store, mut model) = setup()?;
    model.existing_copy = true;
    let mut ids = Vec::new();
    let mut seeds = Vec::new();
    let source = store.source_chunks(
        &model.scope,
        &model.library,
        &model.lease.job.source_id,
        &model.lease.job.source_revision,
        0,
        1,
    )?;
    for index in 0..4 {
        let id = uuid::Uuid::new_v4().to_string();
        ids.push(id.clone());
        seeds.push(serde_json::from_value(json!({"pageId":id,"expectedRevision":null,"kind":"concept",
            "title":format!("Long retained {index}"),"markdown":"retained ".repeat(40_000),
            "citations":[{"sourceId":model.lease.job.source_id,"revisionId":model.lease.job.source_revision,
                "chunkId":source[0].chunk_id,"quote":"R1 identity remains stable."}],"relatedPageIds":[]}))?);
    }
    store.commit_generated_pages(&model.scope, &model.library, "seed-large", seeds)?;
    let mut request = input(&model);
    request.context_tokens = 2_000_000;
    let prepared = store
        .prepare_wiki_update(&model.scope, request, &model, &CancellationToken::new())
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    assert!(serde_json::to_vec(&prepared.proposal)?.len() > 1024 * 1024);
    for id in &ids {
        assert_eq!(
            prepared
                .proposal
                .pages
                .iter()
                .find(|page| &page.page_id == id)
                .unwrap()
                .markdown,
            "retained ".repeat(40_000)
        );
    }
    let checkpoint = kcoder_knowledge::WikiCheckpoint {
        through_chunk: prepared.through_chunk,
        has_more_chunks: prepared.has_more_chunks,
        proposal: prepared.proposal,
    };
    store.save_job_checkpoint(&model.scope, &model.library, &model.lease, &checkpoint)?;
    let receipt = store.commit_job_checkpoint(&model.scope, &model.library, &model.lease)?;
    assert_eq!(
        store.commit_job_checkpoint(&model.scope, &model.library, &model.lease)?,
        receipt
    );
    assert_eq!(
        *model.calls.lock().unwrap(),
        vec!["analysis", "generation", "source_support"]
    );
    for id in &ids {
        assert_eq!(
            store
                .read_page(&model.scope, &model.library, id, None)?
                .draft
                .markdown
                .len(),
            360_000
        );
    }
    Ok(())
}

fn organization_fixture_plan(inventory: &Value) -> Value {
    let required = inventory["units"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|unit| unit["kind"] != "heading")
        .map(|unit| unit["id"].clone())
        .collect::<Vec<_>>();
    let aspects = inventory["aspects"].as_array().unwrap();
    json!({"binding":inventory["binding"],"aspects":aspects.iter().map(|aspect|json!({"aspectId":aspect["id"],"unitIds":required})).collect::<Vec<_>>(),
        "units":inventory["units"].as_array().unwrap().iter().map(|unit|json!({"unitId":unit["id"],
            "disposition":if unit["kind"]=="heading" {"context"} else {"required"},
            "purposeAspectIds":if unit["kind"]=="heading" {vec![]} else {aspects.iter().map(|aspect|aspect["id"].clone()).collect()},
            "reason":if unit["kind"]=="heading" {"Original scope context retained"} else {""}})).collect::<Vec<_>>()})
}
#[tokio::test]
async fn omitted_inverse_and_whole_page_mode_are_canonicalized_without_extra_calls() -> Result<()> {
    let (_temp, mut store, mut model) = setup()?;
    model.omit_inverse = true;
    model.all_lines = true;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    assert_eq!(model.calls.lock().unwrap().len(), 3);
    let proof = serde_json::to_value(prepared.proposal.organization_proof.as_ref().unwrap())?;
    for placement in proof["placements"].as_array().unwrap() {
        assert_eq!(placement["firstLine"], 1);
        assert!(placement.get("allLines").is_none());
    }
    let analysis = serde_json::to_value(prepared.analysis.organization_plan.as_ref().unwrap())?;
    assert_eq!(analysis["aspects"].as_array().unwrap().len(), 1);
    assert_eq!(
        analysis["aspects"][0]["unitIds"].as_array().unwrap().len(),
        3
    );
    Ok(())
}
#[tokio::test]
async fn owned_plan_coverage_is_corrected_once_preserving_original_summary_and_conflicts()
-> Result<()> {
    for fault in ["missing_unit", "wrong_inverse"] {
        let (_temp, mut store, mut model) = setup()?;
        model.plan_fault = Some(fault);
        let prepared = store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new(),
            )
            .await?;
        assert!(prepared.proposal.review_notes.is_empty());
        let requests = model.requests.lock().unwrap();
        let original = requests
            .iter()
            .find(|request| request.stage == "analysis")
            .unwrap();
        let correction = requests
            .iter()
            .find(|request| request.stage == "format_repair")
            .unwrap();
        assert!(correction.max_output_tokens <= 262144 && original.max_output_tokens <= 262144);
        assert!(
            model
                .requested
                .lock()
                .unwrap()
                .iter()
                .all(|(_, requested, _)| *requested == 262144)
        );
        assert!(correction.max_output_tokens > 4096);
        drop(requests);

        assert_eq!(
            prepared.analysis.summary,
            "Organize each literal purpose with its original source evidence"
        );
        assert!(prepared.analysis.conflicts.is_empty());
        assert_eq!(
            *model.calls.lock().unwrap(),
            vec!["analysis", "format_repair", "generation", "source_support"]
        );
        assert_eq!(
            store.job_repair_calls(&model.scope, &model.library, &model.lease.job.id)?,
            1
        );
    }
    Ok(())
}
#[tokio::test]
async fn foreign_plan_identity_never_enters_shape_repair() -> Result<()> {
    let (_temp, mut store, mut model) = setup()?;
    model.plan_fault = Some("foreign");
    let error = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await
        .err()
        .unwrap();
    assert_eq!(
        KnowledgeCatalog::candidate_failure_code(&error),
        Some("wiki_organization_unit_identity")
    );
    assert_eq!(model.calls.lock().unwrap().len(), 1);
    assert!(
        store
            .list_pages(&model.scope, &model.library, None, 100)?
            .is_empty()
    );
    Ok(())
}
#[tokio::test]
async fn owned_bad_line_is_repaired_without_mutating_body_or_citations_and_replays() -> Result<()> {
    let (_temp, mut store, mut model) = setup()?;
    model.fault = Some("bad_line");
    model.interrupt = AtomicBool::new(true);
    assert!(
        store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(model.calls.lock().unwrap().len(), 3);
    store.pause_job(&model.scope, &model.library, &model.lease.job.id)?;
    store.resume_job(&model.scope, &model.library, &model.lease.job.id)?;
    model.lease = store
        .claim_job(&model.scope, &model.library, &model.lease.job.id)?
        .unwrap();
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    assert_eq!(
        *model.calls.lock().unwrap(),
        vec![
            "analysis",
            "generation",
            "organization_repair",
            "source_support"
        ]
    );
    for term in ["R1", "Q2", "S3"] {
        assert!(prepared.proposal.pages[0].markdown.contains(term));
    }
    assert!(
        store
            .list_pages(&model.scope, &model.library, None, 100)?
            .is_empty()
    );
    Ok(())
}

#[tokio::test]
async fn owned_bad_line_without_format_repair_room_has_a_real_private_review_checkpoint()
-> Result<()> {
    let (_temp, mut store, mut model) = setup()?;
    model.fault = Some("bad_line");
    model.remaining = 0;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(!prepared.proposal.review_notes.is_empty());
    assert!(prepared.proposal.organization_proof.is_none());
    let checkpoint = kcoder_knowledge::WikiCheckpoint {
        through_chunk: prepared.through_chunk,
        has_more_chunks: prepared.has_more_chunks,
        proposal: prepared.proposal,
    };
    store.save_job_checkpoint(&model.scope, &model.library, &model.lease, &checkpoint)?;
    store.stop_job_with_reason(
        &model.scope,
        &model.library,
        &model.lease,
        "awaiting_review",
        "review_required",
    )?;
    let saved = store
        .job_checkpoint(&model.scope, &model.library, &model.lease.job.id)?
        .unwrap();
    assert!(saved.proposal.pages[0].markdown.contains("S3"));
    assert!(!saved.proposal.pages[0].citations.is_empty());
    assert!(
        store
            .commit_job_checkpoint(&model.scope, &model.library, &model.lease)
            .is_err()
    );
    assert_eq!(model.calls.lock().unwrap().len(), 2);
    Ok(())
}

#[tokio::test]
async fn dense_paragraphs_and_literal_purpose_reach_support_and_atomic_commit() -> Result<()> {
    for (purpose, text) in [
        (
            "Organize complete knowledge".to_string(),
            "fact\n\n".repeat(106),
        ),
        (
            (1..=17)
                .map(|index| format!("R{index} scope"))
                .collect::<Vec<_>>()
                .join("; "),
            (1..=17)
                .map(|index| format!("R{index} scope remains exact.\n\n"))
                .collect::<String>(),
        ),
    ] {
        let (_temp, mut store, model) = setup_with_source(&purpose, &text)?;
        let prepared = store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new(),
            )
            .await?;
        assert!(prepared.proposal.review_notes.is_empty());
        assert_eq!(
            *model.calls.lock().unwrap(),
            vec!["analysis", "generation", "source_support"]
        );
        assert_eq!(
            prepared.proposal.pages[0]
                .markdown
                .lines()
                .filter(|line| !line.trim().is_empty())
                .collect::<Vec<_>>(),
            text.lines()
                .filter(|line| !line.trim().is_empty())
                .collect::<Vec<_>>()
        );
        assert!(prepared.proposal.pages.iter().any(|page| page.kind
            == kcoder_types::knowledge::KnowledgePageKind::Source
            && page.markdown == text));
        let support: Value = {
            let requests = model.requests.lock().unwrap();
            serde_json::from_str(&requests.last().unwrap().user)?
        };
        assert!(
            support["units"].as_array().unwrap().len()
                + support["organizationInventory"]["units"]
                    .as_array()
                    .unwrap()
                    .len()
                <= 96
        );
        if text == "fact\n\n".repeat(106) {
            assert!(
                support["units"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|unit| unit["kind"] == "body_block")
            );
        }
        let replay = store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new(),
            )
            .await?;
        assert_eq!(
            serde_json::to_value(&replay.proposal)?,
            serde_json::to_value(&prepared.proposal)?
        );
        assert_eq!(
            model.calls.lock().unwrap().len(),
            3,
            "canonical packed cache replay is free"
        );
        let checkpoint = kcoder_knowledge::WikiCheckpoint {
            through_chunk: prepared.through_chunk,
            has_more_chunks: prepared.has_more_chunks,
            proposal: prepared.proposal,
        };
        store.save_job_checkpoint(&model.scope, &model.library, &model.lease, &checkpoint)?;
        let receipt = store.commit_job_checkpoint(&model.scope, &model.library, &model.lease)?;
        assert_eq!(
            store.commit_job_checkpoint(&model.scope, &model.library, &model.lease)?,
            receipt
        );
        assert_eq!(
            store
                .list_pages(&model.scope, &model.library, None, 100)?
                .len(),
            3
        );
    }
    Ok(())
}
#[tokio::test]
async fn dense_table_mixed_scope_keeps_every_constituent_private_when_uncertain() -> Result<()> {
    let text = format!(
        "# Component v2\n\n| Field | Result |\n| --- | --- |\n{}\n# Separate v3 context\n\nOnly v3 uses telemetry.\n",
        "| R1 | v2 ok |\n".repeat(106)
    );
    let (_temp, mut store, mut model) = setup_with_source("R1 v2 result; version scope", &text)?;
    model.fault = Some("uncertain_compound");
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(!prepared.proposal.review_notes.is_empty());
    assert_eq!(
        prepared.proposal.pages[0].markdown.trim_end(),
        text.trim_end()
    );
    assert_eq!(model.calls.lock().unwrap().len(), 3);
    let checkpoint = kcoder_knowledge::WikiCheckpoint {
        through_chunk: prepared.through_chunk,
        has_more_chunks: prepared.has_more_chunks,
        proposal: prepared.proposal,
    };
    store.save_job_checkpoint(&model.scope, &model.library, &model.lease, &checkpoint)?;
    store.stop_job_with_reason(
        &model.scope,
        &model.library,
        &model.lease,
        "awaiting_review",
        "review_required",
    )?;
    assert!(
        store
            .job_checkpoint(&model.scope, &model.library, &model.lease.job.id)?
            .is_some()
    );
    assert!(
        store
            .commit_job_checkpoint(&model.scope, &model.library, &model.lease)
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
async fn inventory_preflight_shrinks_whole_chunks_before_one_paid_analysis() -> Result<()> {
    let (_temp, mut store, mut model) = setup_with_source("Organize facts", "fact")?;
    let chunks: Vec<_> = (1..=3)
        .map(|ordinal| kcoder_knowledge::SourceChunk {
            ordinal,
            chunk_id: format!("chunk-{ordinal}"),
            page: None,
            first_line: (ordinal - 1) * 40 + 1,
            last_line: ordinal * 40,
            text: "fact\n\n".repeat(20),
        })
        .collect();
    let source = store.import_extracted(
        &model.scope,
        &model.library,
        "dense-batches",
        "Dense batches",
        b"original",
        "text",
        chunks,
    )?;
    let job = store.enqueue_ingest(
        &model.scope,
        &model.library,
        "dense-job",
        &source.source_id,
        &source.revision_id,
        kcoder_knowledge::PREPARATION_VERSION,
        "en",
    )?;
    model.lease = store
        .claim_job(&model.scope, &model.library, &job.id)?
        .unwrap();
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert_eq!(prepared.through_chunk, 2);
    assert!(prepared.has_more_chunks);
    assert!(prepared.proposal.review_notes.is_empty());
    assert_eq!(
        *model.calls.lock().unwrap(),
        vec!["analysis", "generation", "source_support"]
    );
    let requests = model.requests.lock().unwrap();
    let analysis: Value = serde_json::from_str(&requests[0].user)?;
    assert_eq!(analysis["source"]["chunks"].as_array().unwrap().len(), 2);
    assert_eq!(
        analysis["sourceInventory"]["units"]
            .as_array()
            .unwrap()
            .len(),
        40
    );
    assert!(
        analysis["sourceInventory"]["units"]
            .as_array()
            .unwrap()
            .iter()
            .all(|unit| unit["kind"] == "paragraph")
    );
    Ok(())
}
#[tokio::test]
async fn own_navigation_role_can_be_corrected_once_but_never_auto_remapped() -> Result<()> {
    for fault in ["role_target", "source_target"] {
        let (_temp, mut store, mut model) = setup()?;
        model.fault = Some(fault);
        let prepared = store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new(),
            )
            .await?;
        assert_eq!(
            prepared.proposal.review_notes.is_empty(),
            fault == "role_target"
        );
        let checkpoint = kcoder_knowledge::WikiCheckpoint {
            through_chunk: prepared.through_chunk,
            has_more_chunks: prepared.has_more_chunks,
            proposal: prepared.proposal,
        };
        store.save_job_checkpoint(&model.scope, &model.library, &model.lease, &checkpoint)?;
        if fault == "role_target" {
            assert_eq!(
                *model.calls.lock().unwrap(),
                vec![
                    "analysis",
                    "generation",
                    "organization_repair",
                    "source_support"
                ]
            );
            store.commit_job_checkpoint(&model.scope, &model.library, &model.lease)?;
        } else {
            assert_eq!(model.calls.lock().unwrap().len(), 3);
            store.stop_job_with_reason(
                &model.scope,
                &model.library,
                &model.lease,
                "awaiting_review",
                "review_required",
            )?;
            assert!(
                store
                    .job_checkpoint(&model.scope, &model.library, &model.lease.job.id)?
                    .is_some()
            );
            assert!(
                store
                    .commit_job_checkpoint(&model.scope, &model.library, &model.lease)
                    .is_err()
            );
            assert!(
                store
                    .list_pages(&model.scope, &model.library, None, 100)?
                    .is_empty()
            );
        }
    }
    Ok(())
}

#[tokio::test]
async fn wiki_default_requested_output_is_256k_and_explicit_provider_cap_is_honored() -> Result<()>
{
    for cap in [None, Some(4096)] {
        let (_temp, mut store, mut model) = setup()?;
        model.provider_cap = cap;
        let prepared = store
            .prepare_wiki_update(
                &model.scope,
                input(&model),
                &model,
                &CancellationToken::new(),
            )
            .await?;
        assert!(prepared.proposal.review_notes.is_empty());
        assert_eq!(
            *model.calls.lock().unwrap(),
            vec!["analysis", "generation", "source_support"]
        );
        let requests = model.requested.lock().unwrap();
        assert_eq!(requests.len(), 3);
        for (_, requested, limit) in requests.iter() {
            assert_eq!(*requested, 262144);
            assert!(*limit <= 262144);
            if let Some(cap) = cap {
                assert_eq!(*limit, cap);
            } else {
                assert!(
                    *limit < 262144,
                    "remaining context must clamp the upper default"
                );
            }
        }
    }
    Ok(())
}
#[tokio::test]
async fn omitted_selected_refs_derive_exact_context_and_commit_without_extra_call() -> Result<()> {
    let text =
        "# Component v2\n\n| Field | Result |\n| --- | --- |\n| R1 | v2 only |\n| Q2 | unknown |\n";
    let (_temp, mut store, mut model) = setup_with_source("R1 v2 result; Q2 unknown", text)?;
    model.omit_refs = true;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    assert_eq!(model.calls.lock().unwrap().len(), 3);
    let proof = serde_json::to_value(prepared.proposal.organization_proof.as_ref().unwrap())?;
    let proposal = serde_json::to_value(&prepared.proposal)?;
    for placement in proof["placements"].as_array().unwrap() {
        assert!(placement["citationRefs"].as_array().unwrap().len() >= 2);
        assert_eq!(placement["pageId"], proposal["pages"][0]["pageId"]);
    }
    assert!(
        prepared.proposal.pages[0]
            .citations
            .iter()
            .any(|citation| citation.quote == "# Component v2\n")
    );
    assert!(
        prepared.proposal.pages[0]
            .citations
            .iter()
            .any(|citation| citation.quote == "| Field | Result |\n")
    );
    let checkpoint = kcoder_knowledge::WikiCheckpoint {
        through_chunk: prepared.through_chunk,
        has_more_chunks: prepared.has_more_chunks,
        proposal: prepared.proposal,
    };
    store.save_job_checkpoint(&model.scope, &model.library, &model.lease, &checkpoint)?;
    store.commit_job_checkpoint(&model.scope, &model.library, &model.lease)?;
    Ok(())
}

#[tokio::test]
async fn compound_omitted_refs_are_derived_on_each_selected_actual_topic() -> Result<()> {
    let text = "fact\n\n".repeat(106);
    let (_temp, mut store, mut model) = setup_with_source("Organize complete knowledge", &text)?;
    model.omit_refs = true;
    model.split_topics = true;
    let prepared = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(prepared.proposal.review_notes.is_empty());
    assert_eq!(model.calls.lock().unwrap().len(), 3);
    let topics: Vec<_> = prepared
        .proposal
        .pages
        .iter()
        .filter(|page| page.kind == kcoder_types::knowledge::KnowledgePageKind::Concept)
        .collect();
    assert_eq!(topics.len(), 2);
    assert_eq!(
        topics
            .iter()
            .map(|page| page.markdown.as_str())
            .collect::<String>(),
        text
    );
    let proof = serde_json::to_value(prepared.proposal.organization_proof.as_ref().unwrap())?;
    for topic in topics {
        assert!(!topic.citations.is_empty());
        assert!(
            proof["placements"]
                .as_array()
                .unwrap()
                .iter()
                .any(|placement| placement["pageId"] == topic.page_id)
        );
        assert!(
            topic
                .citations
                .iter()
                .any(|citation| citation.quote == text),
            "compound scope context is retained on the same selected topic"
        );
    }
    let replay = store
        .prepare_wiki_update(
            &model.scope,
            input(&model),
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert_eq!(
        serde_json::to_value(&replay.proposal)?,
        serde_json::to_value(&prepared.proposal)?
    );
    assert_eq!(model.calls.lock().unwrap().len(), 3);
    let checkpoint = kcoder_knowledge::WikiCheckpoint {
        through_chunk: prepared.through_chunk,
        has_more_chunks: prepared.has_more_chunks,
        proposal: prepared.proposal,
    };
    store.save_job_checkpoint(&model.scope, &model.library, &model.lease, &checkpoint)?;
    store.commit_job_checkpoint(&model.scope, &model.library, &model.lease)?;
    Ok(())
}
