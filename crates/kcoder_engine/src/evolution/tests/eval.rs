use super::*;
use crate::evolution::eval::{
    EvalLimits, EvalPlan, EvalVersion, Verdict, candidate_first, combine_verdicts,
    evaluation_result, parse_judgement,
};
use crate::evolution::eval_cases::{
    CaseSource, EvalCase, HardAssertion, bundled_catalog, catalog_eval_cases, diversity_delta,
    eval_cases, forbidden_patterns, hard_checks, regressions,
};
use kcoder_config::EvolutionStage;
use kcoder_types::evolution::{
    EVOLUTION_RECORD_VERSION, OverlayContent, ProfileHints, TargetRevision, UsageRecord, UsageTask,
};
use std::sync::atomic::{AtomicUsize, Ordering};

const CANDIDATE_MARK: &str = "CANDIDATE-LESSON";

/// How the fake judge decides.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Judge {
    PrefersCandidate,
    PrefersStable,
    /// Always answers "A": its two swapped verdicts always disagree.
    PositionBiased,
}

/// Deterministic evaluation provider: answers by inspecting the request,
/// so the order of concurrent calls does not matter.
struct EvalProvider {
    judge: Judge,
    hang: bool,
    /// Varying stable outputs, fixed candidate outputs (diversity drop).
    vary_stable_only: bool,
    tool_reply: bool,
    counter: AtomicUsize,
    requests: Mutex<Vec<MessagesRequest>>,
}

impl EvalProvider {
    fn new(judge: Judge) -> Self {
        Self {
            judge,
            hang: false,
            vary_stable_only: false,
            tool_reply: false,
            counter: AtomicUsize::new(0),
            requests: Mutex::new(Vec::new()),
        }
    }
}

fn user_text(request: &MessagesRequest) -> String {
    request
        .messages
        .iter()
        .flat_map(|message| match message {
            Message::User { content, .. } | Message::Assistant { content, .. } => content.clone(),
        })
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

impl Provider for EvalProvider {
    fn name(&self) -> &'static str {
        "eval-fake"
    }

    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.requests.lock().unwrap().push(request.clone());
        if self.hang {
            return Ok(Box::pin(futures::stream::pending()));
        }
        let system = request.system.clone().unwrap_or_default();
        let user = user_text(&request);
        let reply = if system.starts_with("You are a blind evaluator") {
            let a = user
                .split("<answer_a>")
                .nth(1)
                .unwrap_or_default()
                .split("</answer_a>")
                .next()
                .unwrap_or_default();
            let candidate_is_a = a.contains("candidate answer");
            let winner = match self.judge {
                Judge::PositionBiased => "A",
                Judge::PrefersCandidate if candidate_is_a => "A",
                Judge::PrefersCandidate => "B",
                Judge::PrefersStable if candidate_is_a => "B",
                Judge::PrefersStable => "A",
            };
            format!(
                "{{\"winner\": \"{winner}\", \"expectationsA\": [true], \"expectationsB\": [true]}}"
            )
        } else {
            let index = self.counter.fetch_add(1, Ordering::SeqCst);
            let candidate = system.contains(CANDIDATE_MARK);
            if self.tool_reply {
                return Ok(Box::pin(futures::stream::iter(
                    tool_events(
                        "bash",
                        &serde_json::json!({"command": "touch eval-side-effect"}),
                    )
                    .into_iter()
                    .map(Ok),
                )));
            }
            match (candidate, self.vary_stable_only) {
                (true, true) => "The candidate answer: a fixed formula reply every time.".into(),
                (false, true) => format!(
                    "Stable answer number {index} wanders through {} different imagery and pacing.",
                    [
                        "misty harbours",
                        "copper deserts",
                        "quiet libraries",
                        "neon alleys"
                    ][index % 4]
                ),
                (true, false) => "The candidate answer: outcome first, then details.".into(),
                (false, false) => "The stable answer: details first.".into(),
            }
        };
        Ok(Box::pin(futures::stream::iter(
            text_events(&reply, 10, 5).into_iter().map(Ok),
        )))
    }
}

