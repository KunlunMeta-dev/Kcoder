use super::*;
use crate::test_support::owned_case::{owned_case, owned_tempdir, run_owned_case};
use kcoder_state::turn_attempt_store::TurnAttemptStore;
use kcoder_types::TurnAttemptStatus;

#[test]
fn missing_output_limit_rejects_moa_before_any_provider_and_finishes_failed() {
    run_owned_case(
        concat!(module_path!(), "::owned_budget_admission_case"),
        "missing-output-limit",
    );
}

#[test]
fn zero_output_limit_rejects_moa_before_any_provider_and_finishes_failed() {
    run_owned_case(
        concat!(module_path!(), "::owned_budget_admission_case"),
        "zero-output-limit",
    );
}

struct MoaBudgetSource {
    main: Arc<dyn Provider>,
    reference: Arc<dyn Provider>,
}

impl crate::ClientModelConfiguration for MoaBudgetSource {
    fn settings(&self, _: &str) -> Result<Settings> {
        anyhow::bail!("MoA must retain its explicit session snapshot")
    }

    fn provider(&self, settings: &Settings) -> Result<Arc<dyn Provider>> {
        settings.model_execution_readiness()?;
        match settings.active_provider.as_deref() {
            Some("main-fixture") => Ok(self.main.clone()),
            Some("reference-fixture") => Ok(self.reference.clone()),
            _ => anyhow::bail!("unexpected MoA fixture profile"),
        }
    }
}

#[tokio::test]
#[ignore = "owned subprocess fixture executed by its parent"]
async fn owned_budget_admission_case() {
    let max_tokens = match owned_case().as_str() {
        "missing-output-limit" => None,
        "zero-output-limit" => Some(0),
        case => panic!("unexpected owned budget case: {case}"),
    };
    let root = owned_tempdir();
    let main_requests = Arc::new(Mutex::new(Vec::new()));
    let reference_requests = Arc::new(Mutex::new(Vec::new()));
    let main: Arc<dyn Provider> = Arc::new(RequestRecordingProvider {
        requests: main_requests.clone(),
    });
    let reference: Arc<dyn Provider> = Arc::new(RequestRecordingProvider {
        requests: reference_requests.clone(),
    });
    let profile: kcoder_config::ProviderConfig = serde_json::from_value(serde_json::json!({
        "api_format": "openai_chat_completions",
        "endpoint": "http://127.0.0.1:9/v1",
        "authentication": {"mode": "none"},
        "default_model": "main-model",
        "context_window_tokens": 131072,
        "output_headroom_tokens": 8192,
        "max_output_tokens": 2048,
        "discover_models": false,
        "no_proxy": true
    }))
    .unwrap();
    let mut reference_profile = profile.clone();
    reference_profile.default_model = "reference-model".into();
    let mut settings = Settings::default();
    settings.providers.insert("main-fixture".into(), profile);
    settings
        .providers
        .insert("reference-fixture".into(), reference_profile);
    // Both MoA slots stay executable; only the primary session's output limit is invalid.
    for profile in ["reference-fixture", "main-fixture"] {
        let mut selected = settings.clone();
        selected.apply_provider(Some(profile)).unwrap();
        selected.model_execution_readiness().unwrap();
    }
    settings.apply_provider(Some("main-fixture")).unwrap();
    settings.max_tokens = max_tokens;
    settings.moa.enabled = true;
    settings.moa.default_preset = "budget-admission".into();
    settings.moa.presets.clear();
    settings.moa.presets.insert(
        "budget-admission".into(),
        MoaPresetConfig {
            enabled: true,
            reference_models: vec![MoaModelConfig::new("reference-fixture", "reference-model")],
            aggregator: MoaModelConfig::new("main-fixture", "main-model"),
            reference_max_tokens: Some(128),
            aggregator_max_tokens: Some(128),
        },
    );
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .without_fixture_context_limits()
        .settings(settings)
        .provider(main.clone())
        .build_with_profile_directory()
        .with_client_model_configuration(Arc::new(MoaBudgetSource { main, reference }));
    assert_eq!(engine.settings.read().unwrap().max_tokens, max_tokens);
    let error = engine.try_context_budget().unwrap_err();
    assert_eq!(error.code(), "model_limits_missing");
    let history = root.path().join("owned-budget.jsonl");
    engine.state.with_history_path(&history);
    engine
        .state
        .add_message(Message::user_text("Original user task"));
    engine.state.flush_history().await.unwrap();
    engine.enable_moa_for_next_turn(Some("budget-admission".into()));

    let events = tokio::time::timeout(
        Duration::from_secs(10),
        engine
            .run_turn_stream(&kcoder_permissions::AutoDenyPrompt)
            .collect::<Vec<_>>(),
    )
    .await
    .expect("invalid model limits must finish the original stream");
    assert!(
        events.iter().any(
            |event| matches!(event, EngineEvent::Error(message) if message.contains(&error.to_string()))
        ),
        "{events:?}"
    );
    assert!(
        reference_requests.lock().unwrap().is_empty(),
        "MoA reference started before budget admission"
    );
    assert!(
        main_requests.lock().unwrap().is_empty(),
        "main or MoA aggregator started before budget admission"
    );
    assert!(
        engine
            .owned_turn_observer()
            .current_identity()
            .unwrap()
            .is_none()
    );

    let store = TurnAttemptStore::open_existing(
        &engine.session_storage_dir_for(&engine.session_id()),
        &engine.session_id(),
    )
    .unwrap()
    .expect("the original independent turn must own a durable attempt");
    let records = store.list_with_budget(1, 64 * 1024).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].identity.thread_id, engine.session_id());
    assert_eq!(records[0].status, TurnAttemptStatus::Failed);
    assert_eq!(
        records[0].completion.as_ref().unwrap().status,
        TurnAttemptStatus::Failed
    );
}
