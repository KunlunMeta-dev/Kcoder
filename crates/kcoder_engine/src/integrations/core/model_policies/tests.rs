use super::*;
use crate::{
    integrations::core::resolve_integration_model_selection,
    test_support::{engine_builder::TestEngineBuilder, providers::EmptyProvider},
};
use kcoder_config::integrations::core::{ConfiguredModelPolicy, CoreIntegrationSettings};
use serde_json::json;
use std::sync::{Arc, RwLock};

fn deployment(model: &str, window: usize, vision: bool) -> kcoder_config::ProviderConfig {
    serde_json::from_value(json!({"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":"http://127.0.0.1:9/v1","default_model":model,
        "context_window_tokens":window,"max_output_tokens":64,"output_headroom_tokens":64,"discover_models":false,"no_proxy":true,
        "capabilities":{"text":true,"tools":true,"vision":vision,"reasoning":false,"structured_output":true}})).unwrap()
}
fn settings() -> Settings {
    let mut settings = Settings {
        providers: std::collections::BTreeMap::from([
            (
                "A-catalog-first".into(),
                deployment("text-model", 512, false),
            ),
            ("B-approved".into(), deployment("vision-model", 8192, true)),
            ("Current".into(), deployment("manual-current", 8192, true)),
        ]),
        ..Default::default()
    };
    settings
        .apply_discovered_model("Current", "manual-current")
        .unwrap();
    let policy:ConfiguredModelPolicy=serde_json::from_value(json!({"id":"business","title":"Approved pool","candidates":[
        {"provider":"B-approved","model":"vision-model"},{"provider":"A-catalog-first","model":"text-model"}
    ]})).unwrap();
    settings.integrations.core = CoreIntegrationSettings {
        model_policies: vec![policy],
        ..Default::default()
    };
    settings
}
fn engine(settings: Settings, root: &std::path::Path) -> QueryEngine {
    TestEngineBuilder::new(root)
        .provider(Arc::new(EmptyProvider))
        .settings(settings)
        .build_with_profile_directory()
}
fn request(
    settings: &Settings,
    requirements: IntegrationModelRequirements,
) -> IntegrationModelResolutionRequest {
    IntegrationModelResolutionRequest {
        selection: IntegrationModelSelectionIntent::AutoPolicy {
            id: "business".into(),
            version: settings.integrations.core.model_policies[0]
                .version()
                .unwrap(),
        },
        requirements,
    }
}

#[test]
fn explicit_pool_order_is_used_without_mutating_manual_current_or_claiming_budget() {
    let dir = tempfile::tempdir().unwrap();
    let settings = settings();
    let request = request(&settings, Default::default());
    let engine = engine(settings, dir.path());
    let before = engine.active_model_configuration_summary().unwrap();
    let provider = engine.current_raw_provider();
    let resolved = resolve_integration_model_selection(&engine, &request).unwrap();
    assert_eq!(
        resolved.selection_kind,
        IntegrationModelSelectionKind::AutoPolicy
    );
    assert_eq!(resolved.model.provider_id.as_deref(), Some("B-approved"));
    assert!(matches!(resolved.policy_ref, IntegrationNullable::Value(_)));
    assert_eq!(
        resolved.budget.reservation_state,
        IntegrationBudgetReservationState::NotReserved
    );
    assert!(!resolved.budget.cost_known);
    assert_eq!(engine.active_model_configuration_summary().unwrap(), before);
    // Health observation wrappers are request-local; the selected raw provider stays unchanged.
    assert!(Arc::ptr_eq(&engine.current_raw_provider(), &provider));
    let inherited = resolve_integration_model_selection(
        &engine,
        &IntegrationModelResolutionRequest {
            selection: IntegrationModelSelectionIntent::InheritCurrent,
            requirements: Default::default(),
        },
    )
    .unwrap();
    assert_eq!(inherited.model, before);
    let verifier = resolve_integration_model_selection(
        &engine,
        &IntegrationModelResolutionRequest {
            selection: IntegrationModelSelectionIntent::VerifierLocked {
                provider: "Current".into(),
                model: "manual-current".into(),
                configuration_revision: before.revision,
            },
            requirements: Default::default(),
        },
    )
    .unwrap();
    assert_eq!(verifier.model.provider_id.as_deref(), Some("Current"));
}

