use super::*;

fn remove_legacy_limits(fixture: &Fixture, run: &str) -> Vec<u8> {
    let path = workflow_run_dir(&fixture.context, run).join("state.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    state.as_object_mut().unwrap().remove("timeout_seconds");
    state.as_object_mut().unwrap().remove("max_agent_turns");
    let bytes = serde_json::to_vec(&state).unwrap();
    atomic_write_file(&path, &bytes).unwrap();
    bytes
}

fn assert_settings_required(fixture: &Fixture, run: &str) {
    let task = fixture.context.state.task(run).unwrap();
    assert_eq!(task.status, TaskStatus::Failed);
    assert!(
        task.output
            .as_deref()
            .unwrap()
            .contains("workflow_recovery_settings_required")
    );
    assert_eq!(fixture.observation(run).status, "failed");
    assert_eq!(fixture.runner.calls("fixture_effect"), 1);
}

#[tokio::test]
async fn old_custom_limits_omitted_resume_blocks_replay_then_original_limits_reuse_the_effect() {
    let fixture = Fixture::new();
    let saved = fixture.save(effect_then_tail());
    fixture
        .runner
        .failures
        .lock()
        .unwrap()
        .insert("fixture_tail".into(), 1);
    let started = fixture
        .run(
            json!({"definition_id":saved.id,"version":1,"timeout_seconds":60,"max_agent_turns":10}),
        )
        .await;
    let run = started["run_id"].as_str().unwrap();
    remove_legacy_limits(&fixture, run);
    fixture.run(json!({"resume":run})).await;
    assert_settings_required(&fixture, run);
    fixture
        .run(json!({"resume":run,"timeout_seconds":60,"max_agent_turns":10}))
        .await;
    fixture.assert_completed(run, &saved);
    assert_eq!(fixture.runner.calls("fixture_effect"), 1);
    assert_eq!(fixture.runner.calls("fixture_tail"), 2);
}

#[tokio::test]
async fn old_custom_limits_reuse_and_its_resume_cannot_lose_the_unresolved_source() {
    let fixture = Fixture::new();
    let saved = fixture.save(effect_then_tail());
    let source = fixture
        .run(
            json!({"definition_id":saved.id,"version":1,"timeout_seconds":60,"max_agent_turns":10}),
        )
        .await;
    let source = source["run_id"].as_str().unwrap();
    let old = remove_legacy_limits(&fixture, source);
    let started = fixture
        .run(json!({"definition_id":saved.id,"version":1,"reuse_from_run":source}))
        .await;
    let run = started["run_id"].as_str().unwrap();
    assert_settings_required(&fixture, run);
    assert_eq!(
        fs::read(workflow_run_dir(&fixture.context, source).join("state.json")).unwrap(),
        old
    );
    fixture.run(json!({"resume":run})).await;
    assert_settings_required(&fixture, run);
    fixture
        .run(json!({"resume":run,"timeout_seconds":60,"max_agent_turns":10}))
        .await;
    fixture.assert_completed(run, &saved);
    assert_eq!(fixture.runner.calls("fixture_effect"), 1);
    assert_eq!(fixture.runner.calls("fixture_tail"), 1);
    let direct = fixture.run(json!({"definition_id":saved.id,"version":1,"reuse_from_run":source,"timeout_seconds":60,"max_agent_turns":10})).await;
    fixture.assert_completed(direct["run_id"].as_str().unwrap(), &saved);
    assert_eq!(fixture.runner.calls("fixture_effect"), 1);
}

#[tokio::test]
async fn old_default_limits_can_prove_reuse_from_the_exact_checkpoints() {
    let fixture = Fixture::new();
    let saved = fixture.save(effect_then_tail());
    let source = fixture
        .run(json!({"definition_id":saved.id,"version":1}))
        .await;
    let source = source["run_id"].as_str().unwrap();
    remove_legacy_limits(&fixture, source);
    let started = fixture
        .run(json!({"definition_id":saved.id,"version":1,"reuse_from_run":source}))
        .await;
    fixture.assert_completed(started["run_id"].as_str().unwrap(), &saved);
    assert_eq!(fixture.runner.calls("fixture_effect"), 1);
}
