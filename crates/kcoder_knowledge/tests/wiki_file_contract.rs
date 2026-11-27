//! File-contract (pipeline v2) lifecycle tests with scripted turns. Fixture
//! verdicts exercise host mechanics only, never semantic model quality.
#[path = "fixtures/organization.rs"]
#[allow(dead_code)]
mod organization_fixture;
use anyhow::Result;
use async_trait::async_trait;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, PreparedWikiUpdate, WikiCheckpoint, WikiIngestRequest,
    WikiModel, WikiModelRequest, WikiOutputTruncated, WikiToolStep, WikiTurnRequest,
    WikiTurnResponse,
};
use kcoder_types::knowledge::KnowledgePageKind;
use kcoder_types::wiki_findings::{WikiPageVerificationStatus, WikiUnverifiedVerdict};
use kcoder_types::{ContentBlock, Message};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio_util::sync::CancellationToken;

const SOURCE: &str = "# Services\n\nAlpha uses port 8080.\n\nBeta stores data in SQLite.\n";

type TurnFn = Box<dyn Fn(&WikiTurnRequest, &Context) -> Result<WikiTurnResponse> + Send + Sync>;

/// Facts the scripted model may read from the host's first message.
#[derive(Default, Clone)]
struct Context {
    chunks: Vec<String>,
    new_ids: Vec<String>,
}

fn parse_context(request: &WikiTurnRequest) -> Context {
    let Some(Message::User { content, .. }) = request.messages.first() else {
        return Context::default();
    };
    let Some(ContentBlock::Text { text }) = content.first() else {
        return Context::default();
    };
    let mut context = Context::default();
    for line in text.lines() {
        if let Some(rest) = line
            .starts_with("- sources/")
            .then(|| line.split("chunkId ").nth(1))
            .flatten()
        {
            context
                .chunks
                .push(rest.split(',').next().unwrap().trim().to_owned());
        }
        if let Some(id) = line
            .strip_prefix("- ")
            .and_then(|rest| rest.strip_suffix(": new topic page"))
        {
            context.new_ids.push(id.to_owned());
        }
    }
    context
}

struct Scripted {
    turns: Mutex<VecDeque<TurnFn>>,
    turn_stages: Mutex<Vec<&'static str>>,
    completes: Mutex<Vec<&'static str>>,
    steps: Mutex<Vec<WikiToolStep>>,
    received: Mutex<HashMap<String, String>>,
    verdict: &'static str,
    crash_after_saves: AtomicUsize,
    failed_once: std::sync::atomic::AtomicBool,
}

impl Scripted {
    fn new(turns: Vec<TurnFn>) -> Self {
        Self {
            turns: Mutex::new(turns.into()),
            turn_stages: Mutex::new(Vec::new()),
            completes: Mutex::new(Vec::new()),
            steps: Mutex::new(Vec::new()),
            received: Mutex::new(HashMap::new()),
            verdict: "supported",
            crash_after_saves: AtomicUsize::new(usize::MAX),
            failed_once: std::sync::atomic::AtomicBool::new(false),
        }
    }
    fn key(request: &WikiModelRequest) -> String {
        format!("{}\0{}\0{}", request.stage, request.system, request.user)
    }
}

