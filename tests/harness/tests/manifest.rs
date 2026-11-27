use kcoder_test_harness::{
    MANIFEST_SCHEMA_VERSION, ModelPolicy, RunManifest, RunMetadata, RunStatus, TestTier,
};

#[test]
fn manifest_schema_v1_round_trips_running_and_terminal_states() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("manifest.json");
    let running = RunManifest::running(
        "run-1".to_string(),
        RunMetadata::new("suite", TestTier::Pr, ModelPolicy::Forbidden),
        10,
    );
    std::fs::write(&path, serde_json::to_vec(&running).unwrap()).unwrap();
    let decoded = RunManifest::read(&path).unwrap();
    assert_eq!(decoded.schema_version, MANIFEST_SCHEMA_VERSION);
    assert_eq!(decoded.status, RunStatus::Running);

    let mut terminal = decoded;
    terminal.status = RunStatus::UnmetPrerequisite;
    terminal.finished_at_ms = Some(20);
    terminal
        .unmet_prerequisites
        .push(kcoder_test_harness::PrerequisiteResult {
            name: "display".to_string(),
            met: false,
            detail: Some("not configured".to_string()),
        });
    std::fs::write(&path, serde_json::to_vec(&terminal).unwrap()).unwrap();
    assert_eq!(RunManifest::read(&path).unwrap(), terminal);
}

#[test]
fn manifest_rejects_unknown_schema_versions() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("manifest.json");
    std::fs::write(
        &path,
        br#"{"schema_version":2,"run_id":"x","metadata":{"suite":"s","tier":"unit","model_policy":"forbidden","platform":"test"},"status":"running","started_at_ms":1}"#,
    )
    .unwrap();
    assert!(RunManifest::read(&path).is_err());
}