fn case(id: &str) -> EvalCase {
    EvalCase {
        id: id.into(),
        prompt: format!("Summarize deployment {id}."),
        expected_output: None,
        expectations: vec!["Mentions the outcome".into()],
        assertions: Vec::new(),
    }
}

fn plan(cases: Vec<EvalCase>, procedure: bool, creative: Option<bool>) -> EvalPlan {
    EvalPlan {
        key: skill_key(),
        proposal_id: "prop-eval".into(),
        cases,
        stable: EvalVersion {
            body: "Deploy carefully.".into(),
            overlay: OverlayContent::default(),
        },
        candidate: EvalVersion {
            body: "Deploy carefully.".into(),
            overlay: OverlayContent {
                lessons: format!("- {CANDIDATE_MARK}: lead with the outcome."),
                ..Default::default()
            },
        },
        targeted_problem: "Users want the outcome first.".into(),
        forbidden: Vec::new(),
        procedure,
        creative,
    }
}

async fn evaluate(
    provider: Arc<EvalProvider>,
    plan: &EvalPlan,
    limits: EvalLimits,
) -> (kcoder_types::evolution::EvaluationResult, Fixture) {
    let fixture = fixture_with(settings(EvolutionMode::Auto), provider);
    let model = fixture
        .engine
        .resolve_evolution_model(EvolutionStage::Eval)
        .unwrap();
    let token = tokio_util::sync::CancellationToken::new();
    let (result, usage) = fixture
        .engine
        .run_evaluation(&model, plan, limits, &token)
        .await;
    if result.completed {
        assert!(usage.input_tokens > 0, "usage is accounted");
    }
    (result, fixture)
}

#[test]
fn case_sources_prefer_skill_evals_then_local_replay_then_none() {
    let temp = tempfile::tempdir().unwrap();
    let (_store_dir, store) = {
        let dir = tempfile::tempdir().unwrap();
        let store = EvolutionStore::open(dir.path()).unwrap();
        (dir, store)
    };
    let key = skill_key();
    // No evals and no replayable task: no offline evaluator.
    assert!(eval_cases(Some(temp.path()), None, None, &store, &key, 10, 8).is_none());

    // A workspace-dependent and a file-writing task are never replayed.
    let evidence = store
        .put_evidence("Write the release summary.", 1, 90)
        .unwrap();
    let record = |id: &str, workspace_dependent: bool, wrote: bool| UsageRecord {
        version: EVOLUTION_RECORD_VERSION,
        usage_id: id.into(),
        thread_id: "t".into(),
        turn_id: None,
        attempt_id: None,
        tool_call_id: None,
        target_key: key.clone(),
        revision: TargetRevision::new("rev", 0),
        channel: kcoder_types::evolution::Channel::Stable,
        task: UsageTask {
            request_hash: Some(format!("req-{id}")),
            evidence_ref: Some(evidence.clone()),
            workspace_dependent,
            ..Default::default()
        },
        profile_hints: ProfileHints {
            wrote_files: wrote,
            ..Default::default()
        },
        artifacts: Vec::new(),
        concurrent_targets: Vec::new(),
        started_at_ms: 1,
    };
    store.append_usage(&record("u-ws", true, false)).unwrap();
    store.append_usage(&record("u-file", false, true)).unwrap();
    assert!(eval_cases(Some(temp.path()), None, None, &store, &key, 10, 8).is_none());
    store.append_usage(&record("u-text", false, false)).unwrap();
    let (source, cases) = eval_cases(Some(temp.path()), None, None, &store, &key, 10, 8).unwrap();
    assert_eq!(source, CaseSource::LocalReplay);
    assert_eq!(cases.len(), 1);
    assert!(cases[0].prompt.contains("release summary"));

    // The skill's own evals.json wins; cases with missing files are skipped.
    std::fs::create_dir_all(temp.path().join("evals/files")).unwrap();
    std::fs::write(temp.path().join("evals/files/input.md"), "deploy log").unwrap();
    std::fs::write(
        temp.path().join("evals/evals.json"),
        serde_json::json!({
            "skill_name": "deploy-check",
            "evals": [
                {"id": 1, "prompt": "Check the deploy", "files": ["evals/files/input.md"],
                 "expectations": ["Mentions the outcome"], "assertions": [{"contains": "deploy"}]},
                {"id": 2, "prompt": "Missing input", "files": ["evals/files/absent.md"]},
                {"id": 3, "prompt": "Escaping input", "files": ["../secret"]}
            ]
        })
        .to_string(),
    )
    .unwrap();
    let (source, cases) = eval_cases(Some(temp.path()), None, None, &store, &key, 10, 8).unwrap();
    assert_eq!(source, CaseSource::SkillEvals);
    assert_eq!(cases.len(), 1);
    assert!(cases[0].prompt.contains("deploy log"));
    assert_eq!(
        cases[0].assertions,
        vec![HardAssertion::Contains("deploy".into())]
    );
}