#[test]
fn native_data_boundary_excludes_unapproved_candidates_and_unknown_authority_stops_selection() {
    struct Boundary {
        unavailable: bool,
    }
    impl crate::integrations::core::NativeModelCandidateAuthorizer for Boundary {
        fn allows(
            &self,
            _: &QueryEngine,
            model: &kcoder_types::ModelConfigurationSummary,
        ) -> Result<bool> {
            if self.unavailable {
                anyhow::bail!("current-data-policy-unavailable")
            }
            Ok(model.provider_id.as_deref() == Some("A-catalog-first"))
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let settings = settings();
    let request = request(&settings, Default::default());
    let engine = engine(settings, directory.path());
    let selected = crate::integrations::core::resolve_integration_model_selection_with_authorizer(
        &engine,
        &request,
        Some(&Boundary { unavailable: false }),
    )
    .unwrap();
    assert_eq!(
        selected.model.provider_id.as_deref(),
        Some("A-catalog-first")
    );
    assert_eq!(
        engine
            .active_model_configuration_summary()
            .unwrap()
            .model_id,
        "manual-current"
    );
    let error = crate::integrations::core::resolve_integration_model_selection_with_authorizer(
        &engine,
        &request,
        Some(&Boundary { unavailable: true }),
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "current-data-policy-unavailable");
}

#[test]
fn vision_context_disabled_missing_credentials_and_revision_exclude_candidates_without_catalog_fallback()
 {
    for exclusion in [
        "vision",
        "context",
        "disabled",
        "credential",
        "revision",
        "unconfigured",
    ] {
        let mut settings = settings();
        let mut candidate = settings.integrations.core.model_policies[0].candidates[1].clone();
        match exclusion {
            "vision" => {}
            "context" => {}
            "disabled" => candidate.enabled = false,
            "credential" => {
                settings
                    .providers
                    .get_mut("A-catalog-first")
                    .unwrap()
                    .authentication = Default::default();
            }
            "revision" => candidate.configuration_revision = Some("stale-exact-revision".into()),
            _ => candidate.model = "not-configured".into(),
        }
        settings.integrations.core.model_policies[0].candidates = vec![candidate];
        let requirements = IntegrationModelRequirements {
            vision: exclusion == "vision",
            input_tokens: (exclusion == "context").then_some(500),
            ..Default::default()
        };
        let request = request(&settings, requirements);
        let dir = tempfile::tempdir().unwrap();
        let engine = engine(settings, dir.path());
        assert_eq!(
            resolve_integration_model_selection(&engine, &request)
                .unwrap_err()
                .to_string(),
            "MODEL_AUTO_NO_ELIGIBLE_CANDIDATE",
            "{exclusion}"
        );
        assert_eq!(
            engine
                .active_model_configuration_summary()
                .unwrap()
                .model_id,
            "manual-current"
        );
    }
}

#[test]
fn unavailable_first_candidate_uses_only_the_next_explicitly_approved_candidate() {
    let mut settings = settings();
    settings.integrations.core.model_policies[0]
        .candidates
        .reverse();
    let request = request(
        &settings,
        IntegrationModelRequirements {
            vision: true,
            input_tokens: Some(512),
            ..Default::default()
        },
    );
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(settings, dir.path());
    assert_eq!(
        resolve_integration_model_selection(&engine, &request)
            .unwrap()
            .model
            .provider_id
            .as_deref(),
        Some("B-approved")
    );
}

struct CurrentHost {
    settings: Arc<RwLock<Settings>>,
}
impl crate::ClientModelConfiguration for CurrentHost {
    fn settings(&self, selector: &str) -> Result<Settings> {
        let mut settings = self.settings.read().unwrap().clone();
        let (provider, model) = selector.split_once("::").context("qualified selector")?;
        settings.apply_discovered_model(provider, model)?;
        Ok(settings)
    }
    fn provider(&self, settings: &Settings) -> Result<Arc<dyn kcoder_api::Provider>> {
        let kind =
            kcoder_api::ProviderKind::from_settings(settings)?.context("configured transport")?;
        kcoder_api::ProviderFactory::new(settings).build(kind, &settings.model)
    }
    fn catalog_settings(&self) -> Result<Option<Settings>> {
        Ok(Some(self.settings.read().unwrap().clone()))
    }
}
#[test]
fn host_catalog_changes_invalidate_the_original_policy_version_even_when_resident_settings_are_old()
{
    let initial = settings();
    let original = request(&initial, Default::default());
    let source = Arc::new(RwLock::new(initial.clone()));
    let dir = tempfile::tempdir().unwrap();
    let engine =
        engine(initial, dir.path()).with_client_model_configuration(Arc::new(CurrentHost {
            settings: source.clone(),
        }));
    assert!(resolve_integration_model_selection(&engine, &original).is_ok());
    source.write().unwrap().integrations.core.model_policies[0]
        .candidates
        .reverse();
    assert_eq!(
        resolve_integration_model_selection(&engine, &original)
            .unwrap_err()
            .to_string(),
        "MODEL_AUTO_POLICY_VERSION_CHANGED"
    );
    let catalog = configured_integration_model_policies(&engine).unwrap();
    assert_ne!(
        catalog.policies[0].reference.version,
        match original.selection {
            IntegrationModelSelectionIntent::AutoPolicy { version, .. } => version,
            _ => unreachable!(),
        }
    );
}