#[async_trait]
impl WikiModel for Scripted {
    fn file_contract(&self) -> bool {
        true
    }
    async fn complete(&self, request: WikiModelRequest) -> Result<String> {
        self.completes.lock().unwrap().push(request.stage);
        let input: Value = serde_json::from_str(&request.user)?;
        if request.stage == "analysis" {
            return Ok(organization_fixture::with_plan(
                &input,
                json!({"summary":"Service facts","queries":[],"conflicts":[]}),
            )
            .to_string());
        }
        if request.stage == "support_repair" {
            return Ok("still not json".into());
        }
        assert_eq!(input["repairKind"], "source_support", "{}", request.stage);
        if self.verdict == "fail-once" && !self.failed_once.swap(true, Ordering::SeqCst) {
            anyhow::bail!("simulated crash before verification completed");
        }
        let units = input["units"].as_array().unwrap();
        let rows: Vec<Value> = match self.verdict {
            "malformed" => return Ok("not json".into()),
            "missing" => units.iter().skip(1).map(row_supported).collect(),
            "duplicate" => units.iter().chain(units.iter().take(1)).map(row_supported).collect(),
            "unsupported" => units
                .iter()
                .map(|unit| json!({"pageId":unit["pageId"],"unit":unit["unit"],"verdict":"unsupported","citationIndices":[]}))
                .collect(),
            _ => units.iter().map(row_supported).collect(),
        };
        let mut answer = json!({"sourceCoverage":"complete","units":rows});
        if input["organizationInventory"].is_object() {
            answer = organization_fixture::with_organization_support(&input, answer);
        }
        Ok(answer.to_string())
    }
    fn stage_received_response(&self, request: &WikiModelRequest) -> Result<Option<String>> {
        Ok(self
            .received
            .lock()
            .unwrap()
            .get(&Self::key(request))
            .cloned())
    }
    fn stage_remember_received(&self, request: &WikiModelRequest, raw: &str) -> Result<()> {
        self.received
            .lock()
            .unwrap()
            .insert(Self::key(request), raw.into());
        Ok(())
    }
    async fn complete_turn(
        &self,
        request: WikiTurnRequest,
        _limit: u32,
    ) -> Result<WikiTurnResponse> {
        assert_eq!(
            request
                .tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            ["read", "edit", "write"]
        );
        self.turn_stages.lock().unwrap().push(request.stage);
        let context = parse_context(&request);
        let Some(next) = self.turns.lock().unwrap().pop_front() else {
            let last = serde_json::to_string(request.messages.last().unwrap()).unwrap();
            panic!(
                "scripted turn available; last host message: {}",
                &last[..last.len().min(3000)]
            );
        };
        next(&request, &context)
    }
    fn tool_steps(&self, loop_key: &str) -> Result<Vec<WikiToolStep>> {
        Ok(self
            .steps
            .lock()
            .unwrap()
            .iter()
            .filter(|step| step.loop_key == loop_key)
            .cloned()
            .collect())
    }
    fn tool_step_save(&self, step: &WikiToolStep) -> Result<()> {
        let left = self.crash_after_saves.load(Ordering::SeqCst);
        anyhow::ensure!(left > 0, "simulated crash");
        self.crash_after_saves
            .store(left.saturating_sub(1), Ordering::SeqCst);
        let mut steps = self.steps.lock().unwrap();
        steps.retain(|known| !(known.loop_key == step.loop_key && known.step == step.step));
        steps.push(step.clone());
        steps.sort_by_key(|known| known.step);
        Ok(())
    }
    fn tool_steps_discard(&self, loop_key: &str, from: usize) -> Result<()> {
        self.steps
            .lock()
            .unwrap()
            .retain(|step| step.loop_key != loop_key || step.step < from);
        Ok(())
    }
}

fn row_supported(unit: &Value) -> Value {
    json!({"pageId":unit["pageId"],"unit":unit["unit"],"verdict":"supported",
        "citationIndices":unit["allowedCitationIndices"].as_array().unwrap().iter().take(1).cloned().collect::<Vec<_>>()})
}

fn response(content: Vec<ContentBlock>) -> WikiTurnResponse {
    WikiTurnResponse {
        content,
        invalid_tool_inputs: vec![],
        stop_reason: None,
    }
}
fn call(id: &str, name: &str, input: Value) -> ContentBlock {
    ContentBlock::ToolUse {
        id: id.into(),
        name: name.into(),
        input,
    }
}
fn text(value: &str) -> ContentBlock {
    ContentBlock::Text { text: value.into() }
}

/// A complete topic page covering every source line with whole-chunk citations.
fn page(id: &str, context: &Context, body_extra: &str) -> String {
    let mut text = format!(
        "---\npageId: {id}\nkind: concept\ntitle: Services\n---\n{}{body_extra}\n\n",
        SOURCE.trim_end()
    );
    for (index, chunk) in context.chunks.iter().enumerate() {
        text.push_str(&format!("[^c{}]: chunk {chunk}\n", index + 1));
    }
    text
}