/// A text-only usage of `key` that local replay can use.
fn replayable_usage(store: &EvolutionStore, key: &TargetKey, id: &str) {
    let evidence = store.put_evidence("Summarize the release.", 1, 90).unwrap();
    store
        .append_usage(&UsageRecord {
            version: EVOLUTION_RECORD_VERSION,
            usage_id: id.into(),
            thread_id: "t".into(),
            turn_id: None,
            attempt_id: None,
            tool_call_id: None,
            target_key: key.clone(),
            revision: TargetRevision::new("rev", 0),
            channel: kcoder_types::evolution::Channel::Stable,
            task: UsageTask {
                request_hash: Some(format!("req-{id}")),
                evidence_ref: Some(evidence),
                ..Default::default()
            },
            profile_hints: ProfileHints::default(),
            artifacts: Vec::new(),
            concurrent_targets: Vec::new(),
            started_at_ms: 1,
        })
        .unwrap();
}

fn catalog_json(skill: &str) -> Vec<u8> {
    serde_json::json!({
        "skill_name": skill,
        "evals": [
            {"id": 1, "prompt": "把三份季度报告合并成一个 PDF", "expected_output": "A merge plan",
             "expectations": ["Uses pypdf or qpdf"], "assertions": [{"contains": "pdf"}]},
            {"id": 2, "prompt": "Needs an input file", "files": ["evals/files/in.pdf"]}
        ]
    })
    .to_string()
    .into_bytes()
}

#[test]
fn catalog_cases_follow_skill_evals_and_precede_local_replay() {
    let skill_dir = tempfile::tempdir().unwrap();
    let store_dir = tempfile::tempdir().unwrap();
    let store = EvolutionStore::open(store_dir.path()).unwrap();
    let key = key("skill:bundled:pdf");
    replayable_usage(&store, &key, "u-1");
    let catalog = catalog_json("pdf");

    // Without a catalog the recorded task is replayed.
    let (source, _) = eval_cases(Some(skill_dir.path()), None, None, &store, &key, 10, 8).unwrap();
    assert_eq!(source, CaseSource::LocalReplay);

    // The catalog precedes local replay; its case with input files is
    // skipped because catalog cases are workspace-independent.
    let (source, cases) = eval_cases(
        Some(skill_dir.path()),
        None,
        Some(&catalog),
        &store,
        &key,
        10,
        8,
    )
    .unwrap();
    assert_eq!(source, CaseSource::BundledCatalog);
    assert_eq!(cases.len(), 1);
    assert_eq!(cases[0].id, "1");
    assert_eq!(
        cases[0].expectations,
        vec!["Uses pypdf or qpdf".to_string()]
    );
    assert_eq!(
        cases[0].assertions,
        vec![HardAssertion::Contains("pdf".into())]
    );

    // The skill's own evals.json still wins over the catalog.
    std::fs::create_dir_all(skill_dir.path().join("evals")).unwrap();
    std::fs::write(
        skill_dir.path().join("evals/evals.json"),
        serde_json::json!({"evals": [{"id": 7, "prompt": "Own case"}]}).to_string(),
    )
    .unwrap();
    let (source, cases) = eval_cases(
        Some(skill_dir.path()),
        None,
        Some(&catalog),
        &store,
        &key,
        10,
        8,
    )
    .unwrap();
    assert_eq!(source, CaseSource::SkillEvals);
    assert_eq!(cases[0].prompt, "Own case");
}

