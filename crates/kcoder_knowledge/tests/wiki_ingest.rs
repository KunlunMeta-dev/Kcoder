#[path = "fixtures/organization.rs"]
mod organization_fixture;
use anyhow::Result;
use async_trait::async_trait;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, WikiIngestRequest, WikiModel, WikiModelRequest,
};
use serde_json::{Value, json};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct FixtureModel {
    stages: Mutex<Vec<String>>,
}
#[async_trait]
impl WikiModel for FixtureModel {
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        self.stages.lock().unwrap().push(request.stage.into());
        let input: Value = serde_json::from_str(&request.user)?;
        if input["repairKind"] == "source_support" {
            assert_eq!(request.stage, "source_support");
            return Ok(organization_fixture::with_organization_support(&input,json!({"sourceCoverage":"complete","units":input["units"].as_array().unwrap().iter().map(|unit|
                json!({"pageId":unit["pageId"],"unit":unit["unit"],"verdict":"supported","citationIndices":[0]})
            ).collect::<Vec<_>>()} )).to_string());
        }
        assert_eq!(input["purpose"], "保留证据与不同版本");
        if request.stage == "analysis" {
            assert!(request.system.contains("Connections to Existing Wiki"));
            return Ok(organization_fixture::with_plan(
                &input,
                json!({"summary":"整理协议支持范围","queries":["协议"],"conflicts":[]}),
            )
            .to_string());
        }
        assert!(request.system.contains("Preserves every factual claim"));
        if input["hasOverview"] == true {
            assert!(
                input["existingPages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|page| page["draft"]["pageId"] == input["overviewPageId"]
                        && page["draft"]["kind"] == "overview")
            );
        } else {
            assert!(
                input["newPageIds"]
                    .as_array()
                    .unwrap()
                    .contains(&input["overviewPageId"])
            );
        }
        let source = &input["source"];
        let chunk = &source["chunks"][0];
        let old = input["existingPages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|page| page["draft"]["kind"] == "concept");
        let mut citations = old
            .map(|p| p["draft"]["citations"].as_array().unwrap().clone())
            .unwrap_or_default();
        citations.push(json!({"sourceId":source["sourceId"],"revisionId":source["revisionId"],"chunkId":chunk["chunkId"],"quote":chunk["text"]}));
        let body = match old {
            Some(p) => format!(
                "{}\n{}",
                p["draft"]["markdown"].as_str().unwrap(),
                chunk["text"].as_str().unwrap()
            ),
            None => chunk["text"].as_str().unwrap().into(),
        };
        Ok(organization_fixture::with_proof(&input,json!({"pages":[{"pageId":old.map(|p|p["draft"]["pageId"].clone()).unwrap_or(input["newPageIds"][0].clone()),"expectedRevision":old.map(|p|p["revisionId"].clone()),"title":"协议兼容性","kind":"concept","markdown":body,"citations":citations,"relatedPageIds":[]}],"reviewNotes":[]})).to_string())
    }
}

#[tokio::test]
async fn two_stage_pipeline_reads_existing_wiki_and_proposes_same_topic_update() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&directory.path().join("state.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "ssh")?;
    let library = store.create(&scope, "create", "Wiki", "保留证据与不同版本")?;
    let model = FixtureModel::default();
    let mut page_id = None;
    for (index, text) in [
        "第一版支持协议 A。",
        "第二版支持协议 B。",
        "第三份资料指出部分部署不支持协议 B。",
    ]
    .iter()
    .enumerate()
    {
        let source = store.import_text(
            &scope,
            &library.id,
            &format!("source-{index}"),
            "协议资料",
            text,
        )?;
        let prepared = store
            .prepare_wiki_update(
                &scope,
                WikiIngestRequest {
                    library_id: &library.id,
                    source_id: &source.source_id,
                    source_revision: &source.revision_id,
                    after_chunk: 0,
                    output_language: "简体中文",
                    context_tokens: 64_000,
                },
                &model,
                &CancellationToken::new(),
            )
            .await?;
        assert!(!prepared.has_more_chunks);
        let result = store.commit_generated_pages(
            &scope,
            &library.id,
            &format!("commit-{index}"),
            prepared.proposal.pages,
        )?;
        if let Some(id) = &page_id {
            assert_eq!(&result[0].page_id, id);
        } else {
            page_id = Some(result[0].page_id.clone());
        }
    }
    let page = store.read_page(&scope, &library.id, page_id.as_ref().unwrap(), None)?;
    assert_eq!(page.draft.citations.len(), 3);
    assert!(page.draft.markdown.contains("第一版"));
    assert!(page.draft.markdown.contains("不支持"));
    assert_eq!(
        model.stages.lock().unwrap().as_slice(),
        [
            "analysis",
            "generation",
            "source_support",
            "analysis",
            "generation",
            "source_support",
            "analysis",
            "generation",
            "source_support"
        ]
    );
    Ok(())
}

