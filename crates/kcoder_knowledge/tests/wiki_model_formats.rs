//! Owned deterministic model-text fixtures: permissive formatting still passes
//! the real preparation, evidence, checkpoint and publication boundaries.
use anyhow::Result;
use async_trait::async_trait;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, WikiCheckpoint, WikiIngestRequest, WikiModel,
    WikiModelRequest, WikiProposal,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Mutex};
use tokio_util::sync::CancellationToken;

const SOURCE: &str = "# Server K100\n\nK100 v2 keeps port 8192 and exact PDF-\nline whitespace.\n";

#[derive(Default)]
struct FormattingModel {
    source_text: String,
    query_existing: bool,
    calls: Mutex<Vec<String>>,
    wire: Mutex<BTreeMap<String, String>>,
    proposals: Mutex<BTreeMap<String, String>>,
    raw_proposal: Mutex<Option<String>>,
    unsupported: bool,
    nested_envelopes: bool,
    citation_format: &'static str,
}

fn key(request: &WikiModelRequest) -> String {
    json!({"stage":request.stage,"system":request.system,"user":request.user,"maxOutput":request.max_output_tokens}).to_string()
}

#[async_trait]
impl WikiModel for FormattingModel {
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        self.calls.lock().unwrap().push(request.stage.into());
        let input: Value = serde_json::from_str(&request.user)?;
        let mut raw = match request.stage {
            "analysis" => {
                // No redundant binding/aspect IDs/reason on required decisions;
                // optional searches/conflicts and explanatory metadata are free.
                let units = input["sourceInventory"]["units"].as_array().unwrap();
                let analysis = json!({"analysis_summary":"Server facts","search_queries":if self.nested_envelopes {
                    json!({"items":if self.query_existing {json!(["Server K100"])} else {json!([])}})
                } else if self.query_existing {json!("Server K100")} else {Value::Null}, "organization_plan":{
                    "units":units.iter().map(|unit|json!({"unit_id":unit["id"],"disposition":"REQUIRED"})).collect::<Vec<_>>()},
                    "confidence":0.91,"model_comment":"formatting metadata"});
                format!(
                    "Analysis follows:\n```json\n{}\n```\nSource was read.",
                    json!({"result":analysis})
                )
            }
            "generation" => {
                let reference = input["citationSpans"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|span| span["wholeChunk"] == true)
                    .unwrap()["ref"]
                    .clone();
                let page_id = input["existingPages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|page| page["draft"]["kind"] == "concept")
                    .map(|page| page["draft"]["pageId"].clone())
                    .unwrap_or_else(|| input["newPageIds"][0].clone());
                let whole = input["citationSpans"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|span| span["wholeChunk"] == true)
                    .unwrap();
                let citation = match self.citation_format {
                    "locator" => {
                        json!({"sourceId":null,"revisionId":null,"chunkId":whole["chunkId"],"wholeChunk":true})
                    }
                    "encoded" => {
                        json!({"sourceId":null,"revisionId":null,"chunkId":whole["chunkId"],"quote":self.source_text.replace('&',"&amp;").replace('<',"&lt;")})
                    }
                    "metadata" => {
                        let mut copied = whole.clone();
                        copied["ref"] = format!(" `[{}]` ", reference.as_str().unwrap()).into();
                        copied
                    }
                    _ => reference,
                };
                let page = json!({"page_id":page_id,"type":"TOPIC", "title":"Server K100",
                    "body":self.source_text,"references":citation,"related_page_ids":null,"confidence":"high"});
                // The page array is the entire result. No organization proof,
                // expectedRevision or reviewNotes is required for a new topic.
                if self.nested_envelopes {
                    json!({"items":{"records":[page]}}).to_string()
                } else {
                    format!("Here is the complete proposal:\n```JSON\n[{page},]\n```\nFinished.")
                }
            }
            "source_support" => {
                assert_eq!(input["candidate"]["pages"][0]["markdown"], self.source_text);
                assert_eq!(
                    input["citationBindings"][0]["citations"][0]["quote"],
                    self.source_text
                );
                let placements = input["candidate"]["organizationProof"]["placements"]
                    .as_array()
                    .unwrap();
                assert!(
                    !placements.is_empty(),
                    "host derived placements from selected actual evidence"
                );
                json!({"assessment":{"source_coverage":true,
                    "units":input["units"].as_array().unwrap().iter().map(|unit|json!({
                        "page_id":unit["pageId"],"unit":unit["unit"].to_string(),
                        "supported":!self.unsupported,"citation_indices":"0", "explanation":"model metadata"})).collect::<Vec<_>>(),
                    "organization_units":input["organizationInventory"]["units"].as_array().unwrap().iter().map(|unit|json!({
                        "unit_id":unit["id"],"verdict":"TRUE", "placement_indices":placements.iter().enumerate()
                            .filter(|(_,placement)| placement["unitId"] == unit["id"])
                            .map(|(index,_)|index.to_string()).collect::<Vec<_>>()})).collect::<Vec<_>>()}}).to_string()
            }
            stage => panic!(
                "format differences must not purchase a repair: {stage}; {}",
                input["validationError"]
            ),
        };
        if self.nested_envelopes {
            let mut wrapped = json!({"output":json!({"data":raw}).to_string()});
            if request.stage == "generation" {
                wrapped["warnings"] = json!(["Check extraction presentation", ""]);
                wrapped["notes"] = json!([
                    "Check extraction presentation",
                    "Preserve literal evidence whitespace"
                ]);
            }
            raw = wrapped.to_string();
        }
        if request.stage == "generation" {
            *self.raw_proposal.lock().unwrap() = Some(raw.clone());
        }
        Ok(raw)
    }
    fn cached_json_response(&self, request: &WikiModelRequest) -> Result<Option<String>> {
        let cache = self.wire.lock().unwrap();
        if let Some(raw) = cache.get(&key(request)) {
            return Ok(Some(raw.clone()));
        }
        Ok(request
            .legacy_format_cache_request()?
            .and_then(|legacy| cache.get(&key(&legacy)).cloned()))
    }
    fn remember_json_response(&self, request: &WikiModelRequest, raw: &str) -> Result<()> {
        // Exercise exact old prompt cache spelling while preserving the whole
        // original model response, including accepted prose/fences/commas.
        let legacy = request.legacy_format_cache_request()?.unwrap();
        self.wire.lock().unwrap().insert(key(&legacy), raw.into());
        Ok(())
    }
    fn cached_proposal(&self, request: &WikiModelRequest) -> Result<Option<WikiProposal>> {
        self.proposals
            .lock()
            .unwrap()
            .get(&key(request))
            .map(|raw| serde_json::from_str(raw).map_err(Into::into))
            .transpose()
    }
    fn remember_proposal(&self, request: &WikiModelRequest, proposal: &WikiProposal) -> Result<()> {
        self.proposals
            .lock()
            .unwrap()
            .insert(key(request), serde_json::to_string(proposal)?);
        Ok(())
    }
}