#[test]
fn bundled_catalog_applies_only_to_bundled_copies() {
    assert!(bundled_catalog(&key("skill:bundled:docx"), true).is_some());
    // A same-named user, Hub or plugin skill never gets KCoder's cases,
    // and neither does a bundled key whose effective copy is elsewhere.
    for other in [
        "skill:user_created:docx",
        "skill:agent_created:docx",
        "skill:hub_installed:docx",
        "skill:external_dir:docx",
    ] {
        assert!(bundled_catalog(&key(other), true).is_none(), "{other}");
    }
    assert!(bundled_catalog(&key("skill:bundled:docx"), false).is_none());
    assert!(bundled_catalog(&key("skill:bundled:deploy-check"), true).is_none());
    assert!(bundled_catalog(&key("tool_usage:builtin:docx"), true).is_none());
}

#[test]
fn malformed_catalog_entries_are_skipped_without_failing_evaluation() {
    let store_dir = tempfile::tempdir().unwrap();
    let store = EvolutionStore::open(store_dir.path()).unwrap();
    let key = key("skill:bundled:pdf");
    let malformed: [&[u8]; 5] = [
        b"{not json",
        br#"{"skill_name": "pdf", "evals": "not a list"}"#,
        br#"{"skill_name": "pdf", "evals": [{"id": 1}]}"#,
        br#"{"skill_name": "pdf", "evals": [{"id": 1, "prompt": "   "}]}"#,
        // A catalog file of another skill is not applied.
        br#"{"skill_name": "docx", "evals": [{"id": 1, "prompt": "Write a memo"}]}"#,
    ];
    for bytes in malformed {
        assert!(catalog_eval_cases("pdf", bytes, 8).is_empty());
        assert!(eval_cases(None, None, Some(bytes), &store, &key, 10, 8).is_none());
    }
    // Evaluation falls through to local replay.
    replayable_usage(&store, &key, "u-1");
    let (source, _) = eval_cases(None, None, Some(malformed[0]), &store, &key, 10, 8).unwrap();
    assert_eq!(source, CaseSource::LocalReplay);
}

#[test]
fn shipped_catalog_cases_parse() {
    let names: Vec<&str> = kcoder_skills::bundled_eval_catalog_names().collect();
    for expected in [
        "docx",
        "xlsx",
        "pptx",
        "pdf",
        "kcoder-settings",
        "lark-doc",
        "lark-sheets",
        "lark-im",
        "lark-calendar",
        "lark-base",
    ] {
        assert!(
            names.contains(&expected),
            "missing catalog entry {expected}"
        );
    }
    for name in names {
        let key = key(&format!("skill:bundled:{name}"));
        let bytes = bundled_catalog(&key, true).unwrap();
        let cases = catalog_eval_cases(name, bytes, 16);
        assert!(
            (4..=6).contains(&cases.len()),
            "{name}: {} cases",
            cases.len()
        );
        for case in &cases {
            assert!(!case.expectations.is_empty(), "{name}#{}", case.id);
            assert!(case.expected_output.is_some(), "{name}#{}", case.id);
        }
        // Every declared assertion is machine-checkable.
        let declared: usize = serde_json::from_slice::<serde_json::Value>(bytes).unwrap()["evals"]
            .as_array()
            .unwrap()
            .iter()
            .map(|case| case["assertions"].as_array().map_or(0, Vec::len))
            .sum();
        let parsed: usize = cases.iter().map(|case| case.assertions.len()).sum();
        assert_eq!(declared, parsed, "{name}: unparsed assertions");
    }
}