#[tokio::test]
async fn cancelled_preparation_never_calls_model_or_writes_a_page() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&directory.path().join("state.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "ssh")?;
    let model = FixtureModel::default();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(
        store
            .prepare_wiki_update(
                &scope,
                WikiIngestRequest {
                    library_id: "absent",
                    source_id: "absent",
                    source_revision: "absent",
                    after_chunk: 0,
                    output_language: "中文",
                    context_tokens: 64_000
                },
                &model,
                &cancel
            )
            .await
            .is_err()
    );
    assert!(model.stages.lock().unwrap().is_empty());
    Ok(())
}

struct RepairModel {
    calls: Mutex<Vec<String>>,
    fail_repair: bool,
}
#[async_trait]
impl WikiModel for RepairModel {
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        self.calls.lock().unwrap().push(request.stage.into());
        if matches!(request.stage, "analysis" | "format_repair") {
            let input: Value = serde_json::from_str(&request.user)?;
            if input.get("previousResponse").is_none() || self.fail_repair {
                return Ok("malformed output".into());
            }
            assert_eq!(input["originalInput"]["purpose"], "保留证据与不同版本");
            return Ok(organization_fixture::with_plan(
                &input["originalInput"],
                json!({"summary":"test","queries":[],"conflicts":[]}),
            )
            .to_string());
        }
        FixtureModel::default().complete(request).await
    }
}

#[tokio::test]
async fn format_repairs_once_and_missing_summary_uses_exact_source_evidence() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&directory.path().join("state.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "ssh")?;
    let library = store.create(&scope, "create", "Wiki", "保留证据与不同版本")?;
    let source = store.import_text(
        &scope,
        &library.id,
        "source",
        "原文",
        "第一版仅支持协议 A。",
    )?;
    for fail_repair in [true, false] {
        let model = RepairModel {
            calls: Mutex::new(Vec::new()),
            fail_repair,
        };
        let result = store
            .prepare_wiki_update(
                &scope,
                WikiIngestRequest {
                    library_id: &library.id,
                    source_id: &source.source_id,
                    source_revision: &source.revision_id,
                    after_chunk: 0,
                    output_language: "简体中文",
                    context_tokens: 64_000,
                },
                &model,
                &CancellationToken::new(),
            )
            .await;
        if fail_repair {
            assert!(result.is_err());
            assert_eq!(
                model.calls.lock().unwrap().as_slice(),
                ["analysis", "format_repair"]
            );
        } else {
            let prepared = result?;
            assert_eq!(
                model.calls.lock().unwrap().as_slice(),
                ["analysis", "format_repair", "generation", "source_support"]
            );
            let summary = prepared
                .proposal
                .pages
                .iter()
                .find(|page| page.kind == kcoder_types::knowledge::KnowledgePageKind::Source)
                .unwrap();
            assert_eq!(summary.markdown, "第一版仅支持协议 A。");
            assert_eq!(summary.citations[0].quote, summary.markdown);
            assert_eq!(summary.citations[0].source_id, source.source_id);
            store.commit_generated_pages(&scope, &library.id, "commit", prepared.proposal.pages)?;
        }
    }
    Ok(())
}

