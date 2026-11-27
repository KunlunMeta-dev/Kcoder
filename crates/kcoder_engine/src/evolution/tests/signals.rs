use super::*;
use kcoder_evolution::{OverlaySlotSource, SignalWeights, score_usage};
use kcoder_types::evolution::{
    Attribution, OutcomeCategory, OutcomeCause, OutcomeObservation, OverlayContent, SignalKind,
};
use std::io::Write;

fn outcomes(store: &EvolutionStore) -> Vec<OutcomeObservation> {
    store.read_outcomes().unwrap().records
}

fn of(store: &EvolutionStore, signal: SignalKind) -> Vec<OutcomeObservation> {
    outcomes(store)
        .into_iter()
        .filter(|item| item.signal == signal)
        .collect()
}

fn docx(paragraphs: &[&str]) -> Vec<u8> {
    let body: String = paragraphs
        .iter()
        .map(|text| format!("<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"))
        .collect();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file(
        "word/document.xml",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(
        format!(
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>"#
        )
        .as_bytes(),
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

#[tokio::test]
async fn artifacts_written_in_a_turn_detect_external_edits_including_docx() {
    let fixture = fixture(EvolutionMode::Propose);
    let engine = &fixture.engine;
    let markdown = fixture.path("report.md");
    let document = fixture.path("report.docx");
    let guard = begin_turn(engine, "write the deployment report");
    activate(engine, SKILL).await;
    std::fs::write(&markdown, "# Report\nline one\nline two\nline three\n").unwrap();
    tool_call(
        engine,
        "write",
        serde_json::json!({"file_path": markdown.display().to_string(), "content": "..."}),
        "ok",
        false,
    );
    std::fs::write(&document, docx(&["Summary", "Body one", "Body two"])).unwrap();
    tool_call(
        engine,
        "write",
        serde_json::json!({"file_path": document.display().to_string(), "content": "..."}),
        "ok",
        false,
    );
    end_turn(engine, guard);

    let store = fixture.project_store();
    let usage = &store.read_amended_usages().unwrap().records[0];
    assert!(usage.profile_hints.wrote_files);
    assert_eq!(usage.artifacts.len(), 2, "both files have baselines");

    // The user edits both files between agent turns.
    std::fs::write(
        &markdown,
        "# Report\nline one\nedited by the user\nline three\nextra\n",
    )
    .unwrap();
    std::fs::write(
        &document,
        docx(&["Summary", "Body one changed", "Body two"]),
    )
    .unwrap();
    let guard = begin_turn(engine, "thanks");
    let edits = of(&store, SignalKind::ArtifactEdit);
    assert_eq!(edits.len(), 2, "edits are detected at the next turn start");
    for edit in &edits {
        let ratio = edit
            .metrics
            .edit_ratio
            .expect("text artifacts have an edit ratio");
        assert!(ratio > 0.0 && ratio < 1.0, "ratio {ratio}");
    }
    // An unchanged artifact is not reported twice; a deleted one is discarded.
    std::fs::remove_file(&markdown).unwrap();
    end_turn(engine, guard);
    let guard = begin_turn(engine, "next");
    assert_eq!(of(&store, SignalKind::ArtifactEdit).len(), 2);
    assert_eq!(of(&store, SignalKind::ArtifactDiscarded).len(), 1);
    end_turn(engine, guard);
}

#[tokio::test]
async fn environment_failures_are_excluded_and_target_failures_conflict() {
    let fixture = fixture(EvolutionMode::Propose);
    let engine = &fixture.engine;
    let guard = begin_turn(engine, "deploy");
    activate(engine, SKILL).await;
    tool_call(
        engine,
        "bash",
        serde_json::json!({"command": "curl https://example.invalid"}),
        "curl: (6) Could not resolve host: example.invalid",
        true,
    );
    end_turn(engine, guard);
    let store = fixture.project_store();
    let procedure: Vec<_> = outcomes(&store)
        .into_iter()
        .filter(|item| {
            matches!(
                item.signal,
                SignalKind::ToolResult | SignalKind::Verification
            )
        })
        .collect();
    assert_eq!(procedure.len(), 1);
    assert_eq!(procedure[0].cause, Some(OutcomeCause::Environment));
    assert!(!procedure[0].conflict);
    let score = score_usage(&procedure, &SignalWeights::DEFAULT);
    assert_eq!(score.score, None, "environment failures are not scored");

    // A failing step the skill itself prescribes is a conflict event; a
    // later retry that succeeds counts the retry.
    let guard = begin_turn(engine, "deploy again");
    activate(engine, OTHER_SKILL).await;
    activate(engine, SKILL).await;
    tool_call(
        engine,
        "bash",
        serde_json::json!({"command": "cargo test --workspace"}),
        "test failed: assertion",
        true,
    );
    end_turn(engine, guard);
    let latest: Vec<_> = outcomes(&store)
        .into_iter()
        .filter(|item| {
            matches!(
                item.signal,
                SignalKind::ToolResult | SignalKind::Verification
            )
        })
        .collect();
    let skill_usages: Vec<String> = store
        .read_usages()
        .unwrap()
        .records
        .into_iter()
        .filter(|usage| usage.target_key == skill_key())
        .map(|usage| usage.usage_id)
        .collect();
    let failing = latest
        .iter()
        .find(|item| {
            item.cause == Some(OutcomeCause::Target) && skill_usages.contains(&item.usage_id)
        })
        .unwrap();
    let other = latest
        .iter()
        .find(|item| {
            item.cause == Some(OutcomeCause::Target) && !skill_usages.contains(&item.usage_id)
        })
        .unwrap();
    assert!(
        !other.conflict,
        "the other skill did not prescribe the step"
    );
    assert_eq!(failing.metrics.success, Some(false));
    assert!(failing.conflict, "the failed command came from the skill");
    assert!(failing.evidence_ref.is_some());

    let guard = begin_turn(engine, "retry");
    activate(engine, SKILL).await;
    tool_call(
        engine,
        "bash",
        serde_json::json!({"command": "cargo test --workspace"}),
        "error",
        true,
    );
    tool_call(
        engine,
        "bash",
        serde_json::json!({"command": "cargo test --workspace"}),
        "ok",
        false,
    );
    end_turn(engine, guard);
    let last = outcomes(&store)
        .into_iter()
        .rev()
        .find(|item| item.signal == SignalKind::Verification)
        .unwrap();
    assert_eq!(last.metrics.success, Some(true));
    assert_eq!(last.metrics.retry_count, Some(1));
}

fn classifier_reply(items: serde_json::Value) -> String {
    serde_json::json!({ "items": items }).to_string()
}

#[tokio::test]
async fn next_messages_are_classified_in_one_batch_in_any_language() {
    let provider = ScriptedProvider::with_texts(&[&classifier_reply(serde_json::json!([
        {"id": "i0", "kind": "correction", "severity": 0.8, "confidence": 0.9,
         "categories": [{"category": "structure", "confidence": 0.9}]},
        {"id": "i1", "kind": "correction", "severity": 0.4, "confidence": 0.7,
         "categories": [{"category": "length", "confidence": 0.8}]}
    ]))]);
    let fixture = fixture_with(settings(EvolutionMode::Propose), provider.clone());
    let engine = &fixture.engine;
    let guard = begin_turn(engine, "写一份部署报告");
    activate(engine, SKILL).await;
    end_turn(engine, guard);
    let guard = begin_turn(engine, "不对，报告应该先写摘要，再写细节。");
    activate(engine, OTHER_SKILL).await;
    end_turn(engine, guard);
    let guard = begin_turn(
        engine,
        "No, that is far too long; keep it to three bullets.",
    );
    end_turn(engine, guard);
    assert_eq!(engine.evolution.lock_state().pending.len(), 2);

    engine.poll_idle_maintenance();
    wait_idle(engine).await;
    assert_eq!(provider.request_count(), 1, "one batched request");
    let request = serde_json::to_string(&provider.requests.lock().unwrap()[0].messages).unwrap();
    assert!(request.contains("先写摘要") && request.contains("three bullets"));
    let store = fixture.project_store();
    let corrections = of(&store, SignalKind::Correction);
    assert_eq!(corrections.len(), 2);
    let categories: Vec<_> = corrections
        .iter()
        .map(|item| item.categories[0].category)
        .collect();
    assert!(
        categories.contains(&OutcomeCategory::Structure)
            && categories.contains(&OutcomeCategory::Length)
    );
    assert!(corrections.iter().all(|item| item.evidence_ref.is_some()));
    // Classifier usage is accounted under the evolution request class.
    let month = fixture
        .store(ScopeKind::User)
        .read_state()
        .unwrap()
        .month_usage;
    assert_eq!((month.input_tokens, month.output_tokens), (120, 30));
}

#[tokio::test]
async fn concurrent_targets_are_ambiguous_and_rejected_overlay_lessons_conflict() {
    let provider = ScriptedProvider::with_texts(&[&classifier_reply(serde_json::json!([
        {"id": "i0", "kind": "correction", "severity": 0.9, "confidence": 0.9,
         "categories": [{"category": "style", "confidence": 0.9}], "contradictsLearnedNotes": true},
        {"id": "i1", "kind": "correction", "severity": 0.9, "confidence": 0.9,
         "categories": [{"category": "style", "confidence": 0.9}], "contradictsLearnedNotes": true}
    ]))]);
    let fixture = fixture_with(settings(EvolutionMode::Propose), provider);
    let store = fixture.project_store();
    let base = {
        let registry = fixture.engine.skill_registry.read().unwrap();
        kcoder_tools::evolution_service::skill_base_revision(registry.get(SKILL).unwrap())
    };
    store
        .write_stable_overlay(
            &skill_key(),
            None,
            &base,
            &OverlayContent {
                lessons: "- Use a formal tone.".into(),
                ..Default::default()
            },
            OverlaySlotSource::User,
            1,
        )
        .unwrap();
    let engine = &fixture.engine;
    let guard = begin_turn(engine, "prepare deployment and notes");
    activate(engine, SKILL).await;
    activate(engine, OTHER_SKILL).await;
    end_turn(engine, guard);
    let guard = begin_turn(engine, "Too formal, write casually.");
    end_turn(engine, guard);
    engine.poll_idle_maintenance();
    wait_idle(engine).await;
    let corrections = of(&store, SignalKind::Correction);
    assert_eq!(corrections.len(), 2);
    assert!(
        corrections
            .iter()
            .all(|item| item.attribution == Attribution::Ambiguous)
    );
    let usages = store.read_usages().unwrap().records;
    let skill_usage = usages
        .iter()
        .find(|usage| usage.target_key == skill_key())
        .unwrap();
    for item in corrections {
        assert_eq!(
            item.conflict,
            item.usage_id == skill_usage.usage_id,
            "only the served overlay conflicts"
        );
    }
}

#[tokio::test]
async fn invalid_classifier_output_is_discarded() {
    let provider =
        ScriptedProvider::with_texts(&["{\"items\": [{\"id\": \"i0\", \"kind\": \"angry\"}]}"]);
    let fixture = fixture_with(settings(EvolutionMode::Propose), provider);
    let engine = &fixture.engine;
    let guard = begin_turn(engine, "deploy");
    activate(engine, SKILL).await;
    end_turn(engine, guard);
    let guard = begin_turn(engine, "wrong");
    end_turn(engine, guard);
    engine.poll_idle_maintenance();
    wait_idle(engine).await;
    assert!(of(&fixture.project_store(), SignalKind::Correction).is_empty());
    assert!(
        engine
            .evolution_diagnostics()
            .iter()
            .any(|item| item.contains("classifier reply discarded"))
    );
}
