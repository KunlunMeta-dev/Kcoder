//! Resolve native model identity without activating it or making a provider call.
use crate::QueryEngine;
use anyhow::{Result, ensure};
use kcoder_types::{ModelConfigurationBoundary, ModelConfigurationSummary, integrations::core::*};

pub fn resolve_integration_model_selection(
    engine: &QueryEngine,
    request: &IntegrationModelResolutionRequest,
) -> Result<IntegrationModelResolutionResult> {
    resolve_integration_model_selection_with_authorizer(engine, request, None)
}

/// Native metadata filtering only. An allowed candidate still needs actual execution admission.
pub trait NativeModelCandidateAuthorizer {
    fn allows(&self, engine: &QueryEngine, model: &ModelConfigurationSummary) -> Result<bool>;
}

pub fn resolve_integration_model_selection_with_authorizer(
    engine: &QueryEngine,
    request: &IntegrationModelResolutionRequest,
    authorizer: Option<&dyn NativeModelCandidateAuthorizer>,
) -> Result<IntegrationModelResolutionResult> {
    let (kind, model) = match &request.selection {
        IntegrationModelSelectionIntent::InheritCurrent => (
            IntegrationModelSelectionKind::InheritCurrent,
            engine.active_model_configuration_summary()?,
        ),
        IntegrationModelSelectionIntent::Explicit { provider, model } => (
            IntegrationModelSelectionKind::Explicit,
            explicit(engine, provider, model)?,
        ),
        IntegrationModelSelectionIntent::VerifierLocked {
            provider,
            model,
            configuration_revision,
        } => {
            let resolved = explicit(engine, provider, model)?;
            ensure!(
                resolved.revision == *configuration_revision,
                "MODEL_VERIFIER_CONFIGURATION_CHANGED"
            );
            (IntegrationModelSelectionKind::VerifierLocked, resolved)
        }
        IntegrationModelSelectionIntent::AutoPolicy { id, version } => {
            return super::model_policies::resolve_auto_policy(
                engine,
                id,
                version,
                &request.requirements,
                authorizer,
            );
        }
    };
    validate_requirements(&model, &request.requirements)?;
    ensure!(
        authorizer
            .map(|policy| policy.allows(engine, &model))
            .transpose()?
            .unwrap_or(true),
        "MODEL_DATA_POLICY_DENIED"
    );
    Ok(IntegrationModelResolutionResult {
        selection_kind: kind,
        model,
        policy_ref: IntegrationNullable::Null,
        budget: IntegrationModelBudget {
            reservation_state: IntegrationBudgetReservationState::NotReserved,
            cost_known: false,
        },
    })
}

fn explicit(
    engine: &QueryEngine,
    provider: &str,
    model: &str,
) -> Result<ModelConfigurationSummary> {
    ensure!(
        !provider.is_empty()
            && !model.is_empty()
            && !provider.contains("::")
            && provider.chars().count() <= 256
            && model.chars().count() <= 256,
        "MODEL_SELECTION_INVALID"
    );
    let (settings, _provider) = engine
        .resolve_client_model_configuration(&format!("{provider}::{model}"))
        .map_err(|_| anyhow::anyhow!("MODEL_SELECTION_UNAVAILABLE"))?;
    let summary =
        crate::model_configuration_summary(&settings, ModelConfigurationBoundary::NextTurn)?;
    ensure!(
        summary.provider_id.as_deref() == Some(provider) && summary.model_id == model,
        "MODEL_SELECTION_IDENTITY_CHANGED"
    );
    Ok(summary)
}