#[tokio::test]
async fn locator_metadata_and_encoded_quotes_prepare_and_publish_without_rebuying_repairs()
-> Result<()> {
    let text = format!("{SOURCE}\nK100 A & B keep queues < 3.\n");
    for citation_format in ["locator", "encoded", "metadata"] {
        let temp = tempfile::tempdir()?;
        let mut catalog = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("owned-locator-fixture", "local")?;
        let library =
            catalog.create(&scope, "create", "Wiki", "Server K100 facts and conditions")?;
        let source = catalog.import_text(&scope, &library.id, "source", "Server K100", &text)?;
        let model = FormattingModel {
            source_text: text.clone(),
            citation_format,
            ..Default::default()
        };
        let prepared = catalog
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
        assert!(
            prepared.proposal.review_notes.is_empty(),
            "{citation_format}: {:?}",
            prepared.proposal.review_notes
        );
        assert_eq!(prepared.proposal.pages[0].citations[0].quote, text);
        assert_eq!(
            *model.calls.lock().unwrap(),
            ["analysis", "generation", "source_support"]
        );
        let job = catalog.enqueue_ingest(
            &scope,
            &library.id,
            "job",
            &source.source_id,
            &source.revision_id,
            "locator-fixture",
            "en",
        )?;
        let lease = catalog.claim_job(&scope, &library.id, &job.id)?.unwrap();
        let topic_id = prepared.proposal.pages[0].page_id.clone();
        catalog.save_job_checkpoint(
            &scope,
            &library.id,
            &lease,
            &WikiCheckpoint {
                through_chunk: prepared.through_chunk,
                has_more_chunks: prepared.has_more_chunks,
                proposal: prepared.proposal,
            },
        )?;
        catalog.commit_job_checkpoint(&scope, &library.id, &lease)?;
        catalog.finish_job_batch(&scope, &library.id, &lease)?;
        assert_eq!(
            catalog.read_job(&scope, &library.id, &job.id)?.status,
            "completed"
        );
        assert_eq!(
            catalog
                .read_page(&scope, &library.id, &topic_id, None)?
                .draft
                .markdown,
            text
        );
    }
    Ok(())
}