#[test]
fn hard_checks_count_only_candidate_regressions() {
    let content = OverlayContent {
        lessons: "- Never write `TODO` in the report.\n- Keep it short.".into(),
        checklist: "- [ ] 不要 使用 `lorem`".into(),
        ..Default::default()
    };
    let forbidden = forbidden_patterns(&content);
    assert_eq!(forbidden, vec!["TODO".to_string(), "lorem".to_string()]);
    let mut case = case("c");
    case.assertions = vec![
        HardAssertion::Contains("outcome".into()),
        HardAssertion::MaxChars(200),
    ];
    let stable = hard_checks("The outcome: ok. TODO later", &case, &forbidden, 0);
    let good = hard_checks("The outcome: ok.", &case, &forbidden, 27);
    let bad = hard_checks("Result ok. lorem", &case, &forbidden, 27);
    // The stable output already violates `TODO`; the candidate fixing it is
    // not a regression, while dropping "outcome" and adding "lorem" are.
    assert_eq!(regressions(&stable, &good), 0);
    assert_eq!(regressions(&stable, &bad), 2);
    let empty = hard_checks("", &case, &forbidden, 27);
    assert!(regressions(&stable, &empty) >= 2, "empty output and length");
}

#[test]
fn judge_order_swaps_and_disagreement_is_a_tie() {
    assert_eq!(combine_verdicts(Verdict::Win, Verdict::Win), Verdict::Win);
    assert_eq!(combine_verdicts(Verdict::Win, Verdict::Loss), Verdict::Tie);
    assert_eq!(combine_verdicts(Verdict::Loss, Verdict::Tie), Verdict::Tie);
    let reply = r#"{"winner": "A", "expectationsA": [true], "expectationsB": [false]}"#;
    // The same reply means a win when the candidate was A, a loss otherwise.
    let shown_first = parse_judgement(reply, true, 1).unwrap();
    assert_eq!(shown_first.verdict, Verdict::Win);
    assert_eq!(shown_first.candidate, vec![true]);
    let shown_second = parse_judgement(reply, false, 1).unwrap();
    assert_eq!(shown_second.verdict, Verdict::Loss);
    assert_eq!(shown_second.candidate, vec![false]);
    assert!(parse_judgement("not json", true, 1).is_none());
    // The first order is reproducible but not constant across cases.
    let orders: std::collections::BTreeSet<bool> = (0..16)
        .map(|index| candidate_first("prop-1", &format!("case-{index}")))
        .collect();
    assert_eq!(orders.len(), 2);
    assert_eq!(
        candidate_first("prop-1", "case-1"),
        candidate_first("prop-1", "case-1")
    );
    // Default pass criteria: ≥ 60% wins without ties, no regressions, at
    // most a 10% diversity drop.
    let defaults = kcoder_config::EvolutionEvalSettings::default();
    assert!(evaluation_result(3, 2, 5, 0, None, &defaults).passed);
    assert!(!evaluation_result(1, 1, 0, 0, None, &defaults).passed);
    assert!(
        !evaluation_result(0, 0, 4, 0, None, &defaults).passed,
        "only ties"
    );
    assert!(!evaluation_result(4, 0, 0, 1, None, &defaults).passed);
    assert!(!evaluation_result(4, 0, 0, 0, Some(-0.2), &defaults).passed);
    assert!(evaluation_result(4, 0, 0, 0, Some(-0.05), &defaults).passed);
    // `evolution.eval` changes both thresholds.
    let strict = kcoder_config::EvolutionEvalSettings {
        win_rate: 0.8,
        max_diversity_drop: 0.01,
    };
    assert!(!evaluation_result(3, 2, 5, 0, None, &strict).passed);
    assert!(!evaluation_result(4, 0, 0, 0, Some(-0.05), &strict).passed);
    assert!(evaluation_result(4, 1, 0, 0, Some(-0.005), &strict).passed);
}