fn write_page(id_index: usize) -> TurnFn {
    Box::new(move |_, context| {
        Ok(response(vec![call(
            "w1",
            "write",
            json!({"file_path":format!("draft/{}.md", context.new_ids[id_index]),"content":page(&context.new_ids[id_index], context, "")}),
        )]))
    })
}
fn deliver() -> TurnFn {
    Box::new(|_, _| Ok(response(vec![text("Done; drafts are ready.")])))
}

struct Setup {
    _dir: tempfile::TempDir,
    store: KnowledgeCatalog,
    scope: KnowledgeScope,
    library: String,
    source: kcoder_knowledge::SourceRevision,
}

fn setup() -> Result<Setup> {
    let dir = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&dir.path().join("wiki.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("owner", "local")?;
    let library = store
        .create(&scope, "create", "Wiki", "Operate the services")?
        .id;
    let source = store.import_text(&scope, &library, "source", "Services", SOURCE)?;
    Ok(Setup {
        _dir: dir,
        store,
        scope,
        library,
        source,
    })
}

async fn prepare(setup: &mut Setup, model: &Scripted) -> Result<PreparedWikiUpdate> {
    setup
        .store
        .prepare_wiki_update(
            &setup.scope,
            WikiIngestRequest {
                library_id: &setup.library,
                source_id: &setup.source.source_id,
                source_revision: &setup.source.revision_id,
                after_chunk: 0,
                output_language: "en",
                context_tokens: 200_000,
            },
            model,
            &CancellationToken::new(),
        )
        .await
}

fn topic_pages(prepared: &PreparedWikiUpdate) -> Vec<&kcoder_types::knowledge::KnowledgePageDraft> {
    prepared
        .proposal
        .pages
        .iter()
        .filter(|page| page.kind == KnowledgePageKind::Concept)
        .collect()
}

#[tokio::test]
async fn multi_turn_reads_then_writes_and_publishes_a_verified_page() -> Result<()> {
    let mut setup = setup()?;
    let model = Scripted::new(vec![
        Box::new(|_, _| {
            Ok(response(vec![call(
                "r1",
                "read",
                json!({"file_path":"plan.md"}),
            )]))
        }),
        Box::new(|_, context| {
            let id = &context.new_ids[0];
            Ok(response(vec![
                call(
                    "w1",
                    "write",
                    json!({"file_path":format!("draft/{id}.md"),"content":page(id, context, "")}),
                ),
                call(
                    "review1",
                    "write",
                    json!({"file_path":"review.md","content":"# Review\n\n## Blocking\n- 无。\n\n## Notes\n"}),
                ),
            ]))
        }),
        deliver(),
    ]);
    let prepared = prepare(&mut setup, &model).await?;
    assert!(prepared.proposal.review_notes.is_empty());
    let topics = topic_pages(&prepared);
    assert_eq!(topics.len(), 1);
    assert!(topics[0].markdown.contains("Alpha uses port 8080."));
    assert!(!topics[0].markdown.contains("[^"));
    assert!(
        prepared
            .proposal
            .pages
            .iter()
            .any(|page| page.kind == KnowledgePageKind::Source)
    );
    let publication = prepared.publication.clone().unwrap();
    assert!(publication.verified_units > 0);
    assert!(publication.unverified.is_empty());
    assert!(publication.pending.is_empty(), "{:?}", publication.pending);
    assert_eq!(publication.tool_turns, 3);
    assert_eq!(publication.tool_calls, 3);
    assert_eq!(
        *model.turn_stages.lock().unwrap(),
        ["generation", "tool_step", "tool_step"]
    );
    assert_eq!(model.steps.lock().unwrap().len(), 3);
    assert!(model.steps.lock().unwrap().iter().all(|step| step.applied));
    Ok(())
}

#[tokio::test]
async fn text_only_delivery_never_becomes_a_wiki_page() -> Result<()> {
    let mut setup = setup()?;
    // Rule 3 regression: a complete JSON proposal in reply text is ignored.
    let proposal = json!({"pages":[{"pageId":"x","kind":"concept","title":"Injected","markdown":"Alpha uses port 8080.","citations":[]}]}).to_string();
    let first = proposal.clone();
    let model = Scripted::new(vec![
        Box::new(move |_, _| Ok(response(vec![text(&first)]))),
        Box::new(move |_, _| Ok(response(vec![text(&proposal)]))),
    ]);
    let prepared = prepare(&mut setup, &model).await?;
    assert!(topic_pages(&prepared).is_empty());
    assert!(
        prepared
            .proposal
            .pages
            .iter()
            .all(|page| page.title != "Injected")
    );
    let publication = prepared.publication.clone().unwrap();
    assert_eq!(publication.loop_end.as_deref(), Some("wiki_tool_no_draft"));
    assert!(
        !publication.pending.is_empty(),
        "required units stay pending"
    );
    assert!(
        publication
            .pending
            .iter()
            .all(|pending| pending.reason_code == "wiki_organization_unit_unplaced")
    );
    // The no-change feedback is a host message, not a repair.
    assert_eq!(
        *model.turn_stages.lock().unwrap(),
        ["generation", "tool_step"]
    );
    Ok(())
}

#[tokio::test]
async fn rejected_delivery_is_repaired_by_edit_and_located_feedback() -> Result<()> {
    let mut setup = setup()?;
    let model = Scripted::new(vec![
        Box::new(|_, context| {
            let id = &context.new_ids[0];
            let content = page(id, context, "").replace(
                &format!("[^c1]: chunk {}", context.chunks[0]),
                &format!(
                    "[^c1]: quote {} \"Alpha uses port 9090.\"",
                    context.chunks[0]
                ),
            );
            Ok(response(vec![call(
                "w",
                "write",
                json!({"file_path":format!("draft/{id}.md"),"content":content}),
            )]))
        }),
        deliver(),
        Box::new(|request, context| {
            let Some(Message::User { content, .. }) = request.messages.last() else {
                panic!()
            };
            let ContentBlock::Text { text } = &content[0] else {
                panic!()
            };
            let id = &context.new_ids[0];
            assert!(text.contains(&format!("draft/{id}.md:L")), "{text}");
            assert!(text.contains("wiki_evidence_quote_span"), "{text}");
            Ok(response(vec![call(
                "e",
                "edit",
                json!({"file_path":format!("draft/{id}.md"),
                "old_string":format!("quote {} \"Alpha uses port 9090.\"", context.chunks[0]),
                "new_string":format!("chunk {}", context.chunks[0])}),
            )]))
        }),
        deliver(),
    ]);
    let prepared = prepare(&mut setup, &model).await?;
    assert_eq!(topic_pages(&prepared).len(), 1);
    assert_eq!(
        *model.turn_stages.lock().unwrap(),
        ["generation", "tool_step", "citation_repair", "tool_step"]
    );
    Ok(())
}

#[tokio::test]
async fn truncated_turn_runs_nothing_and_retries_once() -> Result<()> {
    let mut setup = setup()?;
    let model = Scripted::new(vec![
        Box::new(|_, _| {
            Err(WikiOutputTruncated {
                stage: "generation",
                text_bytes: 10,
                reasoning_bytes: 0,
                requested_tokens: 100,
                reported_output_tokens: Some(100),
                stop_reason: "max_tokens".into(),
            }
            .into())
        }),
        write_page(0),
        deliver(),
    ]);
    let prepared = prepare(&mut setup, &model).await?;
    assert_eq!(topic_pages(&prepared).len(), 1);
    assert_eq!(model.turn_stages.lock().unwrap()[1], "truncation_retry");
    Ok(())
}

#[tokio::test]
async fn turn_limit_delivers_current_drafts_and_empty_drafts_publish_only_host_pages() -> Result<()>
{
    let mut setup = setup()?;
    let turns: Vec<TurnFn> = (0..20)
        .map(|index| -> TurnFn {
            Box::new(move |_, _| {
                Ok(response(vec![call(
                    &format!("r{index}"),
                    "read",
                    json!({"file_path":"index.md"}),
                )]))
            })
        })
        .collect();
    let model = Scripted::new(turns);
    let prepared = prepare(&mut setup, &model).await?;
    let publication = prepared.publication.clone().unwrap();
    assert_eq!(
        publication.loop_end.as_deref(),
        Some("wiki_tool_turn_limit")
    );
    assert_eq!(publication.tool_turns, 12);
    assert!(topic_pages(&prepared).is_empty());
    assert!(prepared.proposal.pages.iter().all(|page| matches!(
        page.kind,
        KnowledgePageKind::Source | KnowledgePageKind::Overview
    )));
    Ok(())
}

#[tokio::test]
async fn inexact_page_is_withheld_while_valid_pages_publish_and_links_are_dropped() -> Result<()> {
    let mut setup = setup()?;
    let bad: TurnFn = Box::new(|_, context| {
        let (good, bad) = (&context.new_ids[0], &context.new_ids[1]);
        let good_page = page(good, context, "").replace(
            "title: Services",
            &format!("title: Services\nrelatedPageIds: [{bad}]"),
        );
        let bad_page = format!(
            "---\npageId: {bad}\nkind: concept\ntitle: Wrong\n---\nGamma[^c1]\n\n[^c1]: quote {} \"Gamma uses port 1.\"\n",
            context.chunks[0]
        );
        Ok(response(vec![
            call(
                "g",
                "write",
                json!({"file_path":format!("draft/{good}.md"),"content":good_page}),
            ),
            call(
                "b",
                "write",
                json!({"file_path":format!("draft/{bad}.md"),"content":bad_page}),
            ),
        ]))
    });
    let mut turns: Vec<TurnFn> = vec![bad];
    // Keep delivering the same drafts until feedback budget is exhausted.
    for _ in 0..8 {
        turns.push(deliver());
    }
    let model = Scripted::new(turns);
    let prepared = prepare(&mut setup, &model).await?;
    let topics = topic_pages(&prepared);
    assert_eq!(topics.len(), 1, "only the exact page is published");
    assert!(
        topics[0].related_page_ids.is_empty(),
        "links to withheld pages are removed"
    );
    let publication = prepared.publication.clone().unwrap();
    assert!(publication.verified_units > 0);
    Ok(())
}

#[tokio::test]
async fn lenient_verification_marks_only_affected_ranges_unverified() -> Result<()> {
    for (verdict, expected) in [
        ("missing", WikiUnverifiedVerdict::Unassessed),
        ("duplicate", WikiUnverifiedVerdict::Uncertain),
        ("unsupported", WikiUnverifiedVerdict::Unsupported),
        ("malformed", WikiUnverifiedVerdict::Unassessed),
    ] {
        let mut setup = setup()?;
        let mut model = Scripted::new(vec![write_page(0), deliver(), deliver()]);
        model.verdict = verdict;
        let prepared = prepare(&mut setup, &model).await?;
        assert_eq!(
            topic_pages(&prepared).len(),
            1,
            "{verdict}: still published"
        );
        let publication = prepared.publication.clone().unwrap();
        assert!(!publication.unverified.is_empty(), "{verdict}");
        assert!(
            publication
                .unverified
                .iter()
                .any(|finding| finding.verdict == expected),
            "{verdict}: {:?}",
            publication.unverified
        );
        let total_units = publication.verified_units + publication.unverified.len();
        assert!(
            publication.verified_units < total_units,
            "{verdict}: unverified never counted as verified"
        );
        if verdict == "malformed" {
            assert!(model.completes.lock().unwrap().contains(&"support_repair"));
        }
    }
    Ok(())
}

#[tokio::test]
async fn resume_after_received_or_applied_step_never_repeats_a_model_turn() -> Result<()> {
    // Saves: step 0 received, step 0 applied, step 1 received, step 1 applied.
    // 1: crash after the write turn was received (its tools never ran).
    // 3: crash after the delivery was received and verified, before applied.
    for (crash_after, new_turns) in [(1usize, 1usize), (3, 0)] {
        let mut setup = setup()?;
        let model = Scripted::new(vec![write_page(0), deliver()]);
        model.crash_after_saves.store(crash_after, Ordering::SeqCst);
        assert!(
            prepare(&mut setup, &model).await.is_err(),
            "crash after save {crash_after}"
        );
        let before = model.turn_stages.lock().unwrap().len();
        let verified = |model: &Scripted| {
            model
                .completes
                .lock()
                .unwrap()
                .iter()
                .filter(|stage| **stage == "source_support")
                .count()
        };
        let verifications_before = verified(&model);
        model.crash_after_saves.store(usize::MAX, Ordering::SeqCst);
        let prepared = prepare(&mut setup, &model).await?;
        assert_eq!(
            topic_pages(&prepared).len(),
            1,
            "crash after save {crash_after}"
        );
        assert_eq!(
            model.turn_stages.lock().unwrap().len(),
            before + new_turns,
            "crash after save {crash_after}"
        );
        assert_eq!(
            verified(&model),
            verifications_before.max(1),
            "received verification is reused"
        );
        assert!(model.steps.lock().unwrap().iter().all(|step| step.applied));
    }
    Ok(())
}

#[tokio::test]
async fn crash_before_verification_replays_the_delivery_without_a_new_turn() -> Result<()> {
    let mut setup = setup()?;
    let mut model = Scripted::new(vec![write_page(0), deliver()]);
    model.verdict = "fail-once";
    assert!(prepare(&mut setup, &model).await.is_err());
    assert_eq!(model.turn_stages.lock().unwrap().len(), 2);
    assert_eq!(
        model
            .steps
            .lock()
            .unwrap()
            .iter()
            .filter(|step| step.applied)
            .count(),
        1
    );
    let prepared = prepare(&mut setup, &model).await?;
    assert_eq!(topic_pages(&prepared).len(), 1);
    assert_eq!(
        model.turn_stages.lock().unwrap().len(),
        2,
        "no turn is bought again"
    );
    Ok(())
}

#[tokio::test]
async fn new_topic_capacity_follows_source_size_within_bounds() -> Result<()> {
    let mut setup = setup()?;
    // Small source: two topic IDs are offered; a third new page is impossible.
    let model = Scripted::new(vec![
        Box::new(|_, context| {
            assert_eq!(context.new_ids.len(), 2);
            Ok(response(vec![call(
                "w",
                "write",
                json!({"file_path":"draft/not-allocated.md","content":"x"}),
            )]))
        }),
        write_page(0),
        deliver(),
    ]);
    let prepared = prepare(&mut setup, &model).await?;
    assert_eq!(topic_pages(&prepared).len(), 1);
    Ok(())
}

#[tokio::test]
async fn committed_findings_project_page_verification_and_decisions() -> Result<()> {
    let mut setup = setup()?;
    let job = setup.store.enqueue_ingest(
        &setup.scope,
        &setup.library,
        "job",
        &setup.source.source_id,
        &setup.source.revision_id,
        "recipe",
        "en",
    )?;
    let lease = setup
        .store
        .claim_job(&setup.scope, &setup.library, &job.id)?
        .unwrap();
    assert_eq!(
        setup
            .store
            .job_pipeline_version(&setup.scope, &setup.library, &job.id)?,
        2
    );
    let mut model = Scripted::new(vec![write_page(0), deliver(), deliver()]);
    model.verdict = "unsupported";
    let prepared = prepare(&mut setup, &model).await?;
    let publication = prepared.publication.clone().unwrap();
    setup.store.save_job_checkpoint_with_publication(
        &setup.scope,
        &setup.library,
        &lease,
        &WikiCheckpoint {
            through_chunk: prepared.through_chunk,
            has_more_chunks: prepared.has_more_chunks,
            proposal: prepared.proposal,
        },
        Some(&publication),
    )?;
    let published = setup
        .store
        .commit_job_checkpoint(&setup.scope, &setup.library, &lease)?;
    // Replaying the receipt records nothing twice.
    assert_eq!(
        setup
            .store
            .commit_job_checkpoint(&setup.scope, &setup.library, &lease)?,
        published
    );
    setup
        .store
        .finish_job_batch(&setup.scope, &setup.library, &lease)?;
    let job = setup
        .store
        .read_job(&setup.scope, &setup.library, &job.id)?;
    let outcome = job.outcome.unwrap();
    assert_eq!(
        outcome.unverified.unsupported as usize,
        publication.unverified.len()
    );
    assert_eq!(outcome.verified_units as usize, publication.verified_units);
    let topic = published
        .iter()
        .find(|page| {
            setup
                .store
                .read_page(&setup.scope, &setup.library, &page.page_id, None)
                .unwrap()
                .draft
                .kind
                == KnowledgePageKind::Concept
        })
        .unwrap();
    let verification = setup.store.page_verification(
        &setup.scope,
        &setup.library,
        &topic.page_id,
        &topic.revision_id,
    )?;
    assert_eq!(verification.status, WikiPageVerificationStatus::Partial);
    let (findings, _) = setup.store.list_findings(
        &setup.scope,
        &setup.library,
        Some(&topic.page_id),
        None,
        false,
        None,
        100,
    )?;
    assert_eq!(findings.len(), publication.unverified.len());
    assert!(
        setup
            .store
            .decide_finding(
                &setup.scope,
                &setup.library,
                &findings[0].finding_id,
                "stale-revision",
                true,
                "k0"
            )
            .is_err()
    );
    for (index, finding) in findings.iter().enumerate() {
        setup.store.decide_finding(
            &setup.scope,
            &setup.library,
            &finding.finding_id,
            &topic.revision_id,
            true,
            &format!("k{index}"),
        )?;
    }
    assert!(
        setup
            .store
            .decide_finding(
                &setup.scope,
                &setup.library,
                &findings[0].finding_id,
                &topic.revision_id,
                false,
                "k0"
            )
            .is_err(),
        "idempotency conflict"
    );
    let verification = setup.store.page_verification(
        &setup.scope,
        &setup.library,
        &topic.page_id,
        &topic.revision_id,
    )?;
    assert_eq!(verification.status, WikiPageVerificationStatus::Verified);
    let summary = setup
        .store
        .list_pages(&setup.scope, &setup.library, None, 100)?;
    assert!(summary.iter().any(|page| page.unverified_count == Some(0)));
    // A human edit is reported as such, never as verified by the model.
    let human = setup.store.edit_page(
        &setup.scope,
        &setup.library,
        &topic.page_id,
        &topic.revision_id,
        "human",
        "Services",
        "Edited by a person.",
    )?;
    assert_eq!(
        setup
            .store
            .page_verification(
                &setup.scope,
                &setup.library,
                &topic.page_id,
                &human.revision_id
            )?
            .status,
        WikiPageVerificationStatus::HumanEdited
    );
    Ok(())
}

#[tokio::test]
async fn pending_units_are_listed_and_organized_only_on_explicit_request() -> Result<()> {
    let mut setup = setup()?;
    let job = setup.store.enqueue_ingest(
        &setup.scope,
        &setup.library,
        "job",
        &setup.source.source_id,
        &setup.source.revision_id,
        "recipe",
        "en",
    )?;
    let lease = setup
        .store
        .claim_job(&setup.scope, &setup.library, &job.id)?
        .unwrap();
    let model = Scripted::new(vec![deliver(), deliver()]);
    let prepared = prepare(&mut setup, &model).await?;
    let publication = prepared.publication.clone().unwrap();
    assert!(!publication.pending.is_empty());
    setup.store.save_job_checkpoint_with_publication(
        &setup.scope,
        &setup.library,
        &lease,
        &WikiCheckpoint {
            through_chunk: prepared.through_chunk,
            has_more_chunks: prepared.has_more_chunks,
            proposal: prepared.proposal,
        },
        Some(&publication),
    )?;
    setup
        .store
        .commit_job_checkpoint(&setup.scope, &setup.library, &lease)?;
    setup
        .store
        .finish_job_batch(&setup.scope, &setup.library, &lease)?;
    let (pending, _) =
        setup
            .store
            .list_pending(&setup.scope, &setup.library, None, false, None, 100)?;
    assert_eq!(pending.len(), publication.pending.len());
    assert!(
        pending
            .iter()
            .all(|unit| unit.status == kcoder_types::wiki_findings::WikiPendingStatus::Open)
    );
    // No job is created automatically.
    assert_eq!(
        setup
            .store
            .list_jobs(&setup.scope, &setup.library, None, 100)?
            .len(),
        1
    );
    let ids: Vec<String> = pending.iter().map(|unit| unit.pending_id.clone()).collect();
    let organize = setup.store.organize_pending(
        &setup.scope,
        &setup.library,
        &ids,
        "organize",
        "recipe",
        "en",
    )?;
    assert_eq!(
        setup
            .store
            .job_window_limit(&setup.scope, &setup.library, &organize.id)?,
        Some(1)
    );
    let again = setup.store.organize_pending(
        &setup.scope,
        &setup.library,
        &ids,
        "organize",
        "recipe",
        "en",
    )?;
    assert_eq!(again.id, organize.id, "idempotent");
    let (pending, _) =
        setup
            .store
            .list_pending(&setup.scope, &setup.library, None, false, None, 100)?;
    assert!(
        pending
            .iter()
            .all(|unit| unit.status == kcoder_types::wiki_findings::WikiPendingStatus::Organizing)
    );
    assert!(
        setup
            .store
            .organize_pending(&setup.scope, &setup.library, &ids, "other", "recipe", "en")
            .is_err()
    );
    Ok(())
}

#[test]
fn legacy_jobs_migrate_at_claim_unless_a_validated_checkpoint_exists() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("wiki.sqlite");
    let mut store = KnowledgeCatalog::open(&path)?;
    let scope = KnowledgeScope::from_authenticated_host("owner", "local")?;
    let library = store.create(&scope, "create", "Wiki", "Goal")?.id;
    let source = store.import_text(&scope, &library, "source", "Services", SOURCE)?;
    let started = store.enqueue_ingest(
        &scope,
        &library,
        "started",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "en",
    )?;
    let prepared = store.enqueue_ingest(
        &scope,
        &library,
        "prepared",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "en",
    )?;
    let raw = rusqlite::Connection::open(&path)?;
    let progress = r#"{"phase":"analysis","startedAtMs":1,"phaseStartedAtMs":1,"heartbeatAtMs":1,"modelProgressAtMs":null,"model":"m","reasoningEffort":null,"textBytes":0,"reasoningBytes":0,"throughChunk":null,"totalChunks":null,"firstPage":null,"lastPage":null,"callLimit":null,"requestedOutputTokens":null,"estimatedInputTokens":null,"reservedCalls":0,"repairCalls":0,"usageReportedCalls":0,"inputTokens":null,"outputTokens":null}"#;
    raw.execute(
        "UPDATE knowledge_jobs SET pipeline_version=1,progress_json=?2 WHERE job_id=?1",
        [&started.id, progress],
    )?;
    raw.execute(
        "UPDATE knowledge_jobs SET pipeline_version=1,checkpoint_json='{}' WHERE job_id=?1",
        [&prepared.id],
    )?;
    drop(raw);
    // A legacy staged job without a checkpoint restarts its batch with files.
    let lease = store.claim_job(&scope, &library, &started.id)?.unwrap();
    assert_eq!(
        store.job_pipeline_version(&scope, &library, &started.id)?,
        2
    );
    assert_eq!(
        store
            .read_job(&scope, &library, &started.id)?
            .notice
            .as_deref(),
        Some("wiki_generation_restarted_for_file_contract")
    );
    // A checkpoint that already passed validation keeps its released contract.
    store.claim_job(&scope, &library, &prepared.id)?.unwrap();
    assert_eq!(
        store.job_pipeline_version(&scope, &library, &prepared.id)?,
        1
    );
    // Rebinding freezes another model recipe and discards old-model artifacts.
    store.stop_job_with_reason(
        &scope,
        &library,
        &lease,
        "paused",
        "organization_model_tools_unsupported",
    )?;
    let paused = store.read_job(&scope, &library, &started.id)?;
    assert_eq!(
        paused.error_code.as_deref(),
        Some("organization_model_tools_unsupported")
    );
    store.resume_job_with(&scope, &library, &started.id, Some("rebound-recipe"), false)?;
    let rebound = store.read_job(&scope, &library, &started.id)?;
    assert_eq!(rebound.status, "queued");
    assert_eq!(rebound.recipe_key, "rebound-recipe");
    assert_eq!(
        rebound.notice.as_deref(),
        Some("wiki_organization_model_rebound")
    );
    // Reorganize only applies to an uncommitted review checkpoint.
    assert!(
        store
            .resume_job_with(&scope, &library, &started.id, None, true)
            .is_err()
    );
    Ok(())
}
