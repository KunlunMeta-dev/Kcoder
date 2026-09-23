use super::*;
use crate::test_support::engine_builder::{TestEngineBuilder, settings_using_main_summary_runtime};
use crate::test_support::providers::EmptyProvider;
use kcoder_config::Settings;
use std::path::Path;

fn test_engine_with_settings(
    provider: Arc<dyn Provider>,
    cwd: &Path,
    settings: Settings,
) -> QueryEngine {
    TestEngineBuilder::new(cwd)
        .provider(provider)
        .settings(settings)
        .build()
}

#[test]
fn summary_runtime_reuses_main_provider_and_model_without_override() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = settings_using_main_summary_runtime(Settings::default());
    let main_provider: Arc<dyn Provider> = Arc::new(EmptyProvider);
    let engine =
        test_engine_with_settings(Arc::clone(&main_provider), tmp.path(), settings.clone());

    let (configured_model, effective_model, max_tokens, summary_provider) =
        engine.summary_runtime().unwrap();

    assert_eq!(configured_model, None);
    assert_eq!(effective_model, settings.model);
    assert_eq!(max_tokens, settings.summary_max_tokens);
    assert!(Arc::ptr_eq(&main_provider, &summary_provider));
}

#[test]
fn summary_runtime_uses_complete_profile_and_caps_its_output() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    let mut profile = settings.providers["kunlunmeta"].clone();
    profile.default_model = "summary-model".to_string();
    profile.max_output_tokens = 4_000;
    settings.providers.insert("summary".to_string(), profile);
    settings
        .stored_provider_credentials
        .insert("summary".to_string(), "test-key".to_string());
    settings.summary_profile = Some("summary".to_string());
    settings.summary_max_tokens = 8_000;
    let main_provider: Arc<dyn Provider> = Arc::new(EmptyProvider);
    let engine = test_engine_with_settings(Arc::clone(&main_provider), tmp.path(), settings);

    let (configured_model, effective_model, max_tokens, summary_provider) =
        engine.summary_runtime().unwrap();

    assert_eq!(configured_model.as_deref(), Some("summary-model"));
    assert_eq!(effective_model, "summary-model");
    assert_eq!(max_tokens, 4_000);
    assert!(!Arc::ptr_eq(&main_provider, &summary_provider));
}

#[test]
fn summary_deployments_keep_the_host_credential_factory() {
    struct Source(std::sync::Mutex<Vec<Settings>>);
    impl crate::ClientModelConfiguration for Source {
        fn settings(&self, _: &str) -> Result<Settings> {
            anyhow::bail!("summary must retain its semantic snapshot")
        }
        fn provider(&self, settings: &Settings) -> Result<Arc<dyn Provider>> {
            self.0.lock().unwrap().push(settings.clone());
            Ok(Arc::new(EmptyProvider))
        }
    }
    let tmp = tempfile::tempdir().unwrap();
    for use_profile in [true, false] {
        let mut settings = Settings::default();
        let mut profile = settings.providers["kunlunmeta"].clone();
        profile.default_model = "summary-fixture".into();
        profile.models.clear();
        profile.extra_body = serde_json::from_value(serde_json::json!({"temperature":0.3})).unwrap();
        settings.providers.insert("summary".into(), profile);
        settings.summary_profile = use_profile.then(|| "summary".into());
        settings.summary_provider = (!use_profile).then(|| "summary".into());
        settings.summary_model = Some("summary-fixture".into());
        settings.provider_extra_body.insert("temperature".into(), serde_json::json!(0.9));
        let source = Arc::new(Source(std::sync::Mutex::new(Vec::new())));
        let engine = test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), settings)
            .with_client_model_configuration(source.clone());
        engine.summary_runtime().unwrap();
        let seen = source.0.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].active_provider.as_deref(), Some("summary"));
        assert_eq!(seen[0].model, "summary-fixture");
        assert_eq!(seen[0].provider_extra_body["temperature"], 0.3);
    }
}