#[tokio::test]
async fn pairwise_evaluation_passes_fails_and_ties_by_judgement() {
    let cases = vec![case("1"), case("2"), case("3")];
    let (result, _fixture) = evaluate(
        Arc::new(EvalProvider::new(Judge::PrefersCandidate)),
        &plan(cases.clone(), false, Some(false)),
        EvalLimits::default(),
    )
    .await;
    assert!(result.completed && result.passed, "{result:?}");
    assert_eq!((result.wins, result.losses, result.ties), (3, 0, 0));

    let (result, _fixture) = evaluate(
        Arc::new(EvalProvider::new(Judge::PrefersStable)),
        &plan(cases.clone(), false, Some(false)),
        EvalLimits::default(),
    )
    .await;
    assert!(result.completed && !result.passed);
    assert_eq!(result.losses, 3);

    // A judge that always picks the first position disagrees with itself
    // after the swap: every pair is a tie and nothing passes.
    let (result, _fixture) = evaluate(
        Arc::new(EvalProvider::new(Judge::PositionBiased)),
        &plan(cases, false, Some(false)),
        EvalLimits::default(),
    )
    .await;
    assert_eq!((result.wins, result.losses, result.ties), (0, 0, 3));
    assert!(!result.passed);
}

#[tokio::test]
async fn a_diversity_drop_fails_creative_targets() {
    let mut provider = EvalProvider::new(Judge::PrefersCandidate);
    provider.vary_stable_only = true;
    let (result, _fixture) = evaluate(
        Arc::new(provider),
        &plan(vec![case("1")], false, Some(true)),
        EvalLimits::default(),
    )
    .await;
    assert!(result.completed);
    assert_eq!(result.wins, 1);
    assert!(result.diversity_delta.unwrap() < -0.1, "{result:?}");
    assert!(!result.passed);
    assert!(result.reason.unwrap().contains("diversity"));
    assert!(diversity_delta(&["a b".into(), "a b".into()], &["x".into(), "x".into()]).abs() < 1e-9);
}

#[tokio::test]
async fn a_timed_out_evaluation_is_incomplete_never_passed() {
    let mut provider = EvalProvider::new(Judge::PrefersCandidate);
    provider.hang = true;
    let limits = EvalLimits {
        wall_time: Duration::from_millis(50),
        ..EvalLimits::default()
    };
    let (result, _fixture) = evaluate(
        Arc::new(provider),
        &plan(vec![case("1")], false, None),
        limits,
    )
    .await;
    assert!(!result.completed);
    assert!(!result.passed);
    assert!(result.reason.unwrap().contains("timed out"));
}

#[tokio::test]
async fn procedure_evaluation_never_executes_tools() {
    let mut provider = EvalProvider::new(Judge::PrefersCandidate);
    provider.tool_reply = true;
    let provider = Arc::new(provider);
    let (result, fixture) = evaluate(
        provider.clone(),
        &plan(vec![case("1")], true, None),
        EvalLimits::default(),
    )
    .await;
    // The tool call in the reply is not executed: nothing touched the
    // workspace, every request was tool-free and asked for a plan.
    assert!(!fixture.path("eval-side-effect").exists());
    let requests = provider.requests.lock().unwrap();
    assert!(!requests.is_empty());
    assert!(requests.iter().all(|request| request.tools.is_empty()));
    assert!(
        requests
            .iter()
            .filter(|request| !request
                .system
                .as_deref()
                .unwrap_or_default()
                .starts_with("You are a blind evaluator"))
            .all(|request| request.system.as_deref().unwrap().contains("Plan mode"))
    );
    assert!(result.diversity_delta.is_none(), "plans are not creative");
}