pub(super) fn validate_requirements(
    model: &ModelConfigurationSummary,
    requirements: &IntegrationModelRequirements,
) -> Result<()> {
    ensure!(
        !requirements.vision || model.vision,
        "MODEL_VISION_UNSUPPORTED"
    );
    ensure!(
        !requirements.tools || model.tools,
        "MODEL_TOOLS_UNSUPPORTED"
    );
    ensure!(
        !requirements.structured_output || model.structured_output,
        "MODEL_STRUCTURED_OUTPUT_UNSUPPORTED"
    );
    if let Some(output) = requirements.output_tokens {
        ensure!(output > 0, "MODEL_OUTPUT_LIMIT_INVALID");
        let limit = model
            .max_output_tokens
            .ok_or_else(|| anyhow::anyhow!("MODEL_OUTPUT_CAPACITY_UNKNOWN"))?;
        ensure!(output <= u64::from(limit), "MODEL_OUTPUT_CAPACITY_EXCEEDED");
    }
    if let Some(input) = requirements.input_tokens {
        let window = model
            .context_window_tokens
            .ok_or_else(|| anyhow::anyhow!("MODEL_CONTEXT_CAPACITY_UNKNOWN"))?;
        let reserve = requirements
            .output_tokens
            .unwrap_or_else(|| model.output_headroom_tokens.unwrap_or(0) as u64);
        let total = input
            .checked_add(reserve)
            .ok_or_else(|| anyhow::anyhow!("MODEL_CONTEXT_CAPACITY_EXCEEDED"))?;
        ensure!(total <= window as u64, "MODEL_CONTEXT_CAPACITY_EXCEEDED");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{engine_builder::TestEngineBuilder, providers::EmptyProvider};
    use kcoder_config::Settings;
    use std::sync::Arc;

    fn engine(settings: Settings, cwd: &std::path::Path) -> QueryEngine {
        TestEngineBuilder::new(cwd)
            .provider(Arc::new(EmptyProvider))
            .settings(settings)
            .build_with_profile_directory()
    }

    #[test]
    fn inherited_model_is_the_current_snapshot_and_auto_never_silently_inherits() {
        let temp = tempfile::tempdir().unwrap();
        let settings = Settings {
            model: "Current-CaseSensitive".into(),
            ..Default::default()
        };
        let engine = engine(settings, temp.path());
        let before = engine.active_model_configuration_summary().unwrap();
        let mut request = IntegrationModelResolutionRequest {
            selection: IntegrationModelSelectionIntent::InheritCurrent,
            requirements: Default::default(),
        };
        let resolved = resolve_integration_model_selection(&engine, &request).unwrap();
        assert_eq!(resolved.model, before);
        assert_eq!(
            resolved.budget.reservation_state,
            IntegrationBudgetReservationState::NotReserved
        );
        assert!(!resolved.budget.cost_known);
        request.selection = IntegrationModelSelectionIntent::AutoPolicy {
            id: "not-configured".into(),
            version: "1".into(),
        };
        assert_eq!(
            resolve_integration_model_selection(&engine, &request)
                .unwrap_err()
                .to_string(),
            "MODEL_AUTO_POLICY_UNAVAILABLE"
        );
        assert_eq!(engine.active_model_configuration_summary().unwrap(), before);
    }

    #[test]
    fn explicit_resolution_is_exact_and_never_activates_the_model() {
        let temp = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        let mut candidate = kcoder_config::default_active_provider_config();
        candidate.default_model = "Explicit-Exact".into();
        settings.providers.insert("CaseProvider".into(), candidate);
        settings
            .stored_provider_credentials
            .insert("CaseProvider".into(), "synthetic-test-credential".into());
        let engine = engine(settings, temp.path());
        let before = engine.active_model_configuration_summary().unwrap();
        let mut request = IntegrationModelResolutionRequest {
            selection: IntegrationModelSelectionIntent::Explicit {
                provider: "CaseProvider".into(),
                model: "Explicit-Exact".into(),
            },
            requirements: Default::default(),
        };
        let resolved = resolve_integration_model_selection(&engine, &request).unwrap();
        assert_eq!(resolved.model.provider_id.as_deref(), Some("CaseProvider"));
        assert_eq!(resolved.model.model_id, "Explicit-Exact");
        assert_eq!(engine.active_model_configuration_summary().unwrap(), before);
        request.selection = IntegrationModelSelectionIntent::Explicit {
            provider: "missing-provider".into(),
            model: "Explicit-Exact".into(),
        };
        assert!(resolve_integration_model_selection(&engine, &request).is_err());
        request.selection = IntegrationModelSelectionIntent::VerifierLocked {
            provider: "CaseProvider".into(),
            model: "Explicit-Exact".into(),
            configuration_revision: "stale-revision".into(),
        };
        assert_eq!(
            resolve_integration_model_selection(&engine, &request)
                .unwrap_err()
                .to_string(),
            "MODEL_VERIFIER_CONFIGURATION_CHANGED"
        );
        assert_eq!(engine.active_model_configuration_summary().unwrap(), before);
    }

    #[test]
    fn capability_and_context_checks_do_not_turn_unknown_into_capacity() {
        let settings = Settings {
            context_window_tokens: None,
            ..Default::default()
        };
        let model =
            crate::model_configuration_summary(&settings, ModelConfigurationBoundary::NextTurn)
                .unwrap();
        let req = IntegrationModelRequirements {
            input_tokens: Some(1),
            ..Default::default()
        };
        assert!(
            validate_requirements(&model, &req)
                .unwrap_err()
                .to_string()
                .contains("CAPACITY_UNKNOWN")
        );
    }

    #[test]
    fn output_reserve_and_overflow_are_checked_without_provider_execution() {
        let settings = Settings {
            context_window_tokens: Some(1000),
            max_tokens: Some(200),
            ..Default::default()
        };
        let model =
            crate::model_configuration_summary(&settings, ModelConfigurationBoundary::NextTurn)
                .unwrap();
        let mut req = IntegrationModelRequirements {
            input_tokens: Some(800),
            output_tokens: Some(200),
            ..Default::default()
        };
        validate_requirements(&model, &req).unwrap();
        req.input_tokens = Some(801);
        assert!(validate_requirements(&model, &req).is_err());
        req.input_tokens = Some(u64::MAX);
        assert!(validate_requirements(&model, &req).is_err());
    }
}