#[tokio::test]
async fn first_overview_uses_one_stable_id_and_never_overwrites_a_human_overview() -> Result<()> {
    use kcoder_types::knowledge::KnowledgePageKind;
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("state.sqlite");
    let mut first = KnowledgeCatalog::open(&path)?;
    let mut concurrent = KnowledgeCatalog::open(&path)?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "ssh")?;
    let library = first.create(&scope, "create", "Wiki", "保留证据与不同版本")?;
    let source = first.import_text(
        &scope,
        &library.id,
        "source",
        "协议资料",
        "第一版支持协议 A。",
    )?;
    let model = FixtureModel::default();
    let input = || WikiIngestRequest {
        library_id: &library.id,
        source_id: &source.source_id,
        source_revision: &source.revision_id,
        after_chunk: 0,
        output_language: "简体中文",
        context_tokens: 64000,
    };
    // Both batches observe the same no-overview state before either commits.
    let prepared = first
        .prepare_wiki_update(&scope, input(), &model, &CancellationToken::new())
        .await?;
    let raced = concurrent
        .prepare_wiki_update(&scope, input(), &model, &CancellationToken::new())
        .await?;
    let overview = prepared
        .proposal
        .pages
        .iter()
        .find(|page| page.kind == KnowledgePageKind::Overview)
        .unwrap()
        .clone();
    assert_eq!(prepared.proposal.pages.len(), 3);
    assert_eq!(overview.related_page_ids.len(), 2);
    assert!(overview.markdown.starts_with("# Wiki\n\n- "));
    assert_eq!(overview.citations[0].source_id, source.source_id);
    assert_eq!(
        overview.page_id,
        raced
            .proposal
            .pages
            .iter()
            .find(|page| page.kind == KnowledgePageKind::Overview)
            .unwrap()
            .page_id
    );
    let committed =
        first.commit_generated_pages(&scope, &library.id, "first", prepared.proposal.pages)?;
    assert!(
        concurrent
            .commit_generated_pages(&scope, &library.id, "raced", raced.proposal.pages)
            .unwrap_err()
            .to_string()
            .contains("revision conflict")
    );
    assert_eq!(first.list_pages(&scope, &library.id, None, 100)?.len(), 3);
    let base = &committed
        .iter()
        .find(|page| page.page_id == overview.page_id)
        .unwrap()
        .revision_id;
    let human = first.edit_page(
        &scope,
        &library.id,
        &overview.page_id,
        base,
        "human-overview",
        "个人导航",
        "只保留我选择的导航。",
    )?;
    let next = first.import_text(
        &scope,
        &library.id,
        "next",
        "协议资料第二版",
        "第二版支持协议 B。",
    )?;
    let prepared = first
        .prepare_wiki_update(
            &scope,
            WikiIngestRequest {
                library_id: &library.id,
                source_id: &next.source_id,
                source_revision: &next.revision_id,
                after_chunk: 0,
                output_language: "简体中文",
                context_tokens: 64000,
            },
            &model,
            &CancellationToken::new(),
        )
        .await?;
    assert!(
        prepared
            .proposal
            .pages
            .iter()
            .all(|page| page.page_id != overview.page_id)
    );
    first.commit_generated_pages(&scope, &library.id, "next", prepared.proposal.pages)?;
    let retained = first.read_page(&scope, &library.id, &overview.page_id, None)?;
    assert_eq!(retained.revision_id, human.revision_id);
    assert_eq!(retained.draft.markdown, "只保留我选择的导航。");
    assert_eq!(
        first
            .list_pages(&scope, &library.id, None, 100)?
            .iter()
            .filter(|page| page.kind == KnowledgePageKind::Overview)
            .count(),
        1
    );
    Ok(())
}

#[test]
fn review_note_shape_normalization_never_silences_a_real_review_request() {
    for empty in [
        serde_json::json!(""),
        serde_json::json!(null),
        serde_json::json!([]),
    ] {
        let proposal: kcoder_knowledge::WikiProposal =
            serde_json::from_value(serde_json::json!({"pages":[],"reviewNotes":empty})).unwrap();
        assert!(proposal.review_notes.is_empty());
    }
    let proposal: kcoder_knowledge::WikiProposal = serde_json::from_value(
        serde_json::json!({"pages":[],"reviewNotes":"Conflicting evidence requires a decision"}),
    )
    .unwrap();
    assert_eq!(
        proposal.review_notes,
        vec!["Conflicting evidence requires a decision"]
    );
    assert!(
        serde_json::from_value::<kcoder_knowledge::WikiProposal>(
            serde_json::json!({"pages":[],"reviewNotes":false})
        )
        .is_err()
    );
}