#[tokio::test]
async fn omitted_read_base_revision_is_inferred_and_a_later_human_edit_still_blocks_commit()
-> Result<()> {
    use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
    let temp = tempfile::tempdir()?;
    let mut catalog = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("owned-cas-fixture", "local")?;
    let library = catalog.create(&scope, "create", "Wiki", "Server K100 facts and conditions")?;
    let source = catalog.import_text(&scope, &library.id, "source", "Server K100", SOURCE)?;
    let page_id = "ad48d3bc-f1b2-4a58-8594-2e8ad7ab8a54";
    let initial = catalog.commit_generated_pages(
        &scope,
        &library.id,
        "seed",
        vec![KnowledgePageDraft {
            page_id: page_id.into(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "Server K100".into(),
            markdown: SOURCE.into(),
            related_page_ids: vec![],
            citations: vec![KnowledgeCitation {
                source_id: source.source_id.clone(),
                revision_id: source.revision_id.clone(),
                chunk_id: "chunk-1".into(),
                quote: SOURCE.into(),
            }],
        }],
    )?;
    let model = FormattingModel {
        source_text: SOURCE.into(),
        query_existing: true,
        ..Default::default()
    };
    let prepared = catalog
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
    assert!(prepared.proposal.review_notes.is_empty());
    assert_eq!(prepared.proposal.pages[0].page_id, page_id);
    assert_eq!(
        prepared.proposal.pages[0].expected_revision.as_deref(),
        Some(initial[0].revision_id.as_str())
    );
    assert_eq!(
        *model.calls.lock().unwrap(),
        ["analysis", "generation", "source_support"]
    );
    assert!(
        !model
            .raw_proposal
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .contains("expected_revision")
    );
    catalog.edit_page(
        &scope,
        &library.id,
        page_id,
        &initial[0].revision_id,
        "human-edit",
        "Human title",
        "Human changes must survive.",
    )?;
    assert!(
        catalog
            .commit_generated_pages(&scope, &library.id, "stale-update", prepared.proposal.pages)
            .is_err()
    );
    assert_eq!(
        catalog
            .read_page(&scope, &library.id, page_id, None)?
            .draft
            .markdown,
        "Human changes must survive."
    );
    Ok(())
}

#[tokio::test]
async fn loose_model_text_organizes_without_format_repairs_and_replays_paid_stages() -> Result<()> {
    for (unsupported, long_structure, nested_envelopes) in [
        (false, false, false),
        (true, false, false),
        (false, true, false),
        (false, false, true),
        (false, true, true),
    ] {
        let text = if long_structure {
            format!(
                "{SOURCE}\n```sql\nCREATE TABLE server_k100 (\n{}\n);\n```\n",
                (0..100)
                    .map(|index| format!("  field_{index:03} TEXT NOT NULL"))
                    .collect::<Vec<_>>()
                    .join(",\n")
            )
        } else {
            SOURCE.into()
        };
        if long_structure {
            assert!(text.chars().count() > 2000);
        }
        let temp = tempfile::tempdir()?;
        let mut catalog = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("owned-format-fixture", "local")?;
        let library =
            catalog.create(&scope, "create", "Wiki", "Server K100 facts and conditions")?;
        let source = catalog.import_text(&scope, &library.id, "source", "Server K100", &text)?;
        let request = || WikiIngestRequest {
            library_id: &library.id,
            source_id: &source.source_id,
            source_revision: &source.revision_id,
            after_chunk: 0,
            output_language: "en",
            context_tokens: 64000,
        };
        let model = FormattingModel {
            source_text: text.clone(),
            unsupported,
            nested_envelopes,
            ..Default::default()
        };
        let prepared = catalog
            .prepare_wiki_update(&scope, request(), &model, &CancellationToken::new())
            .await?;
        assert_eq!(
            *model.calls.lock().unwrap(),
            ["analysis", "generation", "source_support"]
        );
        assert_eq!(prepared.proposal.pages[0].markdown, text);
        assert!(
            prepared.proposal.pages[0]
                .citations
                .iter()
                .all(|citation| citation.source_id == source.source_id
                    && citation.revision_id == source.revision_id
                    && text.contains(&citation.quote))
        );
        assert_eq!(!prepared.proposal.review_notes.is_empty(), unsupported);
        assert_eq!(
            prepared.proposal.advisory_notes.len(),
            if nested_envelopes { 2 } else { 0 }
        );
        assert!(prepared.proposal.organization_proof.is_some());
        assert!(
            model
                .wire
                .lock()
                .unwrap()
                .values()
                .any(|raw| Some(raw) == model.raw_proposal.lock().unwrap().as_ref())
        );
        // Lose the typed generation candidate; the complete old-key JSON cache
        // alone still recovers it without repeating the provider or paid review.
        model
            .proposals
            .lock()
            .unwrap()
            .retain(|key, _| !key.contains("\"stage\":\"generation\""));
        let replay = catalog
            .prepare_wiki_update(&scope, request(), &model, &CancellationToken::new())
            .await?;
        assert_eq!(
            serde_json::to_value(&replay.proposal)?,
            serde_json::to_value(&prepared.proposal)?
        );
        assert_eq!(model.calls.lock().unwrap().len(), 3);

        let job = catalog.enqueue_ingest(
            &scope,
            &library.id,
            "job",
            &source.source_id,
            &source.revision_id,
            kcoder_knowledge::PREPARATION_VERSION,
            "en",
        )?;
        let lease = catalog.claim_job(&scope, &library.id, &job.id)?.unwrap();
        // Accepted raw model formatting is also a complete durable recovery
        // input. It remains private and is never itself a publishable checkpoint.
        let raw = model.raw_proposal.lock().unwrap().clone().unwrap();
        catalog.remember_json_response(&scope, &library.id, &lease, &"a".repeat(64), &raw)?;
        assert_eq!(
            catalog
                .cached_json_response(&scope, &library.id, &lease, &"a".repeat(64))?
                .unwrap(),
            raw
        );
        catalog.save_job_checkpoint(
            &scope,
            &library.id,
            &lease,
            &WikiCheckpoint {
                through_chunk: prepared.through_chunk,
                has_more_chunks: prepared.has_more_chunks,
                proposal: prepared.proposal,
            },
        )?;
        if unsupported {
            // The worker routes blocking findings to review before publication.
            catalog.stop_job_with_reason(
                &scope,
                &library.id,
                &lease,
                "awaiting_review",
                "review_required",
            )?;
            assert!(
                catalog
                    .commit_job_checkpoint(&scope, &library.id, &lease)
                    .is_err()
            );
            assert!(
                catalog
                    .list_pages(&scope, &library.id, None, 100)?
                    .is_empty()
            );
        } else {
            catalog.commit_job_checkpoint(&scope, &library.id, &lease)?;
            assert_eq!(catalog.list_pages(&scope, &library.id, None, 100)?.len(), 3);
        }
    }
    Ok(())
}
