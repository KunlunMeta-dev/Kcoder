use super::*;
use crate::test_support::{engine_builder::TestEngineBuilder, providers::EmptyProvider};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Source {
    current: Arc<RwLock<Settings>>,
    providers_built: Arc<AtomicUsize>,
    reject_selection: Arc<AtomicBool>,
}

impl ClientModelConfiguration for Source {
    fn settings(&self, selection: &str) -> Result<Settings> {
        anyhow::ensure!(
            !self.reject_selection.load(Ordering::SeqCst),
            "Selected model is unavailable"
        );
        let mut next = self.current.read().unwrap().clone();
        let (provider, model) = selection.split_once("::").unwrap();
        next.apply_discovered_model(provider, model)?;
        Ok(next)
    }

    fn default_settings(&self) -> Result<Option<Settings>> {
        Ok(Some(self.current.read().unwrap().clone()))
    }

    fn provider(&self, _: &Settings) -> Result<Arc<dyn Provider>> {
        self.providers_built.fetch_add(1, Ordering::SeqCst);
        Ok(Arc::new(EmptyProvider))
    }
}

fn settings() -> Settings {
    let mut settings = Settings::default();
    let mut provider = kcoder_config::default_active_provider_config();
    provider.default_model = "target-default".into();
    provider.models.clear();
    provider.discover_models = Some(true);
    settings.providers.insert("fixture".into(), provider);
    settings.apply_provider(Some("fixture")).unwrap();
    settings.tools.disabled = vec!["keep-original-tools".into()];
    settings
}

#[test]
fn restored_explicit_selection_preflight_matches_next_turn_without_writes_or_provider_builds() {
    let directory = tempfile::tempdir().unwrap();
    let initial = settings();
    let mut live = initial.clone();
    live.tools.disabled = vec!["must-not-replace-tools".into()];
    let built = Arc::new(AtomicUsize::new(0));
    let engine = TestEngineBuilder::new(directory.path())
        .settings(initial)
        .build_with_profile_directory()
        .with_client_model_configuration(Arc::new(Source {
            current: Arc::new(RwLock::new(live)),
            providers_built: built.clone(),
            reject_selection: Arc::new(AtomicBool::new(false)),
        }));
    engine
        .state
        .set_model_selection(
            ModelSelectionMode::Explicit,
            Some("fixture::persisted-model".into()),
        )
        .unwrap();
    let original = engine.active_model_configuration_summary().unwrap();
    let selected = engine.state.selected_model();
    let history_before = engine.state.history_path();
    let preflight = engine.next_turn_model_configuration_summary().unwrap();
    assert_eq!(preflight.model_id, "persisted-model");
    assert_ne!(preflight.revision, original.revision);
    assert_eq!(engine.state.selected_model(), selected);
    assert_eq!(engine.state.history_path(), history_before);
    assert_eq!(engine.model_name(), "target-default");
    assert_eq!(built.load(Ordering::SeqCst), 0);
    assert_eq!(
        engine
            .active_model_configuration_summary()
            .unwrap()
            .revision,
        original.revision
    );
    engine.prepare_client_model_for_turn(None, false).unwrap();
    let accepted = engine.active_model_configuration_summary().unwrap();
    assert_eq!(accepted.revision, preflight.revision);
    assert_eq!(accepted.model_id, preflight.model_id);
    assert_eq!(built.load(Ordering::SeqCst), 1);
    assert_eq!(
        engine.settings.read().unwrap().tools.disabled,
        vec!["keep-original-tools"]
    );
}

#[test]
fn follow_default_preflight_uses_current_default_without_changing_active_turn() {
    let directory = tempfile::tempdir().unwrap();
    let initial = settings();
    let live = Arc::new(RwLock::new(initial.clone()));
    let built = Arc::new(AtomicUsize::new(0));
    let engine = TestEngineBuilder::new(directory.path())
        .settings(initial)
        .build_with_profile_directory()
        .with_client_model_configuration(Arc::new(Source {
            current: live.clone(),
            providers_built: built.clone(),
            reject_selection: Arc::new(AtomicBool::new(false)),
        }));
    engine.follow_target_default_model().unwrap();
    let builds_before = built.load(Ordering::SeqCst);
    live.write()
        .unwrap()
        .apply_discovered_model("fixture", "new-target-default")
        .unwrap();
    let preflight = engine.next_turn_model_configuration_summary().unwrap();
    assert_eq!(preflight.model_id, "new-target-default");
    assert_eq!(engine.model_name(), "target-default");
    assert_eq!(built.load(Ordering::SeqCst), builds_before);
    assert!(engine.follows_target_default_model());
    engine.prepare_client_model_for_turn(None, false).unwrap();
    assert_eq!(
        engine
            .active_model_configuration_summary()
            .unwrap()
            .revision,
        preflight.revision
    );
    assert!(engine.follows_target_default_model());
}

#[test]
fn unavailable_persisted_model_fails_without_falling_back_to_target_default() {
    let directory = tempfile::tempdir().unwrap();
    let initial = settings();
    let built = Arc::new(AtomicUsize::new(0));
    let engine = TestEngineBuilder::new(directory.path())
        .settings(initial.clone())
        .build_with_profile_directory()
        .with_client_model_configuration(Arc::new(Source {
            current: Arc::new(RwLock::new(initial)),
            providers_built: built.clone(),
            reject_selection: Arc::new(AtomicBool::new(true)),
        }));
    engine
        .state
        .set_model_selection(
            ModelSelectionMode::Explicit,
            Some("fixture::removed-model".into()),
        )
        .unwrap();
    assert!(engine.next_turn_model_configuration_summary().is_err());
    assert_eq!(engine.model_name(), "target-default");
    assert_eq!(
        engine.state.selected_model().as_deref(),
        Some("fixture::removed-model")
    );
    assert_eq!(built.load(Ordering::SeqCst), 0);
}

#[test]
fn unleased_preview_can_resolve_model_without_creating_history_or_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let initial = settings();
    let engine = TestEngineBuilder::new(directory.path())
        .settings(initial.clone())
        .build_with_profile_directory()
        .with_client_model_configuration(Arc::new(Source {
            current: Arc::new(RwLock::new(initial)),
            providers_built: Arc::new(AtomicUsize::new(0)),
            reject_selection: Arc::new(AtomicBool::new(false)),
        }));
    engine
        .state
        .set_model_selection(
            ModelSelectionMode::Explicit,
            Some("fixture::persisted-model".into()),
        )
        .unwrap();
    let path = directory.path().join("preview.jsonl");
    engine.state.with_deferred_history_path(path.clone());
    let metadata = engine.state.session_state_path().unwrap();
    assert_eq!(
        engine
            .next_turn_model_configuration_summary()
            .unwrap()
            .model_id,
        "persisted-model"
    );
    assert!(!path.exists());
    assert!(!metadata.exists());
    assert_eq!(engine.model_name(), "target-default");
}
